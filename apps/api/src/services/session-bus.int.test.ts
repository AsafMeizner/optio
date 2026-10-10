/**
 * The session bus against real Redis and Postgres: a chat frame broadcast
 * here reaches this instance's sockets at once and another instance's
 * through the channel; an interrupt is a durable flag on the running turn
 * (honored by the control poll) plus a bus nudge; a session's end and a
 * share's revocation close sockets on every instance.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { interactiveSessions, sessionChatTurns, users } from "../db/schema.js";
import { insertWorkspace } from "../test-utils/integration/fixtures.js";
import { createSubscriber } from "./event-bus.js";
import { INSTANCE_ID } from "./instance.js";
import {
  SESSION_BUS_CHANNEL,
  dispatchSessionBusMessage,
  publishSessionBus,
  startSessionBus,
  stopSessionBus,
  type SessionBusMessage,
} from "./session-bus.js";
import {
  broadcastSessionChat,
  claimSessionTurn,
  finishSessionTurn,
  interruptSessionChat,
  requestTurnInterrupt,
  sessionChatListenerCount,
  subscribeSessionChat,
  turnShouldStop,
  watchTurnControl,
} from "./session-turn-service.js";
import {
  closeSessionStreams,
  sessionStreamCount,
  watchSessionAccess,
} from "./session-sharing-service.js";

async function insertSession(overrides: { workspaceId: string }) {
  const [owner] = await db
    .insert(users)
    .values({
      provider: "github",
      externalId: randomUUID(),
      email: `${randomUUID()}@example.com`,
      displayName: "Owner",
    })
    .returning();
  const [session] = await db
    .insert(interactiveSessions)
    .values({
      repoUrl: "https://github.com/test/repo",
      branch: `session/${randomUUID()}`,
      userId: owner.id,
      ...overrides,
    })
    .returning();
  return session;
}

/**
 * What another instance would see on the channel. The channel is the Redis
 * server's, not a logical database's, so parallel test files' instances
 * publish on it too: always look for one's own session ids.
 */
const otherInstance: SessionBusMessage[] = [];
const seenFor = (sessionId: string) => otherInstance.filter((m) => m.sessionId === sessionId);
let tap: ReturnType<typeof createSubscriber>;

beforeAll(async () => {
  await startSessionBus();
  tap = createSubscriber();
  tap.on("message", (_ch: string, raw: string) => otherInstance.push(JSON.parse(raw)));
  await tap.subscribe(SESSION_BUS_CHANNEL);
});
afterAll(async () => {
  await tap.unsubscribe(SESSION_BUS_CHANNEL);
  tap.disconnect();
  await stopSessionBus();
});
afterEach(() => {
  otherInstance.length = 0;
});

