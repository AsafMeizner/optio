/**
 * Run attachment (docs/plans/scale-out.md §1–2): how an API instance holds,
 * streams, settles and hands over an agent run that lives in its pod under
 * the run protocol (run-protocol.ts in @optio/container-runtime).
 *
 * A run row — a task or Job run, a PR-review run, a persistent-agent turn —
 * carries `exec_state` / `exec_pid` (the supervisor in the pod),
 * `consumed_bytes` (how much of the pod's output file is log rows) and
 * `attached_by` / `attach_lease_until` (which instance streams it, until
 * when). This module owns those columns:
 *
 *   hold      the instance that claimed the run holds its attachment from
 *             the claim on, renewing every ATTACH_RENEW_MS while it sets the
 *             run up and streams it; a renewal that finds the run taken
 *             severs the stream at once
 *   start     the supervisor launched: exec_state = started, offset 0
 *   claim     a re-attach: one CAS that wins only when nobody holds the run
 *   stream    the output file from byte 0, every complete line to the
 *             derivations (lines below the offset were persisted by an
 *             earlier attachment and are replayed only), the rest stored as
 *             log rows in batches committed with the new offset in one
 *             transaction, so a run that changes hands never gets a
 *             duplicate or a gap
 *   settle    the agent exited and its output is consumed: exec_state =
 *             exited, with the run's spend in the same statement, once
 *   detach    on shutdown: every stream severed and every lease given up
 *             now, so another instance picks the runs up in seconds
 *
 * What a run's exit means is the workers' business, as before.
 */
import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { STDIN_EOF_SENTINEL, type ContainerRuntime, type RunExit } from "@optio/container-runtime";
import type { AgentLogEntry, ContainerHandle } from "@optio/shared";
import {
  ATTACH_LEASE_MS as DEFAULT_ATTACH_LEASE_MS,
  ATTACH_RENEW_MS as DEFAULT_ATTACH_RENEW_MS,
  parseIntEnv,
  shellQuote,
} from "@optio/shared";
import { db } from "../db/client.js";
import { INSTANCE_ID } from "./instance.js";
import {
  AttachmentLostError,
  appendRunLogsBatch,
  runRowTable,
  type LogLine,
  type LogRow,
  type RunRowRef,
} from "./run-log-service.js";
import * as podPool from "./agent-pod-pool.js";
import { getRuntime } from "./container-service.js";
import { runHome } from "../utils/harness-config.js";
import { logger } from "../logger.js";

export { AttachmentLostError };

/**
 * How long an attachment lasts without a renewal, and how often the holder
 * renews (docs/plans/scale-out.md §2: 60 s / 20 s). Shorter in the
 * scale-out e2e tier, so a killed server's runs move on in seconds.
 */
export const ATTACH_LEASE_MS = parseIntEnv("OPTIO_ATTACH_LEASE_MS", DEFAULT_ATTACH_LEASE_MS);
export const ATTACH_RENEW_MS = parseIntEnv(
  "OPTIO_ATTACH_RENEW_MS",
  Math.min(DEFAULT_ATTACH_RENEW_MS, Math.floor(ATTACH_LEASE_MS / 3)),
);

/** A run row with the attachment columns (see RunRowKind). */
export type AttachRef = RunRowRef;

function leaseUntil(): Date {
  return new Date(Date.now() + ATTACH_LEASE_MS);
}

// ── The columns ─────────────────────────────────────────────────────────────

/** The claiming instance takes the attachment: the run is its from here. */
export async function holdAttachment(ref: AttachRef): Promise<void> {
  const t = runRowTable(ref.kind);
  await db
    .update(t)
    .set({ attachedBy: INSTANCE_ID, attachLeaseUntil: leaseUntil() })
    .where(eq(t.id, ref.id));
}

