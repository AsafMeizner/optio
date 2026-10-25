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

  describe("the exit code, per kind (tasks and review runs infer it; Job runs and turns do not)", () => {
    const verdict = (agent: string, lines: string[], exit: number, infer = true) => {
      const digest = new RunOutputDigest(agent);
      for (const line of lines) digest.push(line);
      return digest.finish(exit, { inferExitCode: infer });
    };
    const ok = JSON.stringify({ type: "result", is_error: false, result: "done" });
    const bad = JSON.stringify({ type: "result", is_error: true, result: "API Error: boom" });

    it("a Claude result event seen is authoritative over the process's exit code", () => {
      // The agent reported success, then its process exited non-zero (a
      // signal after its turn, a wrapper's status): the result decides.
      for (const exit of [1, 2, 143]) {
        const v = verdict("claude-code", [ok], exit);
        expect(v.exitCode).toBe(0);
        expect(v.result.success).toBe(true);
      }
      const failed = verdict("claude-code", [bad], 0);
      expect(failed.exitCode).toBe(1);
      expect(failed.result.success).toBe(false);
      // The first result event decides, as the whole-output inference did.
      expect(verdict("claude-code", [ok, bad], 1).exitCode).toBe(0);
      expect(verdict("cursor", [ok], 1).exitCode).toBe(0);
    });

    it("with no result event, a fatal raw line fails the run, else the process's exit code decides", () => {
      expect(verdict("claude-code", ["fatal: crashed"], 0).exitCode).toBe(1);
      expect(verdict("claude-code", ["starting up"], 1).exitCode).toBe(1);
      expect(verdict("claude-code", ["starting up"], 1).result.success).toBe(false);
      expect(verdict("claude-code", ["starting up"], 0).exitCode).toBe(0);
      // A JSON line with "fatal:" inside is tool output, not a crash.
      expect(
        verdict("claude-code", ['{"type":"tool_result","content":"fatal: x"}'], 0).exitCode,
      ).toBe(0);
    });

    it("other agents keep the old rule exactly: their failure signals decide, the exit code is ignored", () => {
      const quota = '{"type":"error","message":"quota"}';
      const fine = '{"type":"message"}';
      // As the task and review workers read it before the run protocol
      // (`inferExitCode(agentType, allLogs)`, the process status unused).
      for (const exit of [0, 1, 3, 143]) {
        expect(verdict("codex", [quota], exit).exitCode).toBe(1);
        expect(verdict("codex", [fine], exit).exitCode).toBe(0);
        expect(verdict("codex", [fine], exit).result.success).toBe(true);
        expect(verdict("codex", [fine], exit).exitCode).toBe(inferExitCode("codex", fine));
      }
      expect(verdict("gemini", ["turn limit reached"], 0).exitCode).toBe(1);
      expect(verdict("copilot", ["all good"], 2).exitCode).toBe(0);
    });

    it("without inference (Job runs, agent turns) the process's exit code is the code", () => {
      expect(verdict("claude-code", [ok], 1, false).exitCode).toBe(1);
      expect(verdict("claude-code", [ok], 1, false).result.success).toBe(false);
      expect(verdict("claude-code", [bad], 0, false).result.success).toBe(false);
      expect(verdict("claude-code", [ok], 0, false).result.success).toBe(true);
    });
  });
});

it("Pi retains a nonzero process exit and fails incomplete JSON output", () => {
  const lines = [
    JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [], stopReason: "stop" },
    }),
    JSON.stringify({ type: "agent_settled", aborted: false }),
  ];
  const digest = new RunOutputDigest("pi");
  for (const line of lines) digest.push(line);
  expect(digest.finish(9, { inferExitCode: true }).result.success).toBe(false);
  expect(new RunOutputDigest("pi").finish(0, { inferExitCode: true }).result.success).toBe(false);
});
