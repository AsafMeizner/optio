/**
 * The one attach loop (run-attachment.ts): byte-exact offsets, replay from
 * byte 0 feeding the derivations without storing anything, the lease's
 * renew-or-lose, and shutdown's detach.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Readable } from "node:stream";
import type { ContainerRuntime, RunAttachment, RunExit } from "@optio/container-runtime";

const mockAppend = vi.fn();
const mockUpdateReturning = vi.fn();
const mockUpdateSet = vi.fn();

vi.mock("../db/client.js", () => {
  const chain = {
    set: (values: unknown) => {
      mockUpdateSet(values);
      return chain;
    },
    where: () => chain,
    returning: () => mockUpdateReturning(),
  };
  return { db: { update: () => chain } };
});

vi.mock("./run-log-service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./run-log-service.js")>();
  return { ...actual, appendRunLogsBatch: (...args: unknown[]) => mockAppend(...args) };
});

const mockGetPod = vi.fn();
const mockKillRun = vi.fn();
vi.mock("./agent-pod-pool.js", () => ({
  getPod: (...args: unknown[]) => mockGetPod(...args),
  podHandle: (pod: { podId: string | null; podName: string }) => ({
    id: pod.podId ?? pod.podName,
    name: pod.podName,
  }),
}));
vi.mock("./container-service.js", () => ({
  getRuntime: () => ({ killRun: (...args: unknown[]) => mockKillRun(...args) }),
}));

vi.mock("../logger.js", () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { logger: { ...log, child: () => log } };
});

import {
  AttachmentLostError,
  LineSplitter,
  detachAll,
  heldRunCount,
  signalRun,
  startHold,
  streamRun,
  type ParsedRunLine,
  ATTACH_RENEW_MS,
} from "./run-attachment.js";

const ref = { kind: "work-run" as const, id: "run-1" };

/** A runtime whose attach plays `chunks` from byte 0 and then exits. */
function fakeRuntime(chunks: Buffer[], exit: RunExit = { kind: "exited", code: 0 }) {
  const delivered: string[] = [];
  let closed = false;
  const runtime = {
    attachRun: vi.fn(async (): Promise<RunAttachment> => {
      const output = Readable.from(chunks);
      let finished: () => void = () => {};
      const ended = new Promise<void>((r) => {
        finished = r;
        output.on("end", r);
        output.on("close", r);
      });
      return {
        output,
        exit: ended.then(() => (closed ? { kind: "detached", reason: "closed" } : exit)),
        close() {
          closed = true;
          output.destroy();
          finished();
        },
      };
    }),
    deliverStdin: vi.fn(async (_h: unknown, input: { line: string }) => {
      delivered.push(input.line);
    }),
  } as unknown as ContainerRuntime;
  return { runtime, delivered };
}

/** Lines as the fake agent writes them (JSON events with a seq). */
function lines(...events: Array<Record<string, unknown>>): Buffer {
  return Buffer.from(events.map((e) => JSON.stringify(e) + "\n").join(""), "utf8");
}

const parse = (line: string): ParsedRunLine => {
  const event = JSON.parse(line) as { text?: string; session?: string; terminal?: boolean };
  return {
    entries: event.text ? [{ type: "text", content: event.text } as never] : [],
    sessionId: event.session,
    isTerminal: event.terminal,
  };
};

function hold() {
  return { ref, lost: false, attachment: null, end: vi.fn() } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAppend.mockImplementation(async (_ref, entries: unknown[]) =>
    entries.map((e, i) => ({ id: `row-${i}`, ...(e as object) })),
  );
});

describe("LineSplitter", () => {
  it("counts offsets in bytes, multi-byte characters included", () => {
    const text = "héllo 🎉\nwörld\n";
    const splitter = new LineSplitter(0);
    const out = splitter.push(Buffer.from(text, "utf8"));
    expect(out).toEqual([
      { text: "héllo 🎉", end: Buffer.byteLength("héllo 🎉\n") },
      { text: "wörld", end: Buffer.byteLength(text) },
    ]);
    expect(out[1].end).toBeGreaterThan(text.length);
  });

  it("holds a partial line — and a character split across chunks — until its newline", () => {
    const bytes = Buffer.from("ab🎉cd\nnext\n", "utf8");
    const splitter = new LineSplitter(0);
    // Split inside the 4-byte emoji, and again before the newline.
    expect(splitter.push(bytes.subarray(0, 4))).toEqual([]);
    expect(splitter.push(bytes.subarray(4, 7))).toEqual([]);
    const out = splitter.push(bytes.subarray(7));
    expect(out).toEqual([
      { text: "ab🎉cd", end: Buffer.byteLength("ab🎉cd\n") },
      { text: "next", end: bytes.length },
    ]);
  });

  it("flushes an unterminated last line at the file's end", () => {
    const splitter = new LineSplitter(0);
    splitter.push(Buffer.from("one\ntwo", "utf8"));
    expect(splitter.flush()).toEqual({ text: "two", end: 7 });
    expect(splitter.flush()).toBeNull();
  });
});

