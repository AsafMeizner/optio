/**
 * The protocol scripts, run for real: start a supervisor with bash, attach
 * with `tail --pid`, deliver stdin over the exec's stdin, close it with the
 * sentinel, read the exit, kill a hanging run, and refuse a stale pid file.
 * Needs GNU coreutils, util-linux (`setsid`) and /proc, so it runs on Linux
 * (CI) and skips on macOS, where the Docker check in docs/plans/scale-out.md
 * covers the same ground.
 */
import { describe, expect, it } from "vitest";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RUN_FILES,
  STDIN_DELIVERED_MARKER,
  STDIN_EOF_SENTINEL,
  attachRunScript,
  deliverStdinScript,
  killRunScript,
  startRunPrelude,
  superviseAgent,
} from "./run-protocol.js";

function hasGnuTools(): boolean {
  if (process.platform !== "linux") return false;
  const tail = spawnSync("tail", ["--version"], { encoding: "utf8" });
  const setsid = spawnSync("setsid", ["--version"], { encoding: "utf8" });
  return tail.status === 0 && /GNU coreutils/.test(tail.stdout) && setsid.status === 0;
}

const describeLinux = hasGnuTools() ? describe : describe.skip;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs a script with bash, feeding `input` on stdin, returning stdout. */
function bash(script: string, input: Buffer | string = ""): string {
  return execFileSync("bash", ["-c", script], {
    encoding: "utf8",
    input,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/** The start script as the runtime runs it: prelude + script, stdin bytes fed. */
function start(runDir: string, agent: string[], initialStdin: string, opts = {}): number {
  const bytes = Buffer.from(initialStdin, "utf8");
  const script = [
    ...startRunPrelude(bytes.length),
    "set -e",
    ...superviseAgent(runDir, agent, opts),
  ].join("\n");
  const out = bash(script, bytes);
  const pid = Number(out.match(/__OPTIO_RUN_STARTED__:(\d+)/)?.[1]);
  expect(pid).toBeGreaterThan(0);
  return pid;
}

function deliver(runDir: string, line: string): void {
  const bytes = Buffer.from(`${line}\n`, "utf8");
  const out = bash(deliverStdinScript(runDir, bytes.length), bytes);
  expect(out).toContain(STDIN_DELIVERED_MARKER);
}

/** Runs the attach script, resolving with stdout, stderr once it ends. */
function attach(script: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-c", script], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("error", reject);
    child.on("close", () => resolve({ stdout, stderr }));
  });
}

const ECHO_AGENT = [
  "n=0",
  `while IFS= read -r l; do n=$((n+1)); printf '{"len":%d,"n":%d}\\n' "\${#l}" "$n"; done`,
  `printf '{"done":true,"n":%d}\\n' "$n"`,
  "exit 7",
];

describeLinux("the run protocol scripts under bash", () => {
  it("starts a detached agent, streams its output, feeds stdin until the sentinel, records its exit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "optio-proto-"));
    const runDir = join(dir, "run");
    try {
      const pid = start(runDir, ECHO_AGENT, '{"first":true}\n');
      const [filePid, startTime] = readFileSync(join(runDir, RUN_FILES.pid), "utf8")
        .trim()
        .split(" ");
      expect(Number(filePid)).toBe(pid);
      expect(startTime).toMatch(/^\d+$/);

      const attached = attach(attachRunScript(runDir, 0));
      await sleep(300);
      deliver(runDir, '{"msg":"second"}');
      await sleep(300);
      const sentAt = Date.now();
      deliver(runDir, STDIN_EOF_SENTINEL);
      const { stdout, stderr } = await attached;
      // The sentinel closes the agent's stdin at once.
      expect(Date.now() - sentAt).toBeLessThan(3_000);
      expect(stdout).toBe('{"len":14,"n":1}\n{"len":16,"n":2}\n{"done":true,"n":2}\n');
      expect(stderr.trim()).toBe("__OPTIO_RUN_EXIT__:7");
      expect(readFileSync(join(runDir, RUN_FILES.exit), "utf8").trim()).toBe("7");

      // A second attach from an offset replays exactly the rest.
      const offset = stdout.indexOf("\n") + 1;
      const again = await attach(attachRunScript(runDir, offset));
      expect(again.stdout).toBe(stdout.slice(offset));
      expect(again.stderr.trim()).toBe("__OPTIO_RUN_EXIT__:7");

      // Nothing of the run is left running.
      await sleep(1500);
      expect(spawnSync("kill", ["-0", String(pid)]).status).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("carries a 300 KB first message and a 200 KB delivered line byte-exact", async () => {
    const dir = mkdtempSync(join(tmpdir(), "optio-proto-"));
    const runDir = join(dir, "run");
    try {
      const big = `{"big":"${"x".repeat(300_000)}"}`;
      start(runDir, ECHO_AGENT, `${big}\n`);
      const attached = attach(attachRunScript(runDir, 0));
      await sleep(300);
      const line = `{"d":"${"é".repeat(100_000)}"}`; // 200 KB of UTF-8, 100 K characters
      deliver(runDir, line);
      await sleep(500);
      deliver(runDir, STDIN_EOF_SENTINEL);
      const { stdout, stderr } = await attached;
      expect(stderr.trim()).toBe("__OPTIO_RUN_EXIT__:7");
      expect(stdout).toBe(
        `{"len":${big.length},"n":1}\n{"len":${line.length},"n":2}\n{"done":true,"n":2}\n`,
      );
      expect(readFileSync(join(runDir, RUN_FILES.stdin), "utf8")).toBe(
        `${big}\n${line}\n${STDIN_EOF_SENTINEL}\n`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("kills a hanging run's whole process group and records 143; a SIGKILLed supervisor is lost", async () => {
    const dir = mkdtempSync(join(tmpdir(), "optio-proto-"));
    const runDir = join(dir, "run");
    try {
      const pid = start(runDir, ["echo '{\"init\":1}'", "sleep 1000"], "");
      const attached = attach(attachRunScript(runDir, 0));
      await sleep(300);
      expect(bash(killRunScript(runDir, "TERM")).trim()).toBe("killed");
      const { stdout, stderr } = await attached;
      expect(stdout).toBe('{"init":1}\n');
      expect(stderr.trim()).toBe("__OPTIO_RUN_EXIT__:143");
      expect(bash(killRunScript(runDir, "TERM")).trim()).toBe("none");
      await sleep(200);
      expect(spawnSync("pgrep", ["-f", "sleep 1000"]).status).not.toBe(0);
      expect(spawnSync("kill", ["-0", String(pid)]).status).not.toBe(0);

      rmSync(runDir, { recursive: true, force: true });
      const pid2 = start(runDir, ["echo '{\"init\":1}'", "sleep 1000"], "");
      execFileSync("kill", ["-KILL", "--", `-${pid2}`]);
      await sleep(300);
      const lost = await attach(attachRunScript(runDir, 0));
      expect(lost.stderr.trim()).toBe("__OPTIO_RUN_LOST__");
      expect(existsSync(join(runDir, RUN_FILES.exit))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("a fresh start in the same run directory stops a previous attempt's supervisor first", async () => {
    const dir = mkdtempSync(join(tmpdir(), "optio-proto-"));
    const runDir = join(dir, "run");
    try {
      // An attempt whose starter went away before it was recorded: still alive.
      const stale = start(runDir, ["echo '{\"stale\":1}'", "sleep 1000"], "");
      expect(spawnSync("kill", ["-0", String(stale)]).status).toBe(0);
      // The next attempt stops it (and its agent) before truncating the output.
      const fresh = start(runDir, ECHO_AGENT, "only\n");
      expect(fresh).not.toBe(stale);
      await sleep(200);
      expect(spawnSync("kill", ["-0", String(stale)]).status).not.toBe(0);
      expect(spawnSync("pgrep", ["-f", "sleep 1000"]).status).not.toBe(0);
      const attached = attach(attachRunScript(runDir, 0));
      deliver(runDir, STDIN_EOF_SENTINEL);
      const { stdout, stderr } = await attached;
      // Only the fresh attempt's output: one run directory, one agent.
      expect(stdout).toBe('{"len":4,"n":1}\n{"done":true,"n":1}\n');
      expect(stderr.trim()).toBe("__OPTIO_RUN_EXIT__:7");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("a pid file naming a live process with another start time is a dead run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "optio-proto-"));
    const runDir = join(dir, "run");
    try {
      start(runDir, ["echo '{\"init\":1}'", "sleep 1000"], "");
      const pid = Number(readFileSync(join(runDir, RUN_FILES.pid), "utf8").split(" ")[0]);
      // Pretend the pid was reused after a pod restart: same pid, other start time.
      writeFileSync(join(runDir, RUN_FILES.pid), `${pid} 1\n`);
      expect(bash(killRunScript(runDir, "TERM")).trim()).toBe("none");
      const lost = await attach(attachRunScript(runDir, 0));
      expect(lost.stdout).toBe('{"init":1}\n');
      expect(lost.stderr.trim()).toBe("__OPTIO_RUN_LOST__");
      // The real process is still there: end it.
      execFileSync("kill", ["-KILL", "--", `-${pid}`]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("a zero exit is recorded as 0", async () => {
    const dir = mkdtempSync(join(tmpdir(), "optio-proto-"));
    const runDir = join(dir, "run");
    try {
      start(runDir, ["cat >/dev/null", "exit 0"], `${STDIN_EOF_SENTINEL}\n`, {
        markEnvReady: true,
      });
      const { stderr } = await attach(attachRunScript(runDir, 0));
      expect(stderr.trim()).toBe("__OPTIO_RUN_EXIT__:0");
      expect(readFileSync(join(runDir, RUN_FILES.exit), "utf8").trim()).toBe("0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