/**
 * The supervisor launched. A fresh start truncates the output file, so the
 * consumed offset starts over with it. False when the run is no longer this
 * instance's (it was queued again meanwhile, which clears the attachment):
 * then the agent just started is nobody's, and the caller stops it.
 */
export async function recordRunStarted(ref: AttachRef, pid: number): Promise<boolean> {
  const t = runRowTable(ref.kind);
  const rows = await db
    .update(t)
    .set({
      execState: "started",
      execPid: pid,
      consumedBytes: 0,
      attachedBy: INSTANCE_ID,
      attachLeaseUntil: leaseUntil(),
    })
    .where(and(eq(t.id, ref.id), eq(t.attachedBy, INSTANCE_ID)))
    .returning({ id: t.id });
  return rows.length > 0;
}

export interface AttachmentClaim {
  /** Where the run's log rows reach: the stream persists from here on. */
  consumedBytes: number;
  /** `exited`: an earlier holder recorded the run's exit and went away before settling the rest. */
  execState: "started" | "exited";
}

/**
 * A re-attach: this instance takes the run iff its agent was started and
 * nobody holds it (or the holder's lease expired). Null when the claim lost.
 */
export async function claimAttachment(ref: AttachRef): Promise<AttachmentClaim | null> {
  const t = runRowTable(ref.kind);
  const [row] = await db
    .update(t)
    .set({ attachedBy: INSTANCE_ID, attachLeaseUntil: leaseUntil() })
    .where(
      and(
        eq(t.id, ref.id),
        inArray(t.execState, ["started", "exited"]),
        or(
          isNull(t.attachedBy),
          eq(t.attachedBy, INSTANCE_ID),
          isNull(t.attachLeaseUntil),
          lt(t.attachLeaseUntil, sql`now()`),
        ),
      ),
    )
    .returning({ consumedBytes: t.consumedBytes, execState: t.execState });
  if (!row || (row.execState !== "started" && row.execState !== "exited")) return null;
  return { consumedBytes: Number(row.consumedBytes), execState: row.execState };
}

/** Extends this instance's attachment. False when the run was taken from it. */
export async function renewAttachment(ref: AttachRef): Promise<boolean> {
  const t = runRowTable(ref.kind);
  const rows = await db
    .update(t)
    .set({ attachLeaseUntil: leaseUntil() })
    .where(and(eq(t.id, ref.id), eq(t.attachedBy, INSTANCE_ID)))
    .returning({ id: t.id });
  return rows.length > 0;
}

/** Gives the attachment up now (shutdown, or this instance stops streaming the run). */
export async function releaseAttachment(ref: AttachRef): Promise<void> {
  const t = runRowTable(ref.kind);
  await db
    .update(t)
    .set({ attachLeaseUntil: new Date() })
    .where(and(eq(t.id, ref.id), eq(t.attachedBy, INSTANCE_ID)));
}

/** The run is over and settled: nothing is attached to it any more. */
export async function closeAttachment(ref: AttachRef): Promise<void> {
  const t = runRowTable(ref.kind);
  await db
    .update(t)
    .set({ attachedBy: null, attachLeaseUntil: null })
    .where(and(eq(t.id, ref.id), eq(t.attachedBy, INSTANCE_ID)));
}

/**
 * How settling a run went: `settled` (this call recorded the exit, and the
 * spend with it), `already` (an earlier holder recorded both and went away
 * before finishing: do the rest, but add nothing), or `taken` (another
 * instance holds the run now: leave it).
 */
export type SettleResult = "settled" | "already" | "taken";

/**
 * The agent exited (or its run is lost) and its output is consumed: record
 * `exec_state = exited` with `patch` (the run's spend, its result) in the
 * same statement, iff this instance holds the run and nobody recorded the
 * exit before — so spend is added once, whoever finishes the run.
 * `alsoInTx` runs in the same transaction when this call is the one that
 * settles (spend that lives on another row: an agent's running total).
 */
