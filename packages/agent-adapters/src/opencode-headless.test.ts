import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentTaskInput } from "@optio/shared";
import { OpenCodeAdapter } from "./opencode.js";
import {
  OPENCODE_AUTO_APPROVE_FLAG,
  OPENCODE_GLOBAL_AGENTS_MD,
  OPENCODE_GLOBAL_AGENTS_MD_PATH,
  opencodeHeadlessEnabled,
  opencodeHeadlessPermission,
} from "./opencode-headless.js";

// Upstream PR #585: a headless `opencode run` aborted with exit 1 when its
// external_directory ask (a venv under /tmp) had nobody to answer it.
const input: AgentTaskInput = {
  taskId: "t1",
  prompt: "Fix it",
  repoUrl: "https://gitlab.example.com/platform/my.service",
  repoBranch: "main",
};

type PermissionConfig = ReturnType<typeof opencodeHeadlessPermission>;

// OpenCode v1.14.20 merges defaults, built-in agent rules, then user config.
// Its evaluator selects the last rule matching both permission and path:
// https://github.com/anomalyco/opencode/blob/v1.14.20/packages/opencode/src/permission/evaluate.ts
function effectivePermission(permission: string, path: string, ...configs: PermissionConfig[]) {
  const matches = (value: string, pattern: string) =>
    new RegExp(
      `^${pattern
        .split(/\*+/)
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*")}$`,
    ).test(value);
  const rules = configs.flatMap((config) =>
    Object.entries(config).flatMap(([name, value]) =>
      Object.entries(typeof value === "string" ? { "*": value } : value).map(
        ([pattern, action]) => ({ name, pattern, action }),
      ),
    ),
  );
  return (
    rules.reverse().find((rule) => matches(permission, rule.name) && matches(path, rule.pattern))
      ?.action ?? "ask"
  );
}

describe("OpenCode headless permissions", () => {
  it("only overrides questions, outside paths and system packages", () => {
    expect(opencodeHeadlessPermission()).toEqual({
      question: "deny",
      bash: { "sudo *": "deny", "apt *": "deny", "apt-get *": "deny", "dpkg *": "deny" },
      external_directory: {
        "*": "deny",
        "/home/agent/.local/share/opencode/tool-output/**": "allow",
      },
    });
  });

  it("gives every call a fresh object (callers may merge into it)", () => {
    const a = opencodeHeadlessPermission();
    (a.bash as Record<string, string>)["rm *"] = "deny";
    expect(opencodeHeadlessPermission().bash).not.toHaveProperty("rm *");
  });

  it.each([
    ["plan", { edit: { "*": "deny", ".opencode/plans/*.md": "allow" } }],
    ["explore", { "*": "deny", read: "allow", grep: "allow", bash: "allow" }],
  ] satisfies [string, PermissionConfig][])(
    "preserves %s's denial of ordinary edits",
    (_, builtIn) => {
      expect(
        effectivePermission(
          "edit",
          "src/auth.ts",
          { "*": "allow" },
          builtIn,
          opencodeHeadlessPermission(),
        ),
      ).toBe("deny");
    },
  );

  it("auto-approves asks without replacing explicit built-in denials", () => {
    expect(
      effectivePermission("custom_tool", "input", { "*": "ask" }, opencodeHeadlessPermission()),
    ).toBe("ask");
    expect(OPENCODE_AUTO_APPROVE_FLAG).toBe("--dangerously-skip-permissions");
  });

  it("allows truncated tool output while denying sibling credentials and session state", () => {
    for (const path of [
      "/home/agent/.local/share/opencode/auth.json",
      "/home/agent/.local/share/opencode/storage/session/secret.json",
      "/home/agent/.local/share/opencode/tool-output-other/output.txt",
    ]) {
      expect(effectivePermission("external_directory", path, opencodeHeadlessPermission())).toBe(
        "deny",
      );
    }
    expect(
      effectivePermission(
        "external_directory",
        "/home/agent/.local/share/opencode/tool-output/tool_123",
        opencodeHeadlessPermission(),
      ),
    ).toBe("allow");
  });

  it("is the flag OpenCode 1.14.20 calls auto-approve", () => {
    expect(OPENCODE_AUTO_APPROVE_FLAG).toBe("--dangerously-skip-permissions");
  });
});

describe("OpenCodeAdapter pre-seeded config", () => {
  const files = () => new OpenCodeAdapter().buildContainerConfig(input).setupFiles ?? [];

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("writes nothing of them unless the deployment turns them on (upstream's file)", () => {
    expect(opencodeHeadlessEnabled()).toBe(false);
    const config = files().find((f) => f.path === "/home/agent/.config/opencode/opencode.json");
    expect(JSON.parse(config!.content)).toEqual({ $schema: "https://opencode.ai/config.json" });
    expect(files().some((f) => f.path === OPENCODE_GLOBAL_AGENTS_MD_PATH)).toBe(false);
  });

  it("writes the permissions into the global opencode.json", () => {
    vi.stubEnv("OPTIO_OPENCODE_HEADLESS", "true");
    const config = files().find((f) => f.path === "/home/agent/.config/opencode/opencode.json");
    expect(config).toBeDefined();
    expect(JSON.parse(config!.content)).toEqual({
      $schema: "https://opencode.ai/config.json",
      permission: opencodeHeadlessPermission(),
    });
  });

  it("writes the global AGENTS.md with the headless rules", () => {
    vi.stubEnv("OPTIO_OPENCODE_HEADLESS", "true");
    const rules = files().find((f) => f.path === OPENCODE_GLOBAL_AGENTS_MD_PATH);
    expect(rules?.content).toBe(OPENCODE_GLOBAL_AGENTS_MD);
    expect(rules?.content).toMatch(/Never ask one/);
    expect(rules?.content).toMatch(/Stay inside the workspace/);
    expect(rules?.content).toMatch(/No sudo/);
  });
});
