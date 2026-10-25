import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (p) => readFileSync(join(root, p), "utf8");
// Execute the Dockerfiles' actual shell branches with download/install commands
// replaced by functions. Nothing downloads or writes outside the fixture.
const runs = (file) =>
  read(file)
    .replace(/\\\n/g, " ")
    .split("\n")
    .filter((s) => s.startsWith("RUN "))
    .map((s) => s.slice(4));
function installs(file, overrides = {}) {
  const defaults = Object.fromEntries(
    [...read(file).matchAll(/^ARG (\w+)=(.*)$/gm)].map((m) => [m[1], m[2]]),
  );
  const commands = runs(file).filter(
    (s) => s.startsWith("case ") || s.includes('"$PREINSTALL_MCP_SERVERS"'),
  );
  const stub = `npm() { printf 'npm %s\\n' "$*"; }
curl() { printf 'curl %s\\n' "$*" >&2; printf ':\\n'; }
pi() { :; }
codex() { printf '%s\\n' --dangerously-bypass-approvals-and-sandbox; }
readlink() { printf '/tmp/optio/cursor-agent\\n'; }
mv() { :; }; rm() { :; }; mkdir() { :; }; cp() { :; }; ln() { :; }
`;
  const r = spawnSync("sh", ["-ec", stub + commands.join("\n")], {
    env: { ...process.env, ...defaults, ...overrides },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout + r.stderr;
}

describe("selfhost images", () => {
  it("defaults to every upstream runtime and the Claude compatibility pin", () => {
    const out = installs("images/base.Dockerfile");
    for (const pkg of [
      "@anthropic-ai/claude-code@2.1.112",
      "@openai/codex",
      "@earendil-works/pi-coding-agent@1.4.0",
      "@github/copilot@1.0.20",
      "@google/gemini-cli",
      "openclaw",
      "https://cursor.com/install",
      "https://opencode.ai/install",
    ])
      assert.ok(out.includes(pkg), pkg);
    assert.ok(!out.includes("@modelcontextprotocol/"));
    assert.match(read("images/base.Dockerfile"), /git curl wget jq unzip tmux tini/);
    assert.match(read("images/base.Dockerfile"), /awscli.amazonaws.com/);
  });
  it("selects only requested runtimes, preserves an alternate Claude pin and npm OpenCode", () => {
    const out = installs("images/base.Dockerfile", {
      AGENT_CLIS: "claude-code,opencode",
      CLAUDE_CODE_VERSION: "2.1.308",
      OPENCODE_INSTALL_METHOD: "npm",
    });
    assert.match(out, /@anthropic-ai\/claude-code@2\.1\.308/);
    assert.match(out, /opencode-ai@1\.14\.20/);
    for (const absent of [
      "@openai/codex",
      "@earendil-works/pi-coding-agent@1.4.0",
      "@github/copilot",
      "@google/gemini-cli",
      "https://cursor.com",
      "https://opencode.ai",
    ])
      assert.ok(!out.includes(absent), absent);
  });
  it("installs the pinned MCP binaries only on request", () => {
    assert.match(
      installs("images/base.Dockerfile", { PREINSTALL_MCP_SERVERS: "1" }),
      /@modelcontextprotocol\/server-postgres@0\.6\.2 @modelcontextprotocol\/server-filesystem@2026\.8\.31/,
    );
    assert.match(
      read("images/base.Dockerfile"),
      /ENV OPTIO_MCP_PREINSTALLED=\$\{PREINSTALL_MCP_SERVERS\}/,
    );
  });
  for (const file of ["Dockerfile.api", "Dockerfile.agent"]) {
    it(`${file} includes Codex by default and supports selecting Claude alone`, () => {
      assert.match(installs(file), /@openai\/codex/);
      assert.match(
        installs(file),
        file === "Dockerfile.agent"
          ? /@anthropic-ai\/claude-code(?:\n|$)/
          : /@anthropic-ai\/claude-code@2\.1\.112/,
      );
      assert.match(
        installs(file, { AGENT_CLIS: "claude-code", CLAUDE_CODE_VERSION: "2.1.308" }),
        /@anthropic-ai\/claude-code@2\.1\.308/,
      );
      assert.doesNotMatch(installs(file, { AGENT_CLIS: "claude-code" }), /@openai\/codex/);
    });
  }
  it("keeps all Docker RUN instructions syntactically valid", () => {
    for (const file of [
      "Dockerfile.api",
      "Dockerfile.agent",
      "Dockerfile.web",
      "images/base.Dockerfile",
      "images/dind.Dockerfile",
    ]) {
      assert.doesNotMatch(read(file), /OPTIO_PROFILE/);
      for (const command of runs(file)) {
        const shell = command.replace(/^(?:--mount=\S+\s+)+/, "");
        const r = spawnSync("sh", ["-n", "-c", shell], { encoding: "utf8" });
        assert.equal(r.status, 0, `${file}: ${r.stderr}`);
      }
    }
  });
});
