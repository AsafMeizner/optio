import { describe, expect, it } from "vitest";
import { parseRunHomeList, removable } from "./run-home-sweep-service.js";

describe("run-home sweep", () => {
  it("parses the pod's listing, skipping names that are not run ids", () => {
    expect(
      parseRunHomeList(
        [
          "0f2e1c1a-1111-4222-8333-444444444444 1234",
          "../etc 0",
          "turn-7 0",
          "",
          "weird name 9",
          "abc",
        ].join("\n"),
      ),
    ).toEqual([
      { runId: "0f2e1c1a-1111-4222-8333-444444444444", outputBytes: 1234 },
      { runId: "turn-7", outputBytes: 0 },
    ]);
  });

  it("removes a non-protocol run's home at once, a protocol run's once drained or an hour later", () => {
    const now = Date.now();
    const recent = new Date(now - 60_000);
    const old = new Date(now - 2 * 60 * 60_000);
    const base = { id: "r", finishedAt: recent };
    expect(removable({ ...base, protocol: false, consumedBytes: 0 }, 500, now)).toBe(true);
    expect(removable({ ...base, protocol: true, consumedBytes: 500 }, 500, now)).toBe(true);
    expect(removable({ ...base, protocol: true, consumedBytes: 499 }, 500, now)).toBe(false);
    expect(
      removable({ ...base, protocol: true, consumedBytes: 0, finishedAt: old }, 500, now),
    ).toBe(true);
    expect(
      removable({ ...base, protocol: true, consumedBytes: 0, finishedAt: null }, 500, now),
    ).toBe(false);
  });
});
