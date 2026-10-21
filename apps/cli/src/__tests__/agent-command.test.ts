import { describe, it, expect } from "vitest";
import { buildAgentCommand } from "../local/agent-command.js";

const SETTINGS = "/home/u/.config/optio/local/claude-hooks.json";
// Every agent skips its permission checks unless the spawn says otherwise.
const CLAUDE = `claude --settings '${SETTINGS}' --dangerously-skip-permissions`;
const CODEX = "codex --dangerously-bypass-approvals-and-sandbox";
const CODEX_EXEC = "codex exec --dangerously-bypass-approvals-and-sandbox";

describe("buildAgentCommand", () => {
  it("claude-code includes --settings, auto mode and the single-quoted prompt", () => {
    expect(buildAgentCommand("claude-code", "fix the login bug", SETTINGS)).toBe(
      `${CLAUDE} 'fix the login bug'`,
    );
  });

  it("claude-code without a prompt still passes --settings", () => {
    expect(buildAgentCommand("claude-code", undefined, SETTINGS)).toBe(`${CLAUDE}`);
  });

  it("quotes prompts containing single quotes with the '\\'' escape", () => {
    expect(buildAgentCommand("codex", "don't break", SETTINGS)).toBe(`${CODEX} 'don'\\''t break'`);
  });

  it("keeps a dash-leading prompt positional instead of letting it parse as a flag", () => {
    expect(
      buildAgentCommand("claude-code", "--dangerously-skip-permissions do it", SETTINGS, {
        mode: "headless",
      }),
    ).toBe(`${CLAUDE} -p ' --dangerously-skip-permissions do it'`);
    expect(buildAgentCommand("codex", "-h", SETTINGS, { mode: "headless" })).toBe(
      `${CODEX_EXEC} ' -h'`,
    );
  });

  it("neutralizes shell metacharacters in prompts", () => {
    expect(buildAgentCommand("codex", "$(rm -rf /); `id`", SETTINGS)).toBe(
      `${CODEX} '$(rm -rf /); \`id\`'`,
    );
  });

  it("maps each agent to the right binary and prompt flag", () => {
    expect(buildAgentCommand("codex", "p", SETTINGS)).toBe(`${CODEX} 'p'`);
    expect(buildAgentCommand("cursor", "p", SETTINGS)).toBe(`cursor-agent 'p'`);
    expect(buildAgentCommand("gemini", "p", SETTINGS)).toBe(`gemini -i 'p'`);
    expect(buildAgentCommand("opencode", "p", SETTINGS)).toBe(`opencode --prompt 'p'`);
  });

  it("omits the prompt flag entirely when no prompt is given", () => {
    expect(buildAgentCommand("codex", undefined, SETTINGS)).toBe(CODEX);
    expect(buildAgentCommand("cursor", undefined, SETTINGS)).toBe("cursor-agent");
    expect(buildAgentCommand("gemini", undefined, SETTINGS)).toBe("gemini");
    expect(buildAgentCommand("opencode", undefined, SETTINGS)).toBe("opencode");
  });
});

