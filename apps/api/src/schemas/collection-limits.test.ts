import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { z as bundledV4 } from "zod/v4";

// Regression for GHSA-mrhx-c7xc-m3w5. Our Zod 3 compatibility patch must
// reject an oversized collection before walking or allocating element errors.
const require = createRequire(import.meta.url);
const commonJsZod = require("zod").z as typeof z;
const commonJsBundledV4 = require("zod/v4").z as typeof bundledV4;

describe.each([
  ["ESM", z],
  ["CommonJS", commonJsZod],
  ["bundled v4 ESM", bundledV4 as unknown as typeof z],
  ["bundled v4 CommonJS", require("zod/v4").z as typeof z],
] as const)("%s collection limits", (_name, schema) => {
  it.each(["max", "length"] as const)("checks array %s before parsing elements", (bound) => {
    const visit = vi.fn((value: unknown) => value);
    const validator = schema.array(schema.preprocess(visit, schema.string()))[bound](2);
    const result = validator.safeParse(Array(10_000).fill(0));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues).toHaveLength(1);
    expect(visit).not.toHaveBeenCalled();
  });

  it("does not start asynchronous element work for oversized arrays", async () => {
    const visit = vi.fn(async (value: unknown) => value);
    const result = await schema
      .array(schema.preprocess(visit, schema.string()))
      .max(2)
      .safeParseAsync(Array(10_000).fill(0));
    expect(result.success).toBe(false);
    expect(visit).not.toHaveBeenCalled();
  });

  it("checks the maximum after a leading minimum without parsing elements", () => {
    const visit = vi.fn((value: unknown) => value);
    const array = schema.array(schema.preprocess(visit, schema.string())).min(1).max(2);
    const set = schema.set(schema.preprocess(visit, schema.string())).min(1).max(2);
    expect(array.safeParse(Array(10_000).fill(0)).success).toBe(false);
    expect(set.safeParse(new Set([0, 1, 2])).success).toBe(false);
    expect(visit).not.toHaveBeenCalled();
  });

  it("checks set bounds before parsing elements", () => {
    const visit = vi.fn((value: unknown) => value);
    const result = schema
      .set(schema.preprocess(visit, schema.string()))
      .max(2)
      .safeParse(new Set(Array.from({ length: 10_000 }, (_, index) => index)));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues).toHaveLength(1);
    expect(visit).not.toHaveBeenCalled();
  });

  it("still validates elements inside the permitted bound", () => {
    const validator = schema.array(schema.string()).max(2);
    expect(validator.safeParse(["valid"]).success).toBe(true);
    expect(validator.safeParse([0]).success).toBe(false);
  });

  it("returns parsed values for permitted arrays and sets", () => {
    const element = schema.string().transform((value) => value.toUpperCase());
    expect(schema.array(element).max(2).parse(["valid"])).toEqual(["VALID"]);
    expect(
      schema
        .set(element)
        .max(2)
        .parse(new Set(["valid"])),
    ).toEqual(new Set(["VALID"]));
  });

  it("treats a set maximum as a raw input limit even if transforms could deduplicate it", () => {
    const transform = vi.fn((value: string) => value.toLowerCase());
    const validator = schema.set(schema.string().transform(transform)).max(1);
    expect(validator.safeParse(new Set(["a", "A"])).success).toBe(false);
    expect(transform).not.toHaveBeenCalled();
  });
});

describe.each([
  ["bundled v4 ESM", bundledV4],
  ["bundled v4 CommonJS", commonJsBundledV4],
] as const)("%s conditional collection checks", (_name, schema) => {
  it("calls a custom when once with parsed elements", () => {
    const when = vi.fn((payload: { value: unknown }) =>
      (payload.value as string[])[0].endsWith("x"),
    );
    const validator = schema
      .array(schema.number().transform(String))
      .check(schema.maxLength(1, { when }));
    expect(validator.parse([1, 2])).toEqual(["1", "2"]);
    expect(when).toHaveBeenCalledTimes(1);
    expect(when.mock.calls[0][0].value).toEqual(["1", "2"]);
  });

  it("preserves a custom when before a later unconditional bound", () => {
    const when = vi.fn((payload: { value: unknown }) =>
      (payload.value as string[])[0].endsWith("x"),
    );
    const validator = schema
      .array(schema.number().transform(String))
      .check(schema.minLength(1, { when }))
      .max(1);
    expect(validator.safeParse([1, 2]).success).toBe(false);
    expect(when).toHaveBeenCalledTimes(1);
    expect(when.mock.calls[0][0].value).toEqual(["1", "2"]);
  });

  it("still runs element validation and conditional checks for undersized exact bounds", () => {
    const transform = vi.fn(String);
    const validator = schema.array(schema.number().transform(transform)).length(2);
    expect(validator.safeParse([1]).success).toBe(false);
    expect(transform).toHaveBeenCalledTimes(1);
  });

  it("caps maps before key transforms can deduplicate the input", () => {
    const transform = vi.fn((value: string) => value.toLowerCase());
    const validator = schema
      .map(schema.string().transform(transform), schema.number())
      .check(schema.maxSize(1));
    expect(
      validator.safeParse(
        new Map([
          ["a", 1],
          ["A", 2],
        ]),
      ).success,
    ).toBe(false);
    expect(transform).not.toHaveBeenCalled();
    expect(validator.parse(new Map([["A", 1]]))).toEqual(new Map([["a", 1]]));
  });
});
