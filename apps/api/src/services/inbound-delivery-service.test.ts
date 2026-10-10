import { beforeEach, describe, expect, it, vi } from "vitest";

const returning = vi.fn();
const executed: string[] = [];
vi.mock("../db/client.js", () => {
  const tx = {
    execute: async (q: { queryChunks?: Array<{ value?: string[] }> }) => {
      executed.push(JSON.stringify(q));
    },
    insert: () => ({
      values: () => ({ onConflictDoNothing: () => ({ returning: () => returning() }) }),
    }),
  };
  return { db: { transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) } };
});
vi.mock("../db/schema.js", () => ({
  inboundWebhookDeliveries: { source: "source", deliveryId: "delivery_id" },
}));
const warn = vi.fn();
vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: (...a: unknown[]) => warn(...a), error: vi.fn(), debug: vi.fn() },
}));

import { claimInboundDelivery } from "./inbound-delivery-service.js";

describe("claimInboundDelivery", () => {
  beforeEach(() => {
    returning.mockReset();
    warn.mockReset();
    executed.length = 0;
  });

  it("is the first to see a delivery when the insert returns a row", async () => {
    returning.mockResolvedValue([{ source: "github" }]);
    expect(await claimInboundDelivery("github", "guid-1")).toBe(true);
    // The insert runs under a one-second statement timeout.
    expect(executed.join()).toContain("statement_timeout = '1s'");
  });

  it("accepts the delivery when the insert times out, and says so", async () => {
    returning.mockRejectedValue(
      Object.assign(new Error("Failed query"), {
        cause: Object.assign(new Error("canceling statement due to statement timeout"), {
          code: "57014",
        }),
      }),
    );
    expect(await claimInboundDelivery("github", "guid-2")).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ source: "github" }),
      expect.stringContaining("timed out"),
    );
  });

  it("is a replay when the insert conflicts (no row back)", async () => {
    returning.mockResolvedValue([]);
    expect(await claimInboundDelivery("github", "guid-1")).toBe(false);
  });

  it("fails open when the database is away, and says so", async () => {
    returning.mockRejectedValue(new Error("ECONNREFUSED"));
    expect(await claimInboundDelivery("slack", "Ev1")).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ source: "slack" }),
      expect.stringContaining("accepting"),
    );
  });
});
