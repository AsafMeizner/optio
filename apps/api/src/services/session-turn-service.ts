import { createHash } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { interactiveSessions, sessionChatTurns } from "../db/schema.js";
import { INSTANCE_ID } from "./instance.js";
import { logger } from "../logger.js";
import { onSessionBus, publishSessionBus } from "./session-bus.js";

export async function claimSessionTurn(sessionId: string, requestId: string, prompt: string) {
  const promptHash = createHash("sha256").update(prompt).digest("hex");
  const [turn] = await db
    .insert(sessionChatTurns)
    .values({ sessionId, requestId, promptHash, state: "running" })
    .onConflictDoNothing()
    .returning();
  if (turn) return { accepted: true as const, turn };
  const [existing] = await db
    .select()
    .from(sessionChatTurns)
    .where(
      and(eq(sessionChatTurns.sessionId, sessionId), eq(sessionChatTurns.requestId, requestId)),
    );
  return {
    accepted: false as const,
    reason: existing
      ? existing.promptHash !== promptHash
        ? "Request ID already belongs to a different prompt"
        : `This prompt was already accepted (${existing.state}); it will not be replayed`
      : "Another turn is running in this session",
  };
}

export async function finishSessionTurn(id: string, completed: boolean) {
  await db
    .update(sessionChatTurns)
    .set({ state: completed ? "completed" : "interrupted", finishedAt: new Date() })
    .where(and(eq(sessionChatTurns.id, id), eq(sessionChatTurns.state, "running")));
}

/**
 * Boot: a `running` receipt with no instance to finish it. Chat turns still
 * run on the instance that received the prompt (the run protocol covers
 * them in a later phase), so a turn that was running when every instance
 * went away is recorded as interrupted and never requeued. With several
 * instances this runs on every boot and is harmless: a turn still running
 * elsewhere sees its row interrupted on its next control poll
 * (`turnShouldStop`) and stops its exec, so nothing runs unobserved, and
 * `finishSessionTurn` only ever settles a `running` row.
 */
export async function recoverSessionTurns() {
  await db
    .update(sessionChatTurns)
    .set({ state: "interrupted", finishedAt: new Date() })
    .where(eq(sessionChatTurns.state, "running"));
}

export async function latestSessionTurn(sessionId: string) {
  const [turn] = await db
    .select()
    .from(sessionChatTurns)
    .where(eq(sessionChatTurns.sessionId, sessionId))
    .orderBy(desc(sessionChatTurns.startedAt))
    .limit(1);
  return turn ?? null;
}

// ── Live frames: this instance's sockets, every instance's turns ────────────

type Listener = (frame: Record<string, unknown>) => void;
/** sessionId → the sockets on this instance showing the session. */
const listeners = new Map<string, Set<Listener>>();
/** sessionId → how to stop the turn this instance is running for it. */
const interrupts = new Map<string, () => void>();

export function subscribeSessionChat(id: string, listener: Listener) {
  const set = listeners.get(id) ?? new Set();
  set.add(listener);
  listeners.set(id, set);
  return () => {
    set.delete(listener);
    if (!set.size) listeners.delete(id);
  };
}

/** Hands a frame to this instance's sockets for the session. */
export function deliverSessionChat(id: string, frame: Record<string, unknown>) {
  for (const listener of listeners.get(id) ?? []) listener(frame);
}

/**
 * A frame for every viewer of the session, wherever they are connected:
 * this instance's sockets now, every other instance's through the bus.
 */
export function broadcastSessionChat(id: string, frame: Record<string, unknown>) {
  deliverSessionChat(id, frame);
  void publishSessionBus({ kind: "chat", sessionId: id, frame, origin: INSTANCE_ID });
}

/** How many sockets this instance holds for the session (diagnostics / tests). */
export function sessionChatListenerCount(id: string): number {
  return listeners.get(id)?.size ?? 0;
}

onSessionBus("chat", (m) => deliverSessionChat(m.sessionId, m.frame));
onSessionBus("control", (m) => {
  if (m.scope === "pod" && m.action === "interrupt") interrupts.get(m.sessionId)?.();
});

// ── Interrupt: durable flag + bus nudge + this instance's exec ──────────────

/**
 * Records that the session's running turn should stop: `finished_at` set on
 * a turn that is still `running` (no other write produces that state). The
 * instance running the turn honors it on its next poll even if the bus
 * message never arrived; `finishSessionTurn` overwrites the time when the
 * turn ends.
 */
export async function requestTurnInterrupt(sessionId: string): Promise<boolean> {
  const rows = await db
    .update(sessionChatTurns)
    .set({ finishedAt: new Date() })
    .where(
      and(
        eq(sessionChatTurns.sessionId, sessionId),
        eq(sessionChatTurns.state, "running"),
        isNull(sessionChatTurns.finishedAt),
      ),
    )
    .returning({ id: sessionChatTurns.id });
  return rows.length > 0;
}

/**
 * Stops the session's running turn wherever it runs: this instance's exec
 * at once, the durable flag for the instance that has it, and a nudge on
 * the bus so that instance acts now rather than at its next poll.
 */
export async function interruptSessionChat(id: string): Promise<void> {
  interrupts.get(id)?.();
  await requestTurnInterrupt(id).catch((err) =>
    logger.warn({ err, sessionId: id }, "could not record the turn interrupt"),
  );
  await publishSessionBus({
    kind: "control",
    scope: "pod",
    sessionId: id,
    action: "interrupt",
    origin: INSTANCE_ID,
  });
}

/** How often a running turn checks the durable flag and its session's state. */
export const TURN_CONTROL_POLL_MS = Number(process.env.OPTIO_TURN_CONTROL_POLL_MS ?? 2_000);

/**
 * Whether the turn has been asked to stop: the interrupt flag on its row,
 * the row settled by someone else (boot recovery), or its session no longer
 * active (ended from any instance).
 */
export async function turnShouldStop(turnId: string): Promise<boolean> {
  const [row] = await db
    .select({
      finishedAt: sessionChatTurns.finishedAt,
      state: sessionChatTurns.state,
      sessionState: interactiveSessions.state,
    })
    .from(sessionChatTurns)
    .innerJoin(interactiveSessions, eq(interactiveSessions.id, sessionChatTurns.sessionId))
    .where(eq(sessionChatTurns.id, turnId));
  if (!row) return true;
  if (row.state !== "running") return true;
  if (row.finishedAt) return true;
  return row.sessionState !== "active";
}

/**
 * While this instance runs a turn: registers how to stop it (for the bus
 * and for sockets on this instance) and polls the durable flag, so an
 * interrupt or an end-session from any instance stops the exec even when
 * the bus message was lost. Returns the function that ends the watch.
 */
export function watchTurnControl(
  sessionId: string,
  turnId: string,
  interrupt: () => void,
): () => void {
  let stopped = false;
  let fired = false;
  const fire = () => {
    if (fired) return;
    fired = true;
    interrupt();
  };
  interrupts.set(sessionId, fire);
  const timer = setInterval(() => {
    if (stopped || fired) return;
    turnShouldStop(turnId)
      .then((stop) => {
        if (stop && !stopped) fire();
      })
      .catch((err) => logger.debug({ err, turnId }, "turn control poll failed"));
  }, TURN_CONTROL_POLL_MS);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
    if (interrupts.get(sessionId) === fire) interrupts.delete(sessionId);
  };
}
