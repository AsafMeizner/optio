/**
 * The one log store for every agent run: `task_logs` holds the lines of task
 * runs, PR-review runs, and persistent-agent turns alike. Each kind's service
 * keeps its own live event (the WebSocket frames differ per kind); the rows,
 * their filters, and their order live here.
 */
import { and, eq, ilike, type SQL } from "drizzle-orm";
import { db } from "../db/client.js";
import { persistentAgentTurns, prReviewRuns, taskLogs, workRuns } from "../db/schema.js";
import { INSTANCE_ID } from "./instance.js";

/** Whose line it is. */
export type LogOwner =
  | { taskId: string }
  | { prReviewRunId: string }
  | { persistentAgentTurnId: string };

export interface LogLine {
  content: string;
  stream?: string;
  logType?: string | null;
  metadata?: Record<string, unknown> | null;
}

export type LogRow = typeof taskLogs.$inferSelect;

function ownerFilter(owner: LogOwner): SQL {
  if ("taskId" in owner) return eq(taskLogs.taskId, owner.taskId);
  if ("prReviewRunId" in owner) return eq(taskLogs.prReviewRunId, owner.prReviewRunId);
  return eq(taskLogs.persistentAgentTurnId, owner.persistentAgentTurnId);
}

/** Store one line and return the stored row (its id and timestamp are what live frames carry). */
export async function insertLog(owner: LogOwner, line: LogLine): Promise<LogRow> {
  const [row] = await db
    .insert(taskLogs)
    .values({
      ...owner,
      content: line.content,
      stream: line.stream ?? "stdout",
      logType: line.logType ?? null,
      metadata: line.metadata ?? null,
    })
    .returning();
  return row;
}

/** An owner's lines, oldest first. */
export async function listLogs(
  owner: LogOwner,
  opts: { logType?: string; search?: string; limit?: number; offset?: number } = {},
): Promise<LogRow[]> {
  const conditions = [ownerFilter(owner)];
  if (opts.logType) conditions.push(eq(taskLogs.logType, opts.logType));
  if (opts.search) conditions.push(ilike(taskLogs.content, `%${opts.search}%`));
  let query = db
    .select()
    .from(taskLogs)
    .where(and(...conditions))
    .orderBy(taskLogs.timestamp)
    .$dynamic();
  if (opts.limit) query = query.limit(opts.limit);
  if (opts.offset) query = query.offset(opts.offset);
  return query;
}

// ── Runs under the run protocol (docs/plans/scale-out.md §1–2) ──────────────

/**
 * The rows an agent run lives in: a task or Job run (`work-run`, a row of
 * the `tasks` table, which both run views read), a PR-review run, a
 * persistent-agent turn. Each carries the attachment columns.
 */
export type RunRowKind = "work-run" | "review-run" | "turn";

export interface RunRowRef {
  kind: RunRowKind;
  id: string;
}

/** The table a run row lives in. */
export function runRowTable(kind: RunRowKind) {
  switch (kind) {
    case "work-run":
      return workRuns;
    case "review-run":
      return prReviewRuns;
    case "turn":
      return persistentAgentTurns;
  }
}

/** Whose log lines a run row's are. */
export function logOwnerOf(ref: RunRowRef): LogOwner {
  switch (ref.kind) {
    case "work-run":
      return { taskId: ref.id };
    case "review-run":
      return { prReviewRunId: ref.id };
    case "turn":
      return { persistentAgentTurnId: ref.id };
  }
}

/** The run columns a new attempt of a run starts from: no agent, nothing consumed, nobody attached. */
export const NEW_ATTEMPT_EXECUTION = {
  execState: null,
  execPid: null,
  consumedBytes: 0,
  attachedBy: null,
  attachLeaseUntil: null,
} as const;

/** This instance no longer holds the run: another one claimed it, or it was requeued. */
export class AttachmentLostError extends Error {
  constructor(runId: string) {
    super(`Run ${runId} is no longer attached to this instance`);
    this.name = "AttachmentLostError";
  }
}

/**
 * Stores a batch of a run's log lines and advances its consumed offset from
 * `offsets.from` to `offsets.to` in one transaction: the rows exist iff the
 * offset moved, so a run that changes instances never gets a duplicate or a
 * gap. The offset write is a CAS on this instance holding the run and on
 * the old offset; when it fails the transaction rolls back and
 * AttachmentLostError is thrown. Returns the stored rows in order, for the
 * live frames.
 */
export async function appendRunLogsBatch(
  ref: RunRowRef,
  entries: LogLine[],
  offsets: { from: number; to: number },
): Promise<LogRow[]> {
  const owner = logOwnerOf(ref);
  const table = runRowTable(ref.kind);
  return db.transaction(async (tx) => {
    const rows =
      entries.length > 0
        ? await tx
            .insert(taskLogs)
            .values(
              entries.map((line) => ({
                ...owner,
                content: line.content,
                stream: line.stream ?? "stdout",
                logType: line.logType ?? null,
                metadata: line.metadata ?? null,
              })),
            )
            .returning()
        : [];
    const advanced = await tx
      .update(table)
      .set({ consumedBytes: offsets.to })
      .where(
        and(
          eq(table.id, ref.id),
          eq(table.attachedBy, INSTANCE_ID),
          eq(table.consumedBytes, offsets.from),
        ),
      )
      .returning({ id: table.id });
    if (advanced.length === 0) throw new AttachmentLostError(ref.id);
    return rows;
  });
}
