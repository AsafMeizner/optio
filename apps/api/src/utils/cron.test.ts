import { afterEach, describe, expect, it, vi } from "vitest";
import { computeNextFire } from "./cron.js";

afterEach(() => vi.useRealTimers());
describe("cron timezone semantics", () => {
  it("keeps a daily schedule at the same local hour across daylight saving time", () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-03-07T17:00:00Z");
    expect(computeNextFire("0 9 * * *", "America/Denver").toISOString()).toBe(
      "2026-03-08T15:00:00.000Z",
    );
    vi.setSystemTime("2026-10-31T17:00:00Z");
    expect(computeNextFire("0 9 * * *", "America/Denver").toISOString()).toBe(
      "2026-11-01T16:00:00.000Z",
    );
  });
  it("defaults to UTC and rejects invalid zones", () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-10-11T00:00:00Z");
    expect(computeNextFire("0 9 * * *").toISOString()).toBe("2026-10-11T09:00:00.000Z");
    expect(() => computeNextFire("0 9 * * *", "Mars/Olympus")).toThrow();
  });
});
