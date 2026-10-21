import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProcessContainerRuntime, PROCESS_HANDLE } from "./process.js";
import { RunStdinClosedError, STDIN_EOF_SENTINEL } from "./run-protocol.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "optio-process-rt-"));
  dirs.push(d);
  return d;
}

async function read(stream: NodeJS.ReadableStream): Promise<string> {
  let out = "";
  for await (const chunk of stream) out += chunk.toString();
  return out;
}

describe("ProcessContainerRuntime", () => {
  it("runs the script as a child, feeds stdin up to the EOF sentinel, and records the run's files", async () => {
    const rt = new ProcessContainerRuntime();
    const runDir = join(tmp(), "run-1");
    // Echo each stdin line as a JSON event, like a harness in stream-json mode.
    const script = `echo '{"type":"system","subtype":"init"}'\nwhile IFS= read -r line; do echo "{\\"got\\":\\"$line\\"}"; done`;
    const started = await rt.startRun(PROCESS_HANDLE, {
      runId: "run-1",
      runDir,
      script,
      initialStdin: `first\nsecond\n${STDIN_EOF_SENTINEL}\n`,
    });
    expect(started.pid).toBeGreaterThan(0);
    const attached = await rt.attachRun(PROCESS_HANDLE, { runId: "run-1", runDir, fromByte: 0 });
    const output = await read(attached.output);
    expect(await attached.exit).toEqual({ kind: "exited", code: 0 });
    expect(output.split("\n").filter(Boolean)).toEqual([
      '{"type":"system","subtype":"init"}',
      '{"got":"first"}',
      '{"got":"second"}',
    ]);
    expect(readFileSync(join(runDir, "output.ndjson"), "utf8")).toBe(output);
    expect(readFileSync(join(runDir, "exit"), "utf8").trim()).toBe("0");
    expect(readFileSync(join(runDir, "stdin.ndjson"), "utf8")).toContain(STDIN_EOF_SENTINEL);
    // Delivering to a closed stdin is refused, as the pod protocol does.
    await expect(
      rt.deliverStdin(PROCESS_HANDLE, { runId: "run-1", runDir, line: "late" }),
    ).rejects.toBeInstanceOf(RunStdinClosedError);
  });

  it("attaches from a byte offset to a live run, delivers stdin later, and kills the process group", async () => {
    const rt = new ProcessContainerRuntime();
    const runDir = join(tmp(), "run-2");
    const script = `echo hello\nwhile IFS= read -r line; do echo "got $line"; done\nsleep 30`;
    await rt.startRun(PROCESS_HANDLE, { runId: "run-2", runDir, script, initialStdin: "" });
    // Wait for the first line to land, then attach past it.
    await new Promise((r) => setTimeout(r, 300));
    const attached = await rt.attachRun(PROCESS_HANDLE, { runId: "run-2", runDir, fromByte: 6 });
    const chunks: string[] = [];
    attached.output.on("data", (c: Buffer) => chunks.push(c.toString()));
    await rt.deliverStdin(PROCESS_HANDLE, { runId: "run-2", runDir, line: "one" });
    await new Promise((r) => setTimeout(r, 300));
    expect(chunks.join("")).toBe("got one\n");
    await rt.deliverStdin(PROCESS_HANDLE, { runId: "run-2", runDir, line: STDIN_EOF_SENTINEL });
    // The loop ends on EOF and the script sleeps: kill the group.
    await new Promise((r) => setTimeout(r, 200));
    expect(await rt.killRun(PROCESS_HANDLE, { runId: "run-2", runDir, signal: "TERM" })).toBe(true);
    const exit = await attached.exit;
    expect(exit.kind).toBe("exited");
    expect(rt.liveRunIds()).toEqual([]);
    // A later attach, with no live run, finds the recorded exit.
    const again = await rt.attachRun(PROCESS_HANDLE, { runId: "run-2", runDir, fromByte: 0 });
    expect((await read(again.output)).startsWith("hello\n")).toBe(true);
    expect((await again.exit).kind).toBe("exited");
  });

  it("reports a run it never started as lost, and refuses a bad run directory", async () => {
    const rt = new ProcessContainerRuntime();
    const runDir = join(tmp(), "never");
    const attached = await rt.attachRun(PROCESS_HANDLE, { runId: "never", runDir, fromByte: 0 });
    expect(await read(attached.output)).toBe("");
    expect(await attached.exit).toEqual({ kind: "lost" });
    expect(await rt.killRun(PROCESS_HANDLE, { runId: "never", runDir, signal: "KILL" })).toBe(
      false,
    );
    await expect(
      rt.startRun(PROCESS_HANDLE, {
        runId: "x",
        runDir: "../etc",
        script: "true",
        initialStdin: "",
      }),
    ).rejects.toThrow(/Invalid run directory/);
  });
});
