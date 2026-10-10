import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("bullmq", () => ({
  Queue: class {
    upsertJobScheduler = vi.fn().mockResolvedValue({});
  },
  Worker: class {
    on = vi.fn();
    close = vi.fn().mockResolvedValue(undefined);
  },
}));
vi.mock("../services/redis-config.js", () => ({
  getBullMQOptions: () => ({ connection: {}, prefix: "bull" }),
}));
const mockExecute = vi.fn();
vi.mock("../db/client.js", () => ({ db: { execute: (...a: unknown[]) => mockExecute(...a) } }));
const warn = vi.fn();
const info = vi.fn();
vi.mock("../logger.js", () => ({
  logger: {
    info: (...a: unknown[]) => info(...a),
    warn: (...a: unknown[]) => warn(...a),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { registerSweep, registeredSweeps, runSweeps } from "./sweep-worker.js";

describe("sweep-worker", () => {
  beforeEach(() => {
    mockExecute.mockReset().mockResolvedValue([]);
    warn.mockReset();
    info.mockReset();
  });

  it("registers the three coordination sweeps at import", () => {
    expect(registeredSweeps()).toEqual(
      expect.arrayContaining(["inbound-webhook-deliveries", "ws-upgrade-tokens", "leases"]),
    );
  });

  it("runs every sweep, reports counts, and a failing sweep does not stop the others", async () => {
    const order: string[] = [];
    registerSweep("a", async () => {
      order.push("a");
      return 2;
    });
    registerSweep("b", async () => {
      order.push("b");
      throw new Error("boom");
    });
    registerSweep("c", async () => {
      order.push("c");
      return 0;
    });
    const removed = await runSweeps();
    expect(order).toEqual(expect.arrayContaining(["a", "b", "c"]));
    expect(removed.a).toBe(2);
    expect(removed.c).toBe(0);
    expect(removed).not.toHaveProperty("b");
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ sweep: "b" }),
      "Housekeeping sweep failed",
    );
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ sweep: "a", removed: 2 }),
      "Housekeeping sweep",
    );
  });

  it("the built-in sweeps delete through the database", async () => {
    mockExecute.mockResolvedValue([{ x: 1 }, { x: 2 }]);
    const removed = await runSweeps();
    expect(removed["inbound-webhook-deliveries"]).toBe(2);
    expect(removed["ws-upgrade-tokens"]).toBe(2);
    expect(removed.leases).toBe(2);
    const statements = mockExecute.mock.calls.map((c) => JSON.stringify(c[0]));
    expect(statements.some((s) => s.includes("inbound_webhook_deliveries"))).toBe(true);
    expect(statements.some((s) => s.includes("ws_upgrade_tokens"))).toBe(true);
    expect(statements.some((s) => s.includes('DELETE FROM \\"leases\\"'))).toBe(true);
  });
});
