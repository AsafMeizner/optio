import { beforeEach, describe, expect, it, vi } from "vitest";

const returning = vi.fn();
vi.mock("../db/client.js", () => ({
  db: {
    insert: () => ({
      values: () => ({ onConflictDoNothing: () => ({ returning: () => returning() }) }),
    }),
  },
}));
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
  });

  it("is the first to see a delivery when the insert returns a row", async () => {
    returning.mockResolvedValue([{ source: "github" }]);
    expect(await claimInboundDelivery("github", "guid-1")).toBe(true);
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
