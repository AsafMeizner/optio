import { describe, expect, it } from "vitest";
import { costForTokens, formatTokens, formatUsd, priceForModel } from "./agent-usage.js";

describe("usage estimates", () => {
  it.each([null, undefined, "", "unknown-model", "gpt-6-sol-unpublished", "toString", "__proto__"])(
    "does not assign an unrelated price to %s",
    (model) => {
      expect(priceForModel(model)).toBeNull();
    },
  );
  it("normalizes model case and snapshot dates", () => {
    expect(priceForModel("GPT-6-SOL-2026-10-01")).toEqual(priceForModel("gpt-6-sol"));
    expect(priceForModel("claude-opus-4-5-20251101")).toEqual({
      input: 5,
      output: 25,
      cacheRead: 0.5,
      cacheWrite: 6.25,
    });
    expect(priceForModel("claude-opus-4-20250514")).toEqual({
      input: 15,
      output: 75,
      cacheRead: 1.5,
      cacheWrite: 18.75,
    });
  });
  it.each(["gpt-6-sol", "gpt-5.6-sol", "gpt-5.4"])(
    "applies long-context rates only above the threshold for %s",
    (model) => {
      const standard = priceForModel(model)!;
      expect(priceForModel(model, { inputTokens: 272_000 })).toEqual(standard);
      expect(priceForModel(model, { inputTokens: 272_001 })).toEqual({
        input: standard.input * 2,
        output: standard.output * 1.5,
        cacheRead: standard.cacheRead * 2,
        cacheWrite: standard.cacheWrite * 2,
      });
    },
  );
  it("does not apply long-context multipliers to models without that rate", () => {
    expect(priceForModel("gpt-5.4-mini", { inputTokens: 300_000 })).toEqual(
      priceForModel("gpt-5.4-mini"),
    );
  });
  it.each(["fast", "priority"])("applies %s pricing only to eligible models", (serviceTier) => {
    for (const model of ["gpt-6-sol", "gpt-5.3-codex"]) {
      const standard = priceForModel(model)!;
      expect(priceForModel(model, { serviceTier })).toEqual({
        input: standard.input * 2,
        output: standard.output * 2,
        cacheRead: standard.cacheRead * 2,
        cacheWrite: standard.cacheWrite * 2,
      });
    }
    expect(priceForModel("gpt-5.4", { serviceTier })).toEqual(priceForModel("gpt-5.4"));
  });
  it("combines fast and long-context rates without multiplying ordinary service tiers", () => {
    expect(priceForModel("gpt-6-sol", { serviceTier: "fast", inputTokens: 300_000 })).toEqual({
      input: 8,
      output: 30,
      cacheRead: 0.8,
      cacheWrite: 10,
    });
    expect(priceForModel("gpt-6-sol", { serviceTier: "standard" })).toEqual(
      priceForModel("gpt-6-sol"),
    );
  });
  it("prices each token category exactly once per million tokens", () => {
    expect(
      costForTokens(
        {
          inputTokens: 100_000,
          outputTokens: 20_000,
          cacheReadTokens: 50_000,
          cacheWriteTokens: 10_000,
        },
        { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
      ),
    ).toBeCloseTo(0.435);
  });
  it.each([
    [0, "0"],
    [950, "950"],
    [1000, "1.0k"],
    [9999, "10.0k"],
    [12_345, "12k"],
    [1_000_000, "1.0M"],
    [2_100_000, "2.1M"],
  ])("formats %s tokens as %s", (tokens, formatted) => {
    expect(formatTokens(Number(tokens))).toBe(formatted);
  });
  it.each([
    [0, "$0.00"],
    [0.001, "<$0.01"],
    [0.01, "$0.01"],
    [12.3, "$12.30"],
  ])("formats USD %s as %s", (usd, formatted) => {
    expect(formatUsd(Number(usd))).toBe(formatted);
  });
});
