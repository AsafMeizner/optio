import { describe, it, expect } from "vitest";
import { missedLogs, withMissed, SeenLogs } from "./log-resync";

const row = (id: string | undefined, content: string, second: number) => ({
  id,
  content,
  stream: "stdout",
  timestamp: `2025-06-01T00:00:0${second}.000Z`,
});

describe("missedLogs", () => {
  it("returns the fetched rows the view lacks from the newest it had seen on", () => {
    const known = [row("a", "one", 1), row("b", "two", 2)];
    const fetched = [row("a", "one", 1), row("b", "two", 2), row("c", "three", 3)];
    expect(missedLogs(known, fetched, known[1].timestamp)).toEqual([row("c", "three", 3)]);
  });

  it("keeps rows that share the newest seen timestamp (one stored batch, half delivered)", () => {
    const known = [row("a", "one", 1)];
    const fetched = [row("a", "one", 1), row("b", "two", 1)];
    expect(missedLogs(known, fetched, known[0].timestamp)).toEqual([row("b", "two", 1)]);
  });

  it("leaves rows older than the newest seen alone (a cleared view stays cleared)", () => {
    expect(
      missedLogs([], [row("a", "one", 1), row("b", "two", 2)], row("b", "two", 2).timestamp),
    ).toEqual([row("b", "two", 2)]);
  });

  it("recognizes a row without an id by its time and content", () => {
    expect(missedLogs([row(undefined, "one", 1)], [row("a", "one", 1)], null)).toEqual([]);
  });
});

describe("withMissed", () => {
  it("puts the missed rows in time order", () => {
    const merged = withMissed([row("a", "one", 1), row("d", "four", 4)], [row("b", "two", 2)]);
    expect(merged.map((l) => l.content)).toEqual(["one", "two", "four"]);
  });

  it("returns the same array when nothing was missed", () => {
    const prev = [row("a", "one", 1)];
    expect(withMissed(prev, [])).toBe(prev);
  });
});

describe("SeenLogs", () => {
  it("counts rows, keeps the newest time and knows ids", () => {
    const seen = new SeenLogs();
    seen.add([row("a", "one", 2), row("b", "two", 1)]);
    expect(seen.count).toBe(2);
    expect(seen.newest).toBe(row("a", "one", 2).timestamp);
    expect(seen.has(row("a", "one", 2))).toBe(true);
    expect(seen.has(row(undefined, "one", 2))).toBe(false);
  });
});
