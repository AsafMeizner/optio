import { and, eq, exists, isNull } from "drizzle-orm";
import { setTimeout as delay } from "node:timers/promises";
import { db } from "../db/client.js";
import { sessionToolApprovals, sessionChatTurns } from "../db/schema.js";
import { broadcastSessionChat } from "./session-turn-service.js";
import { WorkSpecSchema } from "../schemas/work.js";

export class SessionApprovalError extends Error {}

/** Same durable conversation and bus for the page and the assistant panel. */
export async function sessionFrame(sessionId: string, frame: Record<string, unknown>) {
  const { appendSessionChatEvent } = await import("./interactive-session-service.js");
  await appendSessionChatEvent({
    sessionId,
    stream: "stdout",
    logType:
      frame.type === "text" ? "text" : frame.type === "user_message" ? "user_message" : "info",
    content: String(frame.content ?? frame.description ?? frame.summary ?? frame.message ?? ""),
    metadata: { frame },
  });
  broadcastSessionChat(sessionId, frame);
}

export function approvalFrame(row: { id: string; tool: string; args: Record<string, unknown> }) {
  if (row.tool === "send_session_message")
    return {
      type: "action_proposal",
      actionId: row.id,
      description: "Send this message to the session",
      work: [],
      items: [`Session: ${String(row.args.id)}`, String(row.args.body)],
    };
  const spec = row.tool === "create_work" ? WorkSpecSchema.safeParse(row.args.spec) : null;
  return {
    type: "action_proposal",
    actionId: row.id,
    description: spec?.success ? "Ready to create this work" : `Review ${row.tool}`,
    work: spec?.success ? [spec.data] : [],
    items: spec?.success ? [] : [`${row.tool}(${JSON.stringify(row.args)})`],
  };
}

export async function requestSessionApproval(
  sessionId: string,
  turnId: string,
  tool: string,
  args: Record<string, unknown>,
) {
  const [row] = await db
    .insert(sessionToolApprovals)
    .values({ sessionId, turnId, tool, args })
    .returning();
  await sessionFrame(sessionId, approvalFrame(row));
  broadcastSessionChat(sessionId, { type: "status", status: "waiting_for_approval" });
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    const [turn] = await db.select().from(sessionChatTurns).where(eq(sessionChatTurns.id, turnId));
    if (!turn || turn.state !== "running" || turn.finishedAt) break;
    const [decision] = await db
      .select()
      .from(sessionToolApprovals)
      .where(eq(sessionToolApprovals.id, row.id));
    if (decision.state === "denied")
      throw new SessionApprovalError(decision.feedback || "The user declined this action.");
    if (decision.state === "approved") {
      const [claimed] = await db
        .update(sessionToolApprovals)
        .set({ state: "executing" })
        .where(and(eq(sessionToolApprovals.id, row.id), eq(sessionToolApprovals.state, "approved")))
        .returning();
      if (!claimed) break;
      broadcastSessionChat(sessionId, { type: "status", status: "executing" });
      return row.id;
    }
    if (decision.state !== "pending") break;
    await delay(250);
  }
  await expireSessionApprovals(turnId);
  throw new SessionApprovalError(
    "Approval expired. Check the work state before requesting it again.",
  );
}

/** Session authorization is checked by the socket before reaching this CAS. */
export async function decideSessionApproval(
  sessionId: string,
  id: string,
  approved: boolean,
  feedback?: string,
) {
  const [row] = await db
    .update(sessionToolApprovals)
    .set({ state: approved ? "approved" : "denied", feedback: feedback?.slice(0, 4000) ?? null })
    .where(
      and(
        eq(sessionToolApprovals.id, id),
        eq(sessionToolApprovals.sessionId, sessionId),
        eq(sessionToolApprovals.state, "pending"),
        exists(
          db
            .select({ id: sessionChatTurns.id })
            .from(sessionChatTurns)
            .where(
              and(
                eq(sessionChatTurns.id, sessionToolApprovals.turnId),
                eq(sessionChatTurns.state, "running"),
                isNull(sessionChatTurns.finishedAt),
              ),
            ),
        ),
      ),
    )
    .returning();
  if (row) broadcastSessionChat(sessionId, { type: "action_decision", actionId: row.id, approved });
  return !!row;
}

/** Reconnecting clients must not be left with an approval for a finished turn. */
export async function expireSessionApprovals(turnId: string) {
  const rows = await db
    .update(sessionToolApprovals)
    .set({ state: "expired" })
    .where(and(eq(sessionToolApprovals.turnId, turnId), eq(sessionToolApprovals.state, "pending")))
    .returning();
  for (const row of rows)
    broadcastSessionChat(row.sessionId, { type: "action_expired", actionId: row.id });
}
