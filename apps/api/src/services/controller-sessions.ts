import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { interactiveSessions, localTerminals } from "../db/schema.js";
import type { ControllerPrincipal } from "./controller-auth.js";
import { ControllerError, requireManage, tenant } from "./controller-access.js";
import { listSessionChatEvents } from "./interactive-session-service.js";
import { getTranscriptBefore } from "./local-terminal-service.js";
import { enqueueSessionMessage } from "./session-turn-service.js";
import { sendLocalTerminalInput } from "./local-terminal-input.js";
import { createLegacySessionChat } from "./legacy-session-chat-service.js";
import { logger } from "../logger.js";

/** Session operators get their own conversations, never another owner's (including admins). */
async function resolveSession(p: ControllerPrincipal, id: string) {
  if (!p.run?.sessionId)
    throw new ControllerError(403, "Session tools require an interactive operator");
  const [pod] = await db
    .select()
    .from(interactiveSessions)
    .where(
      and(
        eq(interactiveSessions.id, id),
        tenant(interactiveSessions.workspaceId, p.actor.workspaceId),
        tenant(interactiveSessions.userId, p.actor.userId),
      ),
    );
  if (pod) return { kind: "pod" as const, row: pod };
  const [local] = await db
    .select()
    .from(localTerminals)
    .where(
      and(
        eq(localTerminals.id, id),
        tenant(localTerminals.workspaceId, p.actor.workspaceId),
        tenant(localTerminals.userId, p.actor.userId),
      ),
    );
  if (local) return { kind: "local" as const, row: local };
  throw new ControllerError(404, "Session not found");
}

export async function controllerSessionHistory(
  p: ControllerPrincipal,
  id: string,
  limit: number,
  beforeSeq?: number,
) {
  const target = await resolveSession(p, id);
  const cap = Math.max(1, Math.min(limit, 100));
  if (target.kind === "local") {
    const page = await getTranscriptBefore(id, beforeSeq ?? 2147483647, cap);
    return {
      id,
      href: `/work/${id}`,
      hasEarlier: page.hasEarlier,
      nextBeforeSeq: page.hasEarlier ? (page.entries[0]?.seq ?? null) : null,
      entries: page.entries.map((e) => ({
        seq: e.seq,
        role: e.role,
        type: e.kind,
        text: e.text.slice(0, 2000),
        truncated: e.text.length > 2000,
        at: e.at,
      })),
    };
  }
  const entries = await listSessionChatEvents(id, { limit: cap + 1, beforeSeq });
  return {
    id,
    href: `/work/${id}`,
    hasEarlier: entries.length > cap,
    nextBeforeSeq: entries.length > cap ? (entries.slice(-cap)[0]?.seq ?? null) : null,
    entries: entries.slice(-cap).map((e) => ({
      seq: e.seq,
      type: e.logType,
      text: e.content.slice(0, 2000),
      truncated: e.content.length > 2000,
      at: e.timestamp,
    })),
  };
}

/** Use precisely the chat UI's transports: durable harness queue, legacy chat runner, or Local stdin. */
export async function sendControllerSessionMessage(
  p: ControllerPrincipal,
  id: string,
  body: string,
  requestId: string = randomUUID(),
) {
  requireManage(p);
  const target = await resolveSession(p, id);
  if (id === p.run?.sessionId) throw new ControllerError(409, "Cannot message your own session");
  if (!body.trim() || body.length > 20000 || /[\x00-\x08\x0b-\x1f\x7f]/.test(body))
    throw new ControllerError(
      400,
      "Message must be plain text (1–20000 characters), without terminal control keys",
    );
  if (target.kind === "local") {
    if (target.row.spec.kind !== "agent")
      throw new ControllerError(409, "This is a terminal, not an agent conversation");
    const failure = await sendLocalTerminalInput(target.row, body + "\r");
    if (failure) throw new ControllerError(409, failure.error);
    return {
      id,
      delivery: "sent",
      href: `/work/${id}`,
      note: "Sent through the session chat input. Inspect history for a reply; do not resend after an uncertain delivery.",
    };
  }
  if (target.row.state !== "active") throw new ControllerError(409, "Session is not active");
  if (target.row.agentRuntime) {
    try {
      await enqueueSessionMessage(id, requestId, body);
    } catch (err) {
      if (
        err instanceof Error &&
        /Session is not active|Request ID|queue is full/.test(err.message)
      )
        throw new ControllerError(409, err.message);
      throw err;
    }
    return { id, requestId, delivery: "queued", href: `/work/${id}` };
  }
  // Older pod sessions have a Claude chat alongside their terminal. Preserve
  // that conversation's native resume id rather than replacing it with a new harness session.
  return new Promise<{ id: string; requestId: string; delivery: string; href: string }>(
    (resolve, reject) => {
      void (async () => {
        const runner = await createLegacySessionChat(target.row, (frame) => {
          if (frame.type === "error") reject(new ControllerError(409, String(frame.message)));
        });
        await runner.runPrompt(body, requestId, () =>
          resolve({
            id,
            requestId,
            delivery: "started",
            href: `/work/${id}`,
          }),
        );
      })().catch((err) => {
        logger.warn(
          { sessionId: id, errorType: err instanceof Error ? err.name : "unknown" },
          "Controller session input failed",
        );
        reject(
          new ControllerError(
            409,
            "Unable to start session chat. Check the session state before retrying.",
          ),
        );
      });
    },
  );
}

/** Lifecycle controls share the same session owner checks as chat input. */
export async function controlControllerSession(
  p: ControllerPrincipal,
  id: string,
  action: "interrupt" | "end" | "cancel_queued",
  requestId?: string,
) {
  requireManage(p);
  const target = await resolveSession(p, id);
  if (id === p.run?.sessionId) throw new ControllerError(409, "Cannot control your own session");
  if (target.kind === "local") {
    if (action === "cancel_queued")
      throw new ControllerError(400, "Local sessions do not have a pod message queue");
    if (action === "end") {
      if (!["running", "launching", "pending"].includes(target.row.state))
        throw new ControllerError(409, "Session is not active");
      const { killTerminal } = await import("./local-terminal-service.js");
      await killTerminal(target.row);
    } else {
      const failure = await sendLocalTerminalInput(target.row, "\x03");
      if (failure) throw new ControllerError(409, failure.error);
    }
  } else {
    if (target.row.state !== "active") throw new ControllerError(409, "Session is not active");
    if (action === "end") {
      const { endSession } = await import("./interactive-session-service.js");
      await endSession(id);
    } else if (action === "interrupt") {
      const { interruptSessionChat } = await import("./session-turn-service.js");
      await interruptSessionChat(id);
    } else {
      if (!requestId) throw new ControllerError(400, "cancel_queued requires requestId");
      const { cancelQueuedSessionMessage } = await import("./session-turn-service.js");
      if (!(await cancelQueuedSessionMessage(id, requestId)))
        throw new ControllerError(409, "Message is no longer queued");
    }
  }
  return { id, action, accepted: true };
}