export async function settleRun(
  ref: AttachRef,
  patch: Record<string, unknown> = {},
  alsoInTx?: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<unknown>,
): Promise<SettleResult> {
  const t = runRowTable(ref.kind);
  return db.transaction(async (tx) => {
    const settled = await tx
      .update(t)
      .set({ ...patch, execState: "exited" })
      .where(and(eq(t.id, ref.id), eq(t.attachedBy, INSTANCE_ID), eq(t.execState, "started")))
      .returning({ id: t.id });
    if (settled.length > 0) {
      if (alsoInTx) await alsoInTx(tx);
      return "settled";
    }
    const [row] = await tx
      .select({ execState: t.execState, attachedBy: t.attachedBy })
      .from(t)
      .where(eq(t.id, ref.id));
    return row && row.attachedBy === INSTANCE_ID && row.execState === "exited"
      ? "already"
      : "taken";
  });
}

// ── The hold: a renewing attachment with shutdown bookkeeping ───────────────

/** A hold this instance has on a run: renewed every ATTACH_RENEW_MS until it ends. */
export interface AttachmentHold {
  readonly ref: AttachRef;
  /** True once a renewal found the run taken by another instance. */
  readonly lost: boolean;
  /** What to sever when the hold must end at once (the live stream). */
  attachment: { close(): void } | null;
  /** Stops renewing; with `release`, gives the lease up now. */
  end(opts?: { release?: boolean }): Promise<void>;
}

const holds = new Set<AttachmentHold>();
let shuttingDown = false;

/**
 * Starts holding a run this instance just claimed by its state machine:
 * the lease is taken unconditionally and renewed from here on.
 */
export async function beginHold(ref: AttachRef): Promise<AttachmentHold> {
  await holdAttachment(ref);
  return startHold(ref);
}

/**
 * Holds a run this instance has the lease of (a `claimAttachment` win, or
 * `holdAttachment`): renewed every ATTACH_RENEW_MS with `WHERE attached_by
 * = me`. A renewal that matches nothing means another instance took the
 * run: the live stream is severed at once, and the stream loop returns.
 */
export function startHold(ref: AttachRef): AttachmentHold {
  let lost = false;
  let timer: NodeJS.Timeout | null = null;
  const hold: AttachmentHold = {
    ref,
    get lost() {
      return lost;
    },
    attachment: null,
    async end(opts) {
      if (timer) clearInterval(timer);
      timer = null;
      holds.delete(hold);
      if (opts?.release && !lost) {
        await releaseAttachment(ref).catch((err) =>
          logger.warn({ err, runId: ref.id }, "Failed to release run attachment"),
        );
      }
    },
  };
  timer = setInterval(() => {
    renewAttachment(ref)
      .then((ok) => {
        if (ok || lost || !timer) return;
        lost = true;
        logger.warn({ runId: ref.id }, "Run attachment taken by another instance; detaching");
        sever(hold);
      })
      .catch((err) => logger.warn({ err, runId: ref.id }, "Failed to renew run attachment"));
  }, ATTACH_RENEW_MS);
  timer.unref?.();
  holds.add(hold);
  return hold;
}

function sever(hold: AttachmentHold): void {
  try {
    hold.attachment?.close();
  } catch {
    // already closed
  }
}

/**
 * Shutdown: sever every live stream and give every lease up now, so other
 * instances pick the runs up in seconds rather than after a lease expiry.
 * The agents go on in their pods; the workers' jobs end with a detached
 * outcome and leave their runs as they are. Runs this instance is still
 * setting up are let go the same way (their next pass requeues or
 * re-attaches them).
 */
export async function detachAll(): Promise<number> {
  shuttingDown = true;
  const all = [...holds];
  for (const hold of all) sever(hold);
  await Promise.all(all.map((hold) => hold.end({ release: true })));
  return all.length;
}

/** True once `detachAll` ran: a worker must not start or settle anything more. */
export function isDetaching(): boolean {
  return shuttingDown;
}