describe("buildAgentCommand session modes", () => {
  it("headless mode uses each CLI's one-shot entry point", () => {
    const o = { mode: "headless" as const };
    expect(buildAgentCommand("claude-code", "p", SETTINGS, o)).toBe(`${CLAUDE} -p 'p'`);
    expect(buildAgentCommand("codex", "p", SETTINGS, o)).toBe(`${CODEX_EXEC} 'p'`);
    expect(buildAgentCommand("cursor", "p", SETTINGS, o)).toBe(`cursor-agent -p 'p'`);
    expect(buildAgentCommand("gemini", "p", SETTINGS, o)).toBe(`gemini -p 'p'`);
    expect(buildAgentCommand("opencode", "p", SETTINGS, o)).toBe(`opencode run 'p'`);
  });

  it("interactive mode is the default and matches the legacy shape", () => {
    expect(buildAgentCommand("claude-code", "p", SETTINGS, { mode: "interactive" })).toBe(
      buildAgentCommand("claude-code", "p", SETTINGS),
    );
  });

  it("resume passes the session id as a quoted argv element and is interactive by default", () => {
    expect(
      buildAgentCommand("claude-code", undefined, SETTINGS, { resumeSessionId: "abc-123" }),
    ).toBe(`${CLAUDE} --resume 'abc-123'`);
    expect(buildAgentCommand("codex", undefined, SETTINGS, { resumeSessionId: "x'y" })).toBe(
      `codex resume --dangerously-bypass-approvals-and-sandbox 'x'\\''y'`,
    );
  });

  it("headless resume is one-shot for Claude Code and Codex", () => {
    // A local Repo Task resuming after review feedback: run the turn, then exit.
    expect(
      buildAgentCommand("claude-code", "fix CI", SETTINGS, {
        mode: "headless",
        resumeSessionId: "abc-123",
      }),
    ).toBe(`${CLAUDE} -p --resume 'abc-123' 'fix CI'`);
    // A headless local task resuming after review feedback must still exit when done.
    expect(
      buildAgentCommand("codex", "fix CI", SETTINGS, { mode: "headless", resumeSessionId: "s1" }),
    ).toBe(`codex exec resume --dangerously-bypass-approvals-and-sandbox 's1' 'fix CI'`);
  });

  it("passes a model override as a quoted flag per CLI", () => {
    const o = { model: "opus" };
    expect(buildAgentCommand("claude-code", "p", SETTINGS, o)).toBe(`${CLAUDE} --model 'opus' 'p'`);
    expect(buildAgentCommand("codex", "p", SETTINGS, { ...o, mode: "headless" })).toBe(
      `${CODEX_EXEC} -m 'opus' 'p'`,
    );
    expect(buildAgentCommand("cursor", "p", SETTINGS, o)).toBe(`cursor-agent --model 'opus' 'p'`);
    expect(buildAgentCommand("gemini", "p", SETTINGS, o)).toBe(`gemini -m 'opus' -i 'p'`);
    expect(buildAgentCommand("opencode", "p", SETTINGS, o)).toBe(
      `opencode --model 'opus' --prompt 'p'`,
    );
    // Model names are shell-quoted like every other untrusted value.
    expect(buildAgentCommand("claude-code", undefined, SETTINGS, { model: "x; rm -rf /" })).toBe(
      `${CLAUDE} --model 'x; rm -rf /'`,
    );
  });
});