describe("streamRun", () => {
  it("stores every new line with byte-exact offsets, one batch per chunk", async () => {
    const a = lines({ seq: 1, text: "héllo" }, { seq: 2, text: "🎉 done" });
    const b = lines({ seq: 3, text: "wörld" });
    const { runtime } = fakeRuntime([a, b]);
    const published: unknown[] = [];

    const result = await streamRun({
      runtime,
      handle: { id: "pod", name: "pod" },
      ref,
      runDir: "/home/agent/optio/runs/run-1",
      hold: hold(),
      consumedBytes: 0,
      parse,
      publish: async (row) => void published.push(row),
    });

    expect(result.outcome).toEqual({ kind: "exited", code: 0 });
    expect(result.consumedBytes).toBe(a.length + b.length);
    expect(mockAppend).toHaveBeenCalledTimes(2);
    expect(mockAppend.mock.calls[0][2]).toEqual({ from: 0, to: a.length });
    expect(mockAppend.mock.calls[1][2]).toEqual({ from: a.length, to: a.length + b.length });
    expect(mockAppend.mock.calls[0][1].map((e: { content: string }) => e.content)).toEqual([
      "héllo",
      "🎉 done",
    ]);
    expect(published).toHaveLength(3);
  });

  it("a partial line across chunks is stored once, when complete", async () => {
    const all = lines({ seq: 1, text: "ä".repeat(5) }, { seq: 2, text: "end" });
    const cut = 9; // inside the first line, between the bytes of an "ä"
    const { runtime } = fakeRuntime([all.subarray(0, cut), all.subarray(cut)]);
    await streamRun({
      runtime,
      handle: { id: "pod", name: "pod" },
      ref,
      runDir: "/home/agent/optio/runs/run-1",
      hold: hold(),
      consumedBytes: 0,
      parse,
      publish: async () => {},
    });
    const batches = mockAppend.mock.calls.map((c) => c[2]);
    expect(batches).toEqual([{ from: 0, to: all.length }]);
    expect(mockAppend.mock.calls[0][1].map((e: { content: string }) => e.content)).toEqual([
      "ä".repeat(5),
      "end",
    ]);
  });

  it("replays from byte 0: lines below the offset feed the derivations and are never stored", async () => {
    const before = lines({ seq: 1, session: "sess-1", text: "first" }, { seq: 2, text: "second" });
    const after = lines({ seq: 3, text: "third", terminal: true });
    const { runtime, delivered } = fakeRuntime([Buffer.concat([before, after])]);
    const derived: string[] = [];
    const onSession = vi.fn();

    const result = await streamRun({
      runtime,
      handle: { id: "pod", name: "pod" },
      ref,
      runDir: "/home/agent/optio/runs/run-1",
      hold: hold(),
      consumedBytes: before.length,
      parse,
      derive: (line) => void derived.push(line),
      onSession,
      publish: async () => {},
    });

    // Every line reached the derivations, the replayed ones too…
    expect(derived.map((l) => JSON.parse(l).seq)).toEqual([1, 2, 3]);
    // …the session id is known again, but nothing replayed is persisted.
    expect(result.sessionId).toBe("sess-1");
    expect(onSession).not.toHaveBeenCalled();
    expect(mockAppend).toHaveBeenCalledTimes(1);
    expect(mockAppend.mock.calls[0][1].map((e: { content: string }) => e.content)).toEqual([
      "third",
    ]);
    expect(mockAppend.mock.calls[0][2]).toEqual({
      from: before.length,
      to: before.length + after.length,
    });
    // The terminal event closed the agent's stdin.
    expect(delivered).toEqual(["__OPTIO_STDIN_EOF__"]);
  });

  it("a terminal event seen only in the replay still closes stdin (the last holder may have died first)", async () => {
    const all = lines({ seq: 1, text: "x", terminal: true });
    const { runtime, delivered } = fakeRuntime([all]);
    await streamRun({
      runtime,
      handle: { id: "pod", name: "pod" },
      ref,
      runDir: "/home/agent/optio/runs/run-1",
      hold: hold(),
      consumedBytes: all.length,
      parse,
      publish: async () => {},
    });
    expect(delivered).toEqual(["__OPTIO_STDIN_EOF__"]);
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it("a new session id is persisted once, from a new line", async () => {
    const { runtime } = fakeRuntime([
      lines({ seq: 1, session: "s-9" }, { seq: 2, session: "s-9", text: "again" }),
    ]);
    const onSession = vi.fn();
    await streamRun({
      runtime,
      handle: { id: "pod", name: "pod" },
      ref,
      runDir: "/home/agent/optio/runs/run-1",
      hold: hold(),
      consumedBytes: 0,
      parse,
      onSession,
      publish: async () => {},
    });
    expect(onSession).toHaveBeenCalledTimes(1);
    expect(onSession).toHaveBeenCalledWith("s-9");
  });

  it("stores an unterminated last line when the agent exits", async () => {
    const head = lines({ seq: 1, text: "a" });
    const tail = Buffer.from(JSON.stringify({ seq: 2, text: "tail" }), "utf8");
    const { runtime } = fakeRuntime([head, tail]);
    const result = await streamRun({
      runtime,
      handle: { id: "pod", name: "pod" },
      ref,
      runDir: "/home/agent/optio/runs/run-1",
      hold: hold(),
      consumedBytes: 0,
      parse,
      publish: async () => {},
    });
    expect(result.consumedBytes).toBe(head.length + tail.length);
    expect(mockAppend.mock.calls.at(-1)![2]).toEqual({
      from: head.length,
      to: head.length + tail.length,
    });
  });

  it("a commit that finds the run taken ends the stream as taken, storing nothing more", async () => {
    mockAppend.mockRejectedValueOnce(new AttachmentLostError("run-1"));
    const { runtime } = fakeRuntime([lines({ seq: 1, text: "a" }), lines({ seq: 2, text: "b" })]);
    const h = hold();
    const result = await streamRun({
      runtime,
      handle: { id: "pod", name: "pod" },
      ref,
      runDir: "/home/agent/optio/runs/run-1",
      hold: h,
      consumedBytes: 0,
      parse,
      publish: async () => {},
    });
    expect(result.outcome).toEqual({ kind: "taken" });
    expect(result.consumedBytes).toBe(0);
    expect(mockAppend).toHaveBeenCalledTimes(1);
  });

  it("a detached exit (the exec dropped) is reported as such", async () => {
    const { runtime } = fakeRuntime([lines({ seq: 1, text: "a" })], {
      kind: "detached",
      reason: "stream-ended",
    });
    const result = await streamRun({
      runtime,
      handle: { id: "pod", name: "pod" },
      ref,
      runDir: "/home/agent/optio/runs/run-1",
      hold: hold(),
      consumedBytes: 0,
      parse,
      publish: async () => {},
    });
    expect(result.outcome).toEqual({ kind: "detached", reason: "stream-ended" });
  });
});

describe("the hold: renew or lose", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("renews every ATTACH_RENEW_MS while the run is still this instance's", async () => {
    mockUpdateReturning.mockResolvedValue([{ id: "run-1" }]);
    const h = startHold(ref);
    await vi.advanceTimersByTimeAsync(ATTACH_RENEW_MS * 3);
    expect(mockUpdateReturning).toHaveBeenCalledTimes(3);
    expect(h.lost).toBe(false);
    await h.end();
  });

  it("a renewal that matches nothing means the run was taken: the stream is severed at once", async () => {
    mockUpdateReturning.mockResolvedValue([]);
    const h = startHold(ref);
    const close = vi.fn();
    h.attachment = { close };
    await vi.advanceTimersByTimeAsync(ATTACH_RENEW_MS);
    expect(h.lost).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    // A lost hold gives nothing back: the lease is someone else's.
    const writes = mockUpdateSet.mock.calls.length;
    await h.end({ release: true });
    expect(mockUpdateSet.mock.calls.length).toBe(writes);
  });

  it("shutdown severs every stream and gives every lease up now", async () => {
    mockUpdateReturning.mockResolvedValue([{ id: "x" }]);
    const a = startHold({ kind: "work-run", id: "a" });
    const b = startHold({ kind: "turn", id: "b" });
    const closeA = vi.fn();
    const closeB = vi.fn();
    a.attachment = { close: closeA };
    b.attachment = { close: closeB };
    const before = Date.now();

    expect(heldRunCount()).toBe(2);
    expect(await detachAll()).toBe(2);

    expect(closeA).toHaveBeenCalled();
    expect(closeB).toHaveBeenCalled();
    expect(heldRunCount()).toBe(0);
    const releases = mockUpdateSet.mock.calls
      .map((c) => c[0] as { attachLeaseUntil?: Date })
      .filter((v) => v.attachLeaseUntil);
    expect(releases).toHaveLength(2);
    for (const r of releases) expect(r.attachLeaseUntil!.getTime()).toBeLessThanOrEqual(before);
  });
});

describe("signalRun: any instance stops a run", () => {
  it("finds the pod from the database and signals the run directory named by the run", async () => {
    mockGetPod.mockResolvedValueOnce({ id: "pod-9", podId: "p9", podName: "pod-9" });
    mockKillRun.mockResolvedValueOnce(true);
    expect(await signalRun("pod-9", "run-1", "TERM")).toBe(true);
    expect(mockGetPod).toHaveBeenCalledWith("pod-9");
    expect(mockKillRun).toHaveBeenCalledWith(
      { id: "p9", name: "pod-9" },
      { runId: "run-1", runDir: "/home/agent/optio/runs/run-1", signal: "TERM" },
    );
  });

  it("is a no-op without a pod, and never throws", async () => {
    expect(await signalRun(null, "run-1")).toBe(false);
    mockGetPod.mockResolvedValueOnce(null);
    expect(await signalRun("gone", "run-1")).toBe(false);
    mockGetPod.mockResolvedValueOnce({ id: "pod-9", podId: "p9", podName: "pod-9" });
    mockKillRun.mockRejectedValueOnce(new Error("exec failed"));
    expect(await signalRun("pod-9", "run-1", "KILL")).toBe(false);
  });
});