/** How many runs this instance holds (diagnostics and tests). */
export function heldRunCount(): number {
  return holds.size;
}

// ── Streaming: the one attach loop ──────────────────────────────────────────

/** How a streamed attachment ended. */
export type StreamOutcome =
  | RunExit
  /** This instance lost the run to another one mid-stream. */
  | { kind: "taken" };

/** What a line parser makes of one line of agent output. */
export interface ParsedRunLine {
  entries: AgentLogEntry[];
  sessionId?: string;
  isTerminal?: boolean;
}

export interface StreamRunInput {
  runtime: ContainerRuntime;
  handle: ContainerHandle;
  ref: AttachRef;
  /** The run's directory in its pod (its run home). */
  runDir: string;
  hold: AttachmentHold;
  /** Where the run's log rows reach: lines ending at or before it are replayed, not stored. */
  consumedBytes: number;
  /** The kind's line parser (an agent's event parser, a command's line parser). */
  parse(line: string): ParsedRunLine;
  /**
   * Every complete line, replayed or new, in order: the in-memory
   * derivations rebuilt from byte 0 on every attach (the PR tool-call
   * tracker, the result digest, a command's exit receipt). Never persists.
   */
  derive?(line: string): void;
  /** The agent's session id, the first time a new (not replayed) line carries one: persist it. */
  onSession?(sessionId: string): Promise<void>;
  /** A new line's entries, before they are stored (signs of life). */
  onEntries?(entries: AgentLogEntry[]): void;
  /** A stored row's live frame. */
  publish(row: LogRow): Promise<void>;
  /** After each chunk of output (a heartbeat). */
  onChunk?(): Promise<void>;
  log?: typeof logger;
}

export interface StreamRunResult {
  outcome: StreamOutcome;
  /** The offset the run's log rows reach now. */
  consumedBytes: number;
  /** The agent's session id, from any line (replayed ones too). */
  sessionId?: string;
  /** Whether the agent emitted its terminal event (its turn is over). */
  sawTerminal: boolean;
}

const NEWLINE = 0x0a;

/** A complete line and the file offset just past its newline. */
export interface OutputLine {
  text: string;
  end: number;
}

/**
 * Splits a byte stream into complete lines with byte-exact file offsets. A
 * multi-byte character never spans a newline (0x0a appears in UTF-8 only as
 * itself), so each line is decoded on its own and partial lines wait for
 * their newline across chunks. Offsets count bytes, never string length.
 */
export class LineSplitter {
  private pending: Buffer = Buffer.alloc(0);
  /** The file offset of the end of what has been pushed so far. */
  private seen: number;

  constructor(fromByte = 0) {
    this.seen = fromByte;
  }

  push(chunk: Buffer): OutputLine[] {
    const buf = this.pending.length > 0 ? Buffer.concat([this.pending, chunk]) : chunk;
    const base = this.seen - this.pending.length;
    const lines: OutputLine[] = [];
    let start = 0;
    for (let i = buf.indexOf(NEWLINE); i !== -1; i = buf.indexOf(NEWLINE, start)) {
      lines.push({ text: buf.subarray(start, i).toString("utf8"), end: base + i + 1 });
      start = i + 1;
    }
    this.pending = start < buf.length ? Buffer.from(buf.subarray(start)) : Buffer.alloc(0);
    this.seen += chunk.length;
    return lines;
  }

  /** The unterminated tail, as a last line (the agent exited without a final newline). */
  flush(): OutputLine | null {
    if (this.pending.length === 0) return null;
    const line = { text: this.pending.toString("utf8"), end: this.seen };
    this.pending = Buffer.alloc(0);
    return line;
  }
}

