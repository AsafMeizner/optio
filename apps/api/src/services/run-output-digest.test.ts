import { describe, it, expect } from "vitest";
import { getAdapter } from "@optio/agent-adapters";
import { RunOutputDigest, inferExitCode } from "./run-output-digest.js";
import { detectAuthFailureInLogs } from "./auth-failure-detector.js";

const claudeOutput = [
  JSON.stringify({ type: "system", subtype: "init", model: "claude-x", session_id: "s1" }),
  JSON.stringify({
    type: "assistant",
    message: {
      usage: { input_tokens: 10, output_tokens: 5 },
      content: [{ type: "text", text: "hi" }],
    },
  }),
  JSON.stringify({ type: "result", is_error: false, result: "first turn", total_cost_usd: 0.01 }),
  "Failed to authenticate. API Error: 401 token expired",
  JSON.stringify({ type: "result", is_error: false, result: "second turn", total_cost_usd: 0.03 }),
].join("\n");

describe("RunOutputDigest", () => {
  it("reads the same verdict line by line as the whole-output parsers do", () => {
    const digest = new RunOutputDigest("claude-code");
    for (const line of claudeOutput.split("\n")) digest.push(line);
    const verdict = digest.finish(0, { inferExitCode: true });

    expect(verdict.result).toEqual(getAdapter("claude-code").parseResult(0, claudeOutput));
    expect(verdict.result.costUsd).toBe(0.03);
    expect(verdict.exitCode).toBe(inferExitCode("claude-code", claudeOutput));
    expect(verdict.auth).toEqual(detectAuthFailureInLogs(claudeOutput));
    expect(verdict.auth.matched).toBe(true);
  });

  it("lets the output's failure signal win over a zero exit when asked to", () => {
    const failed = [JSON.stringify({ type: "result", is_error: true, result: "API Error: boom" })];
    const inferred = new RunOutputDigest("claude-code");
    const raw = new RunOutputDigest("claude-code");
    for (const line of failed) {
      inferred.push(line);
      raw.push(line);
    }
    expect(inferred.finish(0, { inferExitCode: true }).exitCode).toBe(1);
    expect(raw.finish(0).exitCode).toBe(0);
    expect(inferred.finish(0, { inferExitCode: true }).result.success).toBe(false);
  });

  it("infers exit codes per agent from single lines, as from the whole output", () => {
    const codex = ['{"type":"message"}', '{"type":"error","message":"quota"}'].join("\n");
    expect(inferExitCode("codex", codex)).toBe(1);
    expect(inferExitCode("codex", '{"type":"message"}')).toBe(0);
    // Claude: the first result event decides; a raw fatal line only without one.
    expect(inferExitCode("claude-code", 'fatal: x\n{"type":"result","is_error":false}')).toBe(0);
    expect(inferExitCode("claude-code", "fatal: x")).toBe(1);
    expect(inferExitCode("cursor", '{"type":"result","is_error":true}')).toBe(1);
    expect(inferExitCode("unknown-agent", '{"type":"result","is_error":true}')).toBe(1);
  });
});