describe("buildAgentCommand permissions and effort", () => {
  it("launches Claude Code with --dangerously-skip-permissions by default, headless too", () => {
    expect(buildAgentCommand("claude-code", "p", SETTINGS, { mode: "headless" })).toBe(
      `${CLAUDE} -p 'p'`,
    );
  });

  it("runs Claude's classifier in auto mode, or asks first, when told to", () => {
    expect(buildAgentCommand("claude-code", "p", SETTINGS, { permissionMode: "auto" })).toBe(
      `claude --settings '${SETTINGS}' --permission-mode auto 'p'`,
    );
    expect(buildAgentCommand("claude-code", "p", SETTINGS, { permissionMode: "default" })).toBe(
      `claude --settings '${SETTINGS}' --permission-mode default 'p'`,
    );
  });

  it("treats an unknown permission mode as skipping checks", () => {
    expect(
      buildAgentCommand("claude-code", "p", SETTINGS, { permissionMode: "yolo" as never }),
    ).toBe(`${CLAUDE} 'p'`);
  });

  it("leaves out a mode or --effort the machine's claude doesn't take", () => {
    const old = {
      permissionModes: ["acceptEdits", "bypassPermissions", "default", "plan"],
      effort: false,
    };
    // Auto mode isn't there: start in its own default rather than refuse to start.
    expect(
      buildAgentCommand("claude-code", "p", SETTINGS, {
        claudeCaps: old,
        effort: "high",
        permissionMode: "auto",
      }),
    ).toBe(`claude --settings '${SETTINGS}' 'p'`);
    // Skipping checks is the long-standing flag and always passes.
    expect(
      buildAgentCommand("claude-code", "p", SETTINGS, {
        claudeCaps: old,
        permissionMode: "bypassPermissions",
      }),
    ).toBe(`claude --settings '${SETTINGS}' --dangerously-skip-permissions 'p'`);
    // Help that lists no modes: pass the mode as asked.
    expect(
      buildAgentCommand("claude-code", "p", SETTINGS, {
        claudeCaps: { permissionModes: null, effort: true },
        permissionMode: "auto",
      }),
    ).toBe(`claude --settings '${SETTINGS}' --permission-mode auto 'p'`);
  });

  it("passes the effort to Claude Code and Codex", () => {
    expect(buildAgentCommand("claude-code", "p", SETTINGS, { effort: "high", model: "opus" })).toBe(
      `${CLAUDE} --model 'opus' --effort 'high' 'p'`,
    );
    expect(
      buildAgentCommand("codex", "p", SETTINGS, { effort: "xhigh", model: "gpt-5.6-sol" }),
    ).toBe(`${CODEX} -m 'gpt-5.6-sol' -c 'model_reasoning_effort="xhigh"' 'p'`);
    expect(buildAgentCommand("codex", "p", SETTINGS, { effort: "low", mode: "headless" })).toBe(
      `${CODEX_EXEC} -c 'model_reasoning_effort="low"' 'p'`,
    );
    expect(
      buildAgentCommand("codex", undefined, SETTINGS, { effort: "max", resumeSessionId: "s" }),
    ).toBe(
      `codex resume --dangerously-bypass-approvals-and-sandbox -c 'model_reasoning_effort="max"' 's'`,
    );
  });

  it("drops an effort that isn't a plain word", () => {
    expect(buildAgentCommand("codex", "p", SETTINGS, { effort: 'high" foo="bar' })).toBe(
      `${CODEX} 'p'`,
    );
    expect(buildAgentCommand("claude-code", "p", SETTINGS, { effort: "$(id)" })).toBe(
      `${CLAUDE} 'p'`,
    );
  });

  it("skips Codex's approvals and sandbox (--yolo) unless told otherwise", () => {
    const yolo = { permissionMode: "bypassPermissions" as const };
    expect(buildAgentCommand("codex", "p", SETTINGS, yolo)).toBe(
      `codex --dangerously-bypass-approvals-and-sandbox 'p'`,
    );
    expect(buildAgentCommand("codex", "p", SETTINGS)).toBe(
      `codex --dangerously-bypass-approvals-and-sandbox 'p'`,
    );
    expect(buildAgentCommand("codex", "p", SETTINGS, { ...yolo, mode: "headless" })).toBe(
      `codex exec --dangerously-bypass-approvals-and-sandbox 'p'`,
    );
    // A resumed session runs the way it started.
    expect(
      buildAgentCommand("codex", undefined, SETTINGS, {
        ...yolo,
        model: "gpt-5.6-sol",
        resumeSessionId: "s",
      }),
    ).toBe(`codex resume --dangerously-bypass-approvals-and-sandbox -m 'gpt-5.6-sol' 's'`);
    // auto keeps Codex's workspace-write sandbox; default leaves its own config alone.
    expect(buildAgentCommand("codex", "p", SETTINGS, { permissionMode: "auto" })).toBe(
      `codex -c 'sandbox_mode="workspace-write"' 'p'`,
    );
    expect(buildAgentCommand("codex", "p", SETTINGS, { permissionMode: "default" })).toBe(
      `codex 'p'`,
    );
  });

  it("ignores permission mode and effort for the other CLIs", () => {
    const o = { permissionMode: "bypassPermissions" as const, effort: "high" };
    expect(buildAgentCommand("cursor", "p", SETTINGS, o)).toBe(`cursor-agent 'p'`);
    expect(buildAgentCommand("gemini", "p", SETTINGS, o)).toBe(`gemini -i 'p'`);
  });
});
