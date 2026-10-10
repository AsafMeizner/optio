/**
 * A run's attachment (docs/plans/scale-out.md §2): the agent of a run lives
 * in its pod under the run protocol, and one API instance at a time streams
 * it — the one whose lease (`attach_lease_until`) is in the future. The
 * columns are on the run's own row (a task or Job run, a persistent-agent
 * turn, a PR-review run); this is the pure reading of them the reconciler's
 * decisions share.
 */

/** How long an attachment lasts without a renewal. */
export const ATTACH_LEASE_MS = 60_000;
/** How often the attached instance renews. */
export const ATTACH_RENEW_MS = 20_000;

/**
 * The run's agent in its pod: not started (`null`), running under its
 * supervisor (`started`), or exited with its output consumed and its spend
 * recorded (`exited`; the run's own state may still be settling).
 */
export type RunExecState = "started" | "exited" | null;

/** The attachment columns of a run row. */
export interface RunAttachmentState {
  execState: RunExecState;
  attachedBy: string | null;
  attachLeaseUntil: Date | null;
}

/** One run's execution, as the snapshot builder reads it for the reconciler. */
export interface RunExecution extends RunAttachmentState {
  /** The row that carries it: the task or Job run, the turn, or the review run. */
  runId: string;
  /**
   * The row's last write. A row with no lease yet is live while this is
   * fresh: claiming a run and taking its first lease are two statements.
   */
  touchedAt: Date | null;
}

/**
 * Whether an instance holds the run now: a lease in the future, or — with
 * no lease written yet — a row touched within two lease periods.
 */
export function attachmentIsLive(
  execution: Pick<RunExecution, "attachLeaseUntil" | "touchedAt">,
  now: Date,
): boolean {
  if (execution.attachLeaseUntil) return execution.attachLeaseUntil.getTime() > now.getTime();
  if (!execution.touchedAt) return false;
  return now.getTime() - execution.touchedAt.getTime() < 2 * ATTACH_LEASE_MS;
}

/** What an active run's execution needs from the reconciler. */
export type ExecutionReading =
  /** Nothing observed (a test snapshot, a run on a machine): decide as before. */
  | { kind: "unknown" }
  /** An instance streams it. */
  | { kind: "attached" }
  /** The agent was started (or its result is half recorded) and nobody holds it: attach again. */
  | { kind: "detached"; attempt: number }
  /**
   * Nobody holds it and its agent was never started. `held` says an
   * instance had claimed it under the run protocol (it went away while
   * setting the run up); a run never held predates the protocol, and its
   * exec stream died with the process that had it.
   */
  | { kind: "never_started"; held: boolean };

export function readExecution(
  execution: RunExecution | null | undefined,
  now: Date,
): ExecutionReading {
  if (!execution) return { kind: "unknown" };
  if (attachmentIsLive(execution, now)) return { kind: "attached" };
  if (execution.execState === "started" || execution.execState === "exited") {
    return { kind: "detached", attempt: attachAttempt(execution) };
  }
  return { kind: "never_started", held: execution.attachedBy !== null };
}

/**
 * Names one expiry of a run's attachment: the expired lease's time. Every
 * reconcile pass that sees the same expiry asks for the same attach job (a
 * BullMQ job id dedupes them); once an instance claims the run and its
 * lease lapses again, the next expiry is a new attempt.
 */
export function attachAttempt(execution: Pick<RunExecution, "attachLeaseUntil">): number {
  return execution.attachLeaseUntil?.getTime() ?? 0;
}

/**
 * The attach job's id for one attempt. `__`, not `:`: BullMQ rejects `:` in
 * custom ids (bar a legacy three-part form it plans to drop), as runKey notes.
 */
export function attachJobId(runId: string, attempt: number): string {
  return `attach__${runId}__${attempt}`;
}
