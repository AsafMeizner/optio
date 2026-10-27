import { describe, expect, it } from "vitest";
import { stableStringify } from "./stable.js";

describe("stable configuration serialization", () => {
  it("sorts keys recursively without reordering arrays or mutating inputs", () => {
    const value = { z: [{ b: 2, a: 1 }, "last"], a: { y: false, x: null }, omit: undefined };
    expect(stableStringify(value)).toBe('{"a":{"x":null,"y":false},"z":[{"a":1,"b":2},"last"]}');
    expect(Object.keys(value)).toEqual(["z", "a", "omit"]);
    expect(Object.keys(value.z[0]!)).toEqual(["b", "a"]);
  });
  it("preserves dates and JSON scalar semantics", () => {
    expect(stableStringify([new Date("2026-01-02T00:00:00Z"), null, false, 0, "", undefined])).toBe(
      '["2026-01-02T00:00:00.000Z",null,false,0,"",null]',
    );
  });
  it("makes reordered configuration equivalent while distinguishing array order", () => {
    expect(stableStringify({ b: { y: 2, x: 1 }, a: 3 })).toBe(
      stableStringify({ a: 3, b: { x: 1, y: 2 } }),
    );
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
  });
});