/**
 * The one attach loop, for every run kind: attaches to the run's output
 * from byte 0 and streams it to its end. Lines below `consumedBytes` were
 * stored by an earlier attachment: they feed the derivations and nothing
 * else. The rest become log rows, each chunk's batch committed with the new
 * offset in one transaction (`appendRunLogsBatch`), then published. The
 * agent's terminal event closes its stdin (`STDIN_EOF_SENTINEL`) — on a
 * replay too: the feeder stops at the first sentinel, so a second is
 * inert, and an instance that saw the event and died before delivering it
 * must not leave the agent waiting.
 */
export async function streamRun(input: StreamRunInput): Promise<StreamRunResult> {
  const { runtime, handle, ref, runDir, hold } = input;
  const log = input.log ?? logger;
  let consumed = input.consumedBytes;
  let sessionId: string | undefined;
  let sawTerminal = false;
  let taken = false;

  // Shutting down: the run is for another instance to stream.
  if (isDetaching()) {
    return {
      outcome: { kind: "detached", reason: "closed" },
      consumedBytes: consumed,
      sawTerminal,
    };
  }
  const attachment = await runtime.attachRun(handle, { runId: ref.id, runDir, fromByte: 0 });
  hold.attachment = attachment;
  const splitter = new LineSplitter(0);

  const handleLines = async (lines: OutputLine[]): Promise<void> => {
    const rows: LogLine[] = [];
    let last = consumed;
    for (const line of lines) {
      const replay = line.end <= consumed;
      input.derive?.(line.text);
      if (line.text.trim()) {
        const parsed = input.parse(line.text);
        if (parsed.sessionId && !sessionId) {
          sessionId = parsed.sessionId;
          if (!replay) await input.onSession?.(sessionId);
        }
        if (parsed.isTerminal && !sawTerminal) {
          sawTerminal = true;
          await runtime
            .deliverStdin(handle, { runId: ref.id, runDir, line: STDIN_EOF_SENTINEL })
            .catch((err) => log.warn({ err }, "Failed to close the agent's stdin after its turn"));
        }
        if (!replay) {
          input.onEntries?.(parsed.entries);
          for (const entry of parsed.entries) {
            rows.push({
              content: entry.content,
              stream: "stdout",
              logType: entry.type,
              metadata: entry.metadata ?? null,
            });
          }
        }
      }
      if (!replay) last = line.end;
    }
    if (last <= consumed) return;
    let stored: LogRow[];
    try {
      stored = await appendRunLogsBatch(ref, rows, { from: consumed, to: last });
    } catch (err) {
      if (err instanceof AttachmentLostError) {
        taken = true;
        sever(hold);
        return;
      }
      throw err;
    }
    consumed = last;
    for (const row of stored) await input.publish(row);
  };

  try {
    for await (const chunk of attachment.output as AsyncIterable<Buffer>) {
      if (taken || hold.lost) break;
      const lines = splitter.push(chunk);
      if (lines.length > 0) await handleLines(lines);
      if (taken || hold.lost) break;
      await input.onChunk?.();
    }
  } catch (err) {
    if (!taken && !hold.lost) {
      // A failure here (the database, a publish) must not leave the exec open.
      sever(hold);
      hold.attachment = null;
      throw err;
    }
  }

  const exit = await attachment.exit;
  hold.attachment = null;
  if (taken || hold.lost)
    return { outcome: { kind: "taken" }, consumedBytes: consumed, sawTerminal };

  // The agent exited: whatever has no trailing newline is its last line.
  if (exit.kind === "exited") {
    const tail = splitter.flush();
    if (tail) await handleLines([tail]);
    if (taken) return { outcome: { kind: "taken" }, consumedBytes: consumed, sawTerminal };
  }
  return { outcome: exit, consumedBytes: consumed, sessionId, sawTerminal };
}

// ── The attach job: one driver for every run kind ───────────────────────────

/** The pod a run's agent runs in, as the finishing code needs it. */
export interface AttachedPod {
  id: string;
  handle: ContainerHandle;
}

