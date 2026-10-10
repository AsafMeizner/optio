/**
 * Claim locks (docs/plans/scale-out.md §3): the count-then-claim that admits
 * a run under a concurrency limit — "fewer than N running, so take this
 * one" — is only correct when nobody else counts at the same time. One
 * process used to serialize its own claimers with a promise chain; across
 * API instances that is a Postgres transaction-level advisory lock on the
 * limit's key, held for exactly the count and the claim.
 *
 * `withClaimLock(keys, fn)` opens a transaction, takes
 * `pg_advisory_xact_lock(hashtext(key))` for every key in sorted order (two
 * claimers that need the same set of locks take them in the same order, so
 * they can't deadlock), runs `fn` with the transaction, and releases the
 * locks when the transaction ends.
 *
 * `fn` counts on `tx` and makes its claim — a compare-and-swap state
 * transition — on `tx` too (`claimTransitionIn`, `claimWorkflowRunIn`), so
 * the claim commits with the transaction, before the lock is released; the
 * next claimer's count starts after that and, under READ COMMITTED, sees
 * it. The claim's announcement (events, webhooks, the reconciler) runs
 * after the commit. Nothing inside `fn` may use the shared `db` client: a
 * claimer holds one pooled connection while it waits for the lock, and a
 * holder that needed a second one could wait forever on a pool that the
 * waiters have exhausted.
 */
import { sql } from "drizzle-orm";
import { normalizeRepoUrl } from "@optio/shared";
import { db, type Database } from "../db/client.js";

/** A transaction handle `withClaimLock` hands to its callback. */
export type ClaimTx = Parameters<Parameters<Database["transaction"]>[0]>[0];

const MAX_KEY = 200;

/** The global Repo Task limit (`OPTIO_MAX_CONCURRENT`). */
export const TASK_CLAIM_KEY = "claim:tasks";
/** The global Job run limit (`OPTIO_MAX_WORKFLOW_CONCURRENT`). */
export const WORKFLOW_CLAIM_KEY = "claim:workflows";
/** A repo's own limit. */
export function repoClaimKey(repoUrl: string): string {
  return claimKey("claim:repo", normalizeRepoUrl(repoUrl));
}
/** A Job's own limit (`maxConcurrent`). */
export function workflowClaimKey(workflowId: string): string {
  return claimKey("claim:workflow", workflowId);
}

/**
 * The lock key for a limit. Keys are hashed to 32 bits by `hashtext`; two
 * keys that collide only serialize with each other, which is harmless.
 */
export function claimKey(...parts: string[]): string {
  const key = parts.join(":");
  if (!key || key.length > MAX_KEY) throw new Error(`Invalid claim key: ${JSON.stringify(key)}`);
  return key;
}

/**
 * Runs `fn` while holding the advisory locks for `keys`, inside one
 * transaction. Returns what `fn` returns; a throw rolls the transaction
 * back (the locks go with it).
 */
export async function withClaimLock<T>(
  keys: readonly string[],
  fn: (tx: ClaimTx) => Promise<T>,
): Promise<T> {
  const sorted = [...new Set(keys.map((k) => claimKey(k)))].sort();
  if (sorted.length === 0) throw new Error("withClaimLock needs at least one key");
  return db.transaction(async (tx) => {
    for (const key of sorted) {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`);
    }
    return fn(tx);
  });
}
