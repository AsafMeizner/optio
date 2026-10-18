import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createSession, endSession } from "./interactive-session-service.js";
import {
  enqueueSessionMessage,
  queuedSessionMessages,
  claimQueuedSessionTurn,
  cancelQueuedSessionMessage,
  finishSessionTurn,
  latestSessionTurn,
} from "./session-turn-service.js";

const session = () => createSession({ title: "Queue test", agentRuntime: "codex" });
describe("Durable session message queue", () => {
  it("serializes consumers, keeps FIFO order, cancels only waiting messages and deduplicates receipts", async () => {
    const s = await session();
    const first = randomUUID(),
      second = randomUUID(),
      third = randomUUID();
    await enqueueSessionMessage(s.id, first, "First");
    await enqueueSessionMessage(s.id, second, "Second");
    await enqueueSessionMessage(s.id, third, "Third");
    await enqueueSessionMessage(s.id, second, "Second");
    await expect(enqueueSessionMessage(s.id, second, "Changed")).rejects.toThrow(
      "different prompt",
    );
    expect((await queuedSessionMessages(s.id)).map((m) => m.content)).toEqual([
      "First",
      "Second",
      "Third",
    ]);
    const claims = await Promise.all([claimQueuedSessionTurn(s.id), claimQueuedSessionTurn(s.id)]);
    const claimed = claims.filter(Boolean);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.requestId).toBe(first);
    try {
      expect(await cancelQueuedSessionMessage(s.id, first)).toBe(false);
      expect(await cancelQueuedSessionMessage(s.id, third)).toBe(true);
      expect((await latestSessionTurn(s.id))?.state).toBe("running");
      expect(await claimQueuedSessionTurn(s.id)).toBeNull();
    } finally {
      await finishSessionTurn(claimed[0]!.id, true);
    }
    const next = await claimQueuedSessionTurn(s.id);
    expect(next?.requestId).toBe(second);
    await finishSessionTurn(next!.id, true);
    await enqueueSessionMessage(s.id, first, "First");
    expect(await queuedSessionMessages(s.id)).toEqual([]);
    expect(await claimQueuedSessionTurn(s.id)).toBeNull();
  });
  it("bounds the queue and never starts or accepts work in an ended session", async () => {
    const s = await session();
    for (let n = 0; n < 20; n++) await enqueueSessionMessage(s.id, randomUUID(), String(n));
    await expect(enqueueSessionMessage(s.id, randomUUID(), "Overflow")).rejects.toThrow(
      "queue is full",
    );
    await endSession(s.id);
    expect(await queuedSessionMessages(s.id)).toEqual([]);
    expect(await claimQueuedSessionTurn(s.id)).toBeNull();
    await expect(enqueueSessionMessage(s.id, randomUUID(), "Ended")).rejects.toThrow("not active");
  });
});
