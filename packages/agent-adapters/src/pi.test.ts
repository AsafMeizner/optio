import { describe, expect, it } from "vitest";
import { PiAdapter } from "./pi.js";
import { getAdapter } from "./index.js";

const adapter = new PiAdapter();
const assistant = (text = "Done", extra = {}) => ({
  type: "message_end",
  message: {
    role: "assistant",
    content: [{ type: "text", text }],
    model: "model",
    stopReason: "stop",
    ...extra,
  },
});
const settled = { type: "agent_settled", aborted: false };
const log = (...events: unknown[]) => events.map((e) => JSON.stringify(e)).join("\n");

describe("PiAdapter", () => {
  it("registers and accepts any supported provider key", () => {
    expect(getAdapter("pi").type).toBe("pi");
    for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY"])
      expect(adapter.validateSecrets([key]).valid).toBe(true);
    expect(adapter.validateSecrets([]).valid).toBe(false);
  });
  it("passes prompts and model settings as environment data", () => {
    const config = adapter.buildContainerConfig({
      taskId: "id",
      repoUrl: "url",
      repoBranch: "main",
      prompt: "old",
      renderedPrompt: "$(secret)",
      piModel: "anthropic/model",
      piThinking: "high",
    });
    expect(config.env.OPTIO_PROMPT).toBe("$(secret)");
    expect(config.env.OPTIO_PI_MODEL).toBe("anthropic/model");
    expect(config.env.OPTIO_PI_THINKING).toBe("high");
  });
  it("counts completed usage once despite repeated message snapshots", () => {
    const message = assistant("Opened https://github.com/jonwiggins/optio/pull/123", {
      usage: { input: 10, output: 5, cacheRead: 3, cacheWrite: 2, cost: { total: 0.1 } },
    });
    const result = adapter.parseResult(
      0,
      log(
        message,
        { type: "turn_end", message: message.message },
        { type: "agent_end", messages: [message.message] },
        settled,
      ),
    );
    expect(result).toMatchObject({
      success: true,
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 3,
      cacheWriteTokens: 2,
      costUsd: 0.1,
      model: "model",
      prUrl: "https://github.com/jonwiggins/optio/pull/123",
    });
  });
  it("allows a retried provider error to recover", () => {
    expect(
      adapter.parseResult(
        0,
        log(
          assistant("", { stopReason: "error", errorMessage: "overloaded" }),
          { type: "agent_end", willRetry: true },
          assistant(),
          settled,
        ),
      ).success,
    ).toBe(true);
  });
  it.each(["error", "aborted", "length"])("fails %s even when the CLI exits zero", (stopReason) => {
    expect(adapter.parseResult(0, log(assistant("", { stopReason }), settled)).success).toBe(false);
  });
  it("fails empty, truncated, aborted and nonzero process outputs", () => {
    for (const [code, logs] of [
      [0, ""],
      [0, log(assistant())],
      [1, log(assistant(), settled)],
      [0, log(assistant(), { ...settled, aborted: true })],
    ] as const)
      expect(adapter.parseResult(code, logs).success).toBe(false);
  });
  it("ignores malformed and primitive JSON lines without throwing", () => {
    expect(adapter.parseResult(0, `null\n[]\ninvalid\n${log(assistant(), settled)}`).success).toBe(
      true,
    );
  });
});
