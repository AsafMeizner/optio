/**
 * The session bus's start: a failed SUBSCRIBE leaves no client behind and
 * the bus not started; the boot path retries in the background with backoff
 * and never throws.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

const clients = vi.hoisted(() => ({
  made: [] as Array<{ subscribe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }>,
  failures: 0,
}));

vi.mock("./event-bus.js", () => ({
  getRedisClient: () => ({ publish: vi.fn().mockResolvedValue(1) }),
  createOrderedBusSubscriber: () => {
    const client = Object.assign(new EventEmitter(), {
      subscribe: vi.fn(async () => {
        if (clients.failures > 0) {
          clients.failures--;
          throw new Error("ECONNREFUSED");
        }
        return 1;
      }),
      unsubscribe: vi.fn().mockResolvedValue(1),
      disconnect: vi.fn(),
    });
    clients.made.push(client);
    return client;
  },
}));
vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import {
  isSessionBusStarted,
  startSessionBus,
  startSessionBusInBackground,
  stopSessionBus,
} from "./session-bus.js";

beforeEach(() => {
  clients.made.length = 0;
  clients.failures = 0;
});
afterEach(async () => {
  vi.useRealTimers();
  await stopSessionBus();
});

describe("starting the session bus", () => {
  it("a failed SUBSCRIBE disconnects its client and leaves the bus not started", async () => {
    clients.failures = 1;
    await expect(startSessionBus()).rejects.toThrow(/ECONNREFUSED/);
    expect(isSessionBusStarted()).toBe(false);
    expect(clients.made).toHaveLength(1);
    expect(clients.made[0].disconnect).toHaveBeenCalledTimes(1);

    await startSessionBus();
    expect(isSessionBusStarted()).toBe(true);
    expect(clients.made).toHaveLength(2);
    expect(clients.made[1].disconnect).not.toHaveBeenCalled();
    // Idempotent once started.
    await startSessionBus();
    expect(clients.made).toHaveLength(2);
  });

  it("the boot path retries with backoff in the background and never throws", async () => {
    vi.useFakeTimers();
    clients.failures = 3;
    startSessionBusInBackground();
    await vi.advanceTimersByTimeAsync(0);
    expect(isSessionBusStarted()).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000); // 1 s
    await vi.advanceTimersByTimeAsync(2_000); // 2 s
    expect(isSessionBusStarted()).toBe(false);
    await vi.advanceTimersByTimeAsync(4_000); // 4 s: the fourth attempt works
    expect(isSessionBusStarted()).toBe(true);
    expect(clients.made).toHaveLength(4);
    expect(clients.made.slice(0, 3).every((c) => c.disconnect.mock.calls.length === 1)).toBe(true);
  });

  it("stopping cancels a pending retry", async () => {
    vi.useFakeTimers();
    clients.failures = 1;
    startSessionBusInBackground();
    await vi.advanceTimersByTimeAsync(0);
    await stopSessionBus();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(isSessionBusStarted()).toBe(false);
    expect(clients.made).toHaveLength(1);
  });
});