const waitFor = async (cond: () => boolean, ms = 5000) => {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe("chat frames", () => {
  it("reach local sockets synchronously and other instances over the bus; own messages are skipped", async () => {
    const id = randomUUID();
    const seen: Record<string, unknown>[] = [];
    const off = subscribeSessionChat(id, (f) => seen.push(f));
    expect(sessionChatListenerCount(id)).toBe(1);

    broadcastSessionChat(id, { type: "status", status: "thinking" });
    expect(seen).toEqual([{ type: "status", status: "thinking" }]); // before any await
    await waitFor(() => seenFor(id).length === 1);
    expect(seenFor(id)[0]).toMatchObject({
      kind: "chat",
      sessionId: id,
      frame: { type: "status", status: "thinking" },
      origin: INSTANCE_ID,
    });
    // Our own message came back from Redis too and was not delivered twice.
    await new Promise((r) => setTimeout(r, 100));
    expect(seen).toHaveLength(1);

    // A frame from another instance is delivered to the local sockets.
    await publishSessionBus({
      kind: "chat",
      sessionId: id,
      frame: { type: "chat_event", event: { type: "text", content: "hi" } },
      origin: "api-other:000000",
    });
    await waitFor(() => seen.length === 2);
    expect(seen[1]).toMatchObject({ type: "chat_event" });

    // Nothing for sessions this instance has no sockets for.
    dispatchSessionBusMessage({
      kind: "chat",
      sessionId: randomUUID(),
      frame: { type: "x" },
      origin: "api-other:000000",
    });
    expect(seen).toHaveLength(2);
    off();
    expect(sessionChatListenerCount(id)).toBe(0);
  });
});

describe("interrupt", () => {
  it("is a durable flag on the running turn that the control poll honors, plus a bus nudge", async () => {
    const ws = await insertWorkspace();
    const session = await insertSession({ workspaceId: ws.id });
    const claim = await claimSessionTurn(session.id, randomUUID(), "hello");
    expect(claim.accepted).toBe(true);
    const turnId = claim.accepted ? claim.turn.id : "";

    expect(await turnShouldStop(turnId)).toBe(false);
    expect(await requestTurnInterrupt(session.id)).toBe(true);
    expect(await requestTurnInterrupt(session.id)).toBe(false); // already flagged
    expect(await turnShouldStop(turnId)).toBe(true);
    const [row] = await db.select().from(sessionChatTurns).where(eq(sessionChatTurns.id, turnId));
    expect(row.state).toBe("running"); // still running: the flag is the time, not the state
    expect(row.finishedAt).not.toBeNull();

    await finishSessionTurn(turnId, false);
    const [done] = await db.select().from(sessionChatTurns).where(eq(sessionChatTurns.id, turnId));
    expect(done.state).toBe("interrupted");
  });

  it("the watch fires this instance's interrupt from the bus, from the flag, and from the session ending", async () => {
    const ws = await insertWorkspace();

    // From the bus (another instance asked).
    const a = await insertSession({ workspaceId: ws.id });
    const ca = await claimSessionTurn(a.id, randomUUID(), "a");
    const firedA = vi.fn();
    const stopA = watchTurnControl(a.id, ca.accepted ? ca.turn.id : "", firedA);
    dispatchSessionBusMessage({
      kind: "control",
      scope: "pod",
      sessionId: a.id,
      action: "interrupt",
      origin: "api-other:000000",
    });
    expect(firedA).toHaveBeenCalledTimes(1);
    dispatchSessionBusMessage({
      kind: "control",
      scope: "pod",
      sessionId: a.id,
      action: "interrupt",
      origin: "api-other:000000",
    });
    expect(firedA).toHaveBeenCalledTimes(1); // once per turn
    stopA();

    // From the flag alone (the bus message was lost), on the next poll.
    const b = await insertSession({ workspaceId: ws.id });
    const cb = await claimSessionTurn(b.id, randomUUID(), "b");
    const firedB = vi.fn();
    const stopB = watchTurnControl(b.id, cb.accepted ? cb.turn.id : "", firedB);
    await requestTurnInterrupt(b.id);
    await waitFor(() => firedB.mock.calls.length === 1, 10_000);
    stopB();

    // From the session ending on any instance.
    const c = await insertSession({ workspaceId: ws.id });
    const cc = await claimSessionTurn(c.id, randomUUID(), "c");
    const firedC = vi.fn();
    const stopC = watchTurnControl(c.id, cc.accepted ? cc.turn.id : "", firedC);
    await db
      .update(interactiveSessions)
      .set({ state: "ended", endedAt: new Date() })
      .where(eq(interactiveSessions.id, c.id));
    await waitFor(() => firedC.mock.calls.length === 1, 10_000);
    stopC();

    // Once the watch is stopped, a late nudge does nothing.
    const d = await insertSession({ workspaceId: ws.id });
    const cd = await claimSessionTurn(d.id, randomUUID(), "d");
    const firedD = vi.fn();
    watchTurnControl(d.id, cd.accepted ? cd.turn.id : "", firedD)();
    dispatchSessionBusMessage({
      kind: "control",
      scope: "pod",
      sessionId: d.id,
      action: "interrupt",
      origin: "api-other:000000",
    });
    expect(firedD).not.toHaveBeenCalled();
  });

  it("interruptSessionChat does all three: local exec, flag, bus", async () => {
    const ws = await insertWorkspace();
    const s = await insertSession({ workspaceId: ws.id });
    const claim = await claimSessionTurn(s.id, randomUUID(), "x");
    const fired = vi.fn();
    const stop = watchTurnControl(s.id, claim.accepted ? claim.turn.id : "", fired);
    await interruptSessionChat(s.id);
    expect(fired).toHaveBeenCalledTimes(1);
    expect(await turnShouldStop(claim.accepted ? claim.turn.id : "")).toBe(true);
    await waitFor(() => seenFor(s.id).some((m) => m.kind === "control"));
    expect(seenFor(s.id).find((m) => m.kind === "control")).toMatchObject({
      action: "interrupt",
      scope: "pod",
    });
    stop();
  });
});

describe("session end and share revocation", () => {
  it("close this instance's sockets now and tell every other instance", async () => {
    const ws = await insertWorkspace();
    const session = await insertSession({ workspaceId: ws.id });
    const socket = Object.assign(new EventEmitter(), { close: vi.fn() });
    watchSessionAccess("pod", session, { id: session.userId!, workspaceId: ws.id }, socket);
    expect(sessionStreamCount("pod", session.id)).toBe(1);

    await closeSessionStreams("pod", session.id);
    expect(socket.close).toHaveBeenCalledWith(4403, "Session ended");
    await waitFor(() =>
      seenFor(session.id).some((m) => m.kind === "control" && m.action === "end"),
    );
    expect(seenFor(session.id).find((m) => m.kind === "control")).toMatchObject({
      scope: "pod",
      sessionId: session.id,
      origin: INSTANCE_ID,
    });
    socket.emit("close");
    expect(sessionStreamCount("pod", session.id)).toBe(0);

    // The same message from another instance closes a socket held here.
    const again = Object.assign(new EventEmitter(), { close: vi.fn() });
    watchSessionAccess("pod", session, { id: session.userId!, workspaceId: ws.id }, again);
    dispatchSessionBusMessage({
      kind: "control",
      scope: "pod",
      sessionId: session.id,
      action: "end",
      origin: "api-other:000000",
    });
    expect(again.close).toHaveBeenCalledWith(4403, "Session ended");
    again.emit("close");
  });
});
