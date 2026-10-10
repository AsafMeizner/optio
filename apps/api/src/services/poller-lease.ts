/**
 * Pollers under a lease (docs/plans/scale-out.md §3): a periodic sweep —
 * ticket sync, the schedule checker, external PR review, pod cleanup, skill
 * sync, token validation, config sync — runs on one API instance at a time.
 * BullMQ hands each tick to one worker, but a slow sweep on one instance
 * and the next tick on another would otherwise overlap. Each sweep is also
 * written to be safe when it does overlap (claims, CAS, unique keys); the
 * lease keeps that the exception.
 */
import { LeaseLostError, withLease } from "./lease-service.js";
import { logger } from "../logger.js";

/** How long a sweep may run before its lease lapses without a renew. */
const POLLER_LEASE_TTL_MS = 120_000;

/**
 * Runs `fn` under `poller:<name>`. Resolves `null` without running when
 * another instance holds the lease (the tick is skipped; the next one
 * tries again). A lease lost mid-sweep (the database away for longer than
 * the TTL) is logged, not thrown: the sweep's own safeguards cover the
 * overlap, and the tick is over anyway.
 */
export async function underPollerLease<T>(
  name: string,
  fn: (signal: AbortSignal) => Promise<T>,
  /** The lease holder (this instance by default; tests play two instances). */
  holder?: string,
): Promise<T | null> {
  try {
    const result = await withLease(`poller:${name}`, fn, {
      ttlMs: POLLER_LEASE_TTL_MS,
      ...(holder ? { holder } : {}),
    });
    if (result === null) logger.debug({ poller: name }, "Sweep skipped: another instance holds it");
    return result;
  } catch (err) {
    if (err instanceof LeaseLostError) {
      logger.warn({ poller: name }, "Sweep lost its lease while running");
      return null;
    }
    throw err;
  }
}