export interface AttachJobSpec {
  ref: AttachRef;
  log: typeof logger;
  /** The `agent_pods` row the run's agent was started in. */
  podId: string | null;
  /**
   * The pod is gone (or not ready): the run is lost with it. Called once
   * the exit is recorded (`settleRun`); settles the run's state the way
   * the kind's pod-death path does.
   */
  onPodGone(detail: string): Promise<void>;
  /** Streams the run to its end and settles it: the kind's finishing code. */
  finish(pod: AttachedPod, hold: AttachmentHold, claim: AttachmentClaim): Promise<RunEnd>;
  /** After a finished run: give back what it held (its pod slot). */
  afterFinish?(podId: string | null): Promise<void>;
}

/** How a worker's part in a run ended: settled here, or left for whoever attaches next. */
export type RunEnd = "finished" | "detached";

/**
 * An attach job (the reconciler's `reattach` action), for any run kind:
 * claim the attachment by CAS — losing it is the normal case when two
 * instances answer the same expiry — then finish the run from where its
 * log rows stop. A pod that is gone settles the run through the kind's
 * pod-death path.
 */
export async function runAttachJob(spec: AttachJobSpec): Promise<RunEnd | "skipped"> {
  const { ref, log } = spec;
  if (isDetaching()) return "skipped";
  const claim = await claimAttachment(ref);
  if (!claim) {
    log.info("Skipping attach — the run is attached elsewhere, or was never started");
    return "skipped";
  }
  const hold = startHold(ref);
  let ended: RunEnd = "detached";
  try {
    const pod = spec.podId ? await podPool.getPod(spec.podId) : null;
    if (!pod || !pod.podName || pod.state !== "ready") {
      const detail = `The pod the agent ran in is ${pod ? pod.state : "gone"}`;
      if ((await settleRun(ref)) === "taken") return "detached";
      await spec.onPodGone(detail);
      await closeAttachment(ref);
      ended = "finished";
      return ended;
    }
    log.info({ consumedBytes: claim.consumedBytes, pod: pod.podName }, "Attaching to the run");
    ended = await spec.finish({ id: pod.id, handle: podPool.podHandle(pod) }, hold, claim);
    return ended;
  } finally {
    await hold.end({ release: ended !== "finished" });
    if (ended === "finished") await spec.afterFinish?.(spec.podId).catch(() => {});
  }
}

// ── Pod-side housekeeping ───────────────────────────────────────────────────

/**
 * Removes the run's directory in its pod once the run is terminal and every
 * byte of its output is a log row (the run-home sweep is the backstop).
 * Best-effort, one short exec.
 */
export async function removeRunDirectory(
  runtime: ContainerRuntime,
  handle: ContainerHandle,
  runDir: string,
): Promise<void> {
  if (!/^\/home\/agent\/optio\/runs\/[A-Za-z0-9_.-]+$/.test(runDir)) return;
  try {
    const session = await runtime.exec(handle, ["bash", "-c", `rm -rf ${shellQuote(runDir)}`], {
      tty: false,
    });
    for await (const _chunk of session.stdout as AsyncIterable<Buffer>) {
      // drain
    }
    session.close();
  } catch (err) {
    logger.debug({ err, runDir }, "Failed to remove run directory");
  }
}

/**
 * Signals a run's process group in its pod, from any instance: the pod is
 * found from the database (`podId`), the run directory from the run's id.
 * True when a live supervisor was there to signal. Best-effort.
 */
export async function signalRun(
  podId: string | null | undefined,
  runId: string,
  signal: "TERM" | "KILL" = "TERM",
): Promise<boolean> {
  if (!podId) return false;
  try {
    const pod = await podPool.getPod(podId);
    if (!pod?.podName) return false;
    return await getRuntime().killRun(podPool.podHandle(pod), {
      runId,
      runDir: runHome(runId).podDir,
      signal,
    });
  } catch (err) {
    logger.warn({ err, runId }, "Failed to signal the run's process");
    return false;
  }
}
