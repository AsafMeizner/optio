import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (p) => readFileSync(join(root, p), "utf8");
const temps = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "optio-selfhost-"));
  temps.push(dir);
  return dir;
};
afterEach(() => temps.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

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

describe("selfhost offline builder", () => {
  function build(options) {
    const dir = temp();
    const log = join(dir, "calls");
    const docker = join(dir, "docker");
    writeFileSync(
      docker,
      `#!/bin/sh
printf '%s\\n' "$*" >> "$LOG"
[ "$1 $2 $3" = 'buildx version ' ] && exit 0
if [ "$1 $2 $3" = 'image inspect --format' ]; then
  printf 'sha256:fixture|1000000\\n'
  exit 0
fi
if [ "$1 $2" = 'buildx build' ]; then
  while [ $# -gt 0 ]; do
    if [ "$1" = --metadata-file ]; then shift; printf '{}' > "$1"; fi
    shift
  done
  exit 0
fi
exit 1
`,
    );
    chmodSync(docker, 0o755);
    const r = spawnSync(
      "bash",
      [join(root, "scripts/offline/build-images.sh"), "1.0.0", "--only", "web", ...options],
      {
        cwd: root,
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, LOG: log, BUILDKIT_HOST: "" },
        encoding: "utf8",
      },
    );
    assert.equal(r.status, 0, r.stdout + r.stderr);
    return readFileSync(log, "utf8");
  }
  it("normal builds keep network downloads and Google fonts", () => {
    const out = build([]);
    assert.match(out, /AGENT_CLIS=all/);
    assert.match(out, /OPTIO_OFFLINE_FONTS=0/);
    assert.doesNotMatch(out, /--network none|PNPM_OFFLINE=1|--build-context/);
  });
  it("offline builds use mirror bases, the pnpm context and local fonts without network", () => {
    const out = build(["--offline", "--registry", "registry.example.com/optio"]);
    for (const arg of [
      "--network none",
      "PNPM_OFFLINE=1",
      "OPTIO_OFFLINE_FONTS=1",
      "NODE_SLIM_IMAGE=registry.example.com/optio/base/node:26-slim-1.0.0",
      "pnpm-offline=docker-image://registry.example.com/optio/build/pnpm-offline:1.0.0",
    ])
      assert.ok(out.includes(arg), arg);
  });
});

describe("offline dependency installation", () => {
  for (const file of [
    "Dockerfile.api",
    "Dockerfile.web",
    "Dockerfile.agent",
    "images/base.Dockerfile",
  ]) {
    it(`${file} uses the pinned npm install normally and the transferred archive offline`, () => {
      const commands = runs(file)
        .filter((command) => command.includes('"$PNPM_OFFLINE"'))
        .map((command) => command.replace(/^(?:--mount=\S+\s+)+/, ""));
      const stub = ["npm", "pnpm", "tar", "mkdir", "ln"]
        .map((name) => `${name}() { printf '%s\\n' '${name}' "$*"; }`)
        .join("\n");
      const run = (flag) => {
        const result = spawnSync("sh", ["-ec", stub + "\n" + commands.join("\n")], {
          encoding: "utf8",
          env: { ...process.env, PNPM_OFFLINE: flag },
        });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout;
      };
      const normal = run("0");
      assert.match(normal, /install -g pnpm@10\.34\.8/);
      assert.doesNotMatch(normal, /--offline|--strip-components/);
      const offline = run("1");
      assert.match(offline, /--strip-components=2/);
      assert.match(offline, /--offline --store-dir \/pnpm-offline\/store/);
      assert.doesNotMatch(offline, /^npm$/m);
    });
  }
});
