import { getProviderCatalog, providerForAgentType } from "@optio/shared";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { WsConnection } from "./ws-connection.js";
import { db } from "../db/client.js";
import { sessionChatEvents, sessionToolApprovals } from "../db/schema.js";
import { getSession, listSessionChatEvents } from "../services/interactive-session-service.js";
import {
  broadcastSessionChat,
  latestSessionTurn,
  subscribeSessionChat,
  interruptSessionChat,
} from "../services/session-turn-service.js";
import { runHarnessSession } from "../services/session-harness-service.js";
import { approvalFrame, decideSessionApproval } from "../services/session-tool-approval.js";
import { isMessageWithinSizeLimit } from "./ws-limits.js";

/** Two presentations of the same saved interactive session. */
export async function attachHarnessChat(
  socket: { readyState: number; send(data: string): unknown },
  conn: WsConnection,
  sessionId: string,
  mayInput: () => Promise<boolean>,
  panel = false,
) {
  const send = (frame: Record<string, unknown>) => {
    if (conn.closed || socket.readyState !== 1) return;
    if (!panel && ["text", "error"].includes(String(frame.type))) {
      socket.send(
        JSON.stringify({
          type: "chat_event",
          event: {
            taskId: sessionId,
            timestamp: new Date().toISOString(),
            type: frame.type === "user_message" ? "user_message" : frame.type,
            content: frame.content ?? frame.message,
          },
        }),
      );
    } else socket.send(JSON.stringify(frame));
  };
  const history = await listSessionChatEvents(sessionId, { limit: 1000 });
  if (panel) {
    send({
      type: "history",
      sessionId,
      href: `/work/${sessionId}`,
      frames: history.flatMap((e) => {
        const frame = e.metadata?.frame as Record<string, unknown> | undefined;
        return frame &&
          ["text", "user_message", "error", "action_result"].includes(String(frame.type))
          ? [frame]
          : [];
      }),
    });
  } else {
    for (const e of history)
      send({
        type: "chat_event",
        catchUp: true,
        event: {
          taskId: sessionId,
          timestamp: e.timestamp,
          type: e.logType,
          content: e.content,
          metadata: e.metadata,
        },
      });
    send({ type: "history_done", count: history.length });
  }
  conn.onClose(subscribeSessionChat(sessionId, send));
  const pending = await db
    .select()
    .from(sessionToolApprovals)
    .where(
      and(eq(sessionToolApprovals.sessionId, sessionId), eq(sessionToolApprovals.state, "pending")),
    );
  for (const row of pending) send(approvalFrame(row));
  const latest = await latestSessionTurn(sessionId);
  const session = await getSession(sessionId);
  send({
    type: "status",
    status: pending.length
      ? "waiting_for_approval"
      : latest?.state === "running"
        ? "thinking"
        : "ready",
    sessionId,
    runtime: session?.agentRuntime,
    model: session?.agentRuntime
      ? String(
          session.agentOptions?.[
            getProviderCatalog(providerForAgentType(session.agentRuntime))!.modelField
          ] ?? "",
        )
      : undefined,
  });
  let accepting = false;
  conn.ready((data) => {
    void (async () => {
      if (!isMessageWithinSizeLimit(data) || !(await mayInput())) return;
      const session = await getSession(sessionId);
      if (!session || session.state !== "active") throw new Error("Session has ended");
      const msg = JSON.parse(String(data));
      if (msg.type === "message") {
        if (typeof msg.content !== "string" || !msg.content.trim())
          throw new Error("Empty message");
        if (accepting) throw new Error("Already processing a request");
        const requestId =
          msg.requestId === undefined ? randomUUID() : z.string().uuid().parse(msg.requestId);
        accepting = true;
        try {
          await runHarnessSession(sessionId, msg.content.trim(), requestId);
        } finally {
          accepting = false;
        }
      } else if (msg.type === "approve" || msg.type === "deny") {
        if (
          !z.string().uuid().safeParse(msg.actionId).success ||
          !(await decideSessionApproval(
            sessionId,
            msg.actionId,
            msg.type === "approve",
            msg.feedback,
          ))
        )
          throw new Error("No pending action to decide");
      } else if (msg.type === "interrupt") {
        if (!panel) {
          await interruptSessionChat(sessionId);
          return;
        }
        if ((await latestSessionTurn(sessionId))?.state === "running")
          throw new Error(
            "Wait for the current request to finish before clearing the conversation",
          );
        await db.delete(sessionChatEvents).where(eq(sessionChatEvents.sessionId, sessionId));
        broadcastSessionChat(sessionId, {
          type: "history",
          sessionId,
          href: `/work/${sessionId}`,
          frames: [],
        });
        send({ type: "status", status: "ready" });
      }
    })().catch((err) =>
      send({
        type: "error",
        message: err instanceof Error ? err.message : "Unable to process message",
      }),
    );
  });
}
