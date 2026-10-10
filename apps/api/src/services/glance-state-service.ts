/**
 * The glance / push bookkeeping, in Postgres (`glance_state`): one row per
 * key, a JSON value, and for timers a due time. Every API instance reads and
 * writes the same rows, so a terminal's last attention state set by the
 * instance that took the daemon's frame is what another instance's hook
 * compares against, and a timer set by one instance fires on whichever
 * instance sweeps it (glance-sweep-worker.ts).
 *
 * Keys (glance-service.ts):
 *   attention:<terminal>   { state }           last attention state pushed for
 *   needs-you:<user>       { count }           last needs-you count computed
 *   running:<user>         { count }           last running count computed
 *   host-offline:<host>    { at }              outage already alerted
 *   watch-end:<user>       { providers: [] }   due: end the Watch if still quiet
 *   snooze:<terminal>      { userId }          due: recompute when the snooze ends
 */
import { and, eq, isNotNull, lte, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { glanceState } from "../db/schema.js";

export type GlanceValue = Record<string, unknown>;

export interface GlanceRow<T extends GlanceValue = GlanceValue> {
  key: string;
  value: T;
  dueAt: Date | null;
}

export async function getGlance<T extends GlanceValue = GlanceValue>(
  key: string,
): Promise<GlanceRow<T> | null> {
  const [row] = await db.select().from(glanceState).where(eq(glanceState.key, key));
  return row ? { key: row.key, value: row.value as T, dueAt: row.dueAt } : null;
}

/** Upserts the row; `dueAt` undefined keeps an existing due time, null clears it. */
export async function setGlance(
  key: string,
  value: GlanceValue,
  dueAt?: Date | null,
): Promise<void> {
  await db
    .insert(glanceState)
    .values({ key, value, dueAt: dueAt ?? null })
    .onConflictDoUpdate({
      target: glanceState.key,
      set: {
        value,
        ...(dueAt === undefined ? {} : { dueAt }),
      },
    });
}

export async function deleteGlance(key: string): Promise<boolean> {
  const rows = await db
    .delete(glanceState)
    .where(eq(glanceState.key, key))
    .returning({ key: glanceState.key });
  return rows.length > 0;
}

/**
 * A timer row: inserted with its due time when absent; when present, its
 * `providers` array is unioned with the new one and the existing due time
 * is kept (the first quiet moment starts the clock, later ones join it).
 * One statement, so two instances adding providers at once lose nothing.
 */
export async function joinGlanceTimer(
  key: string,
  providers: readonly string[],
  dueAt: Date,
): Promise<void> {
  const value = { providers: [...providers] };
  await db
    .insert(glanceState)
    .values({ key, value, dueAt })
    .onConflictDoUpdate({
      target: glanceState.key,
      set: {
        value: sql`jsonb_build_object('providers', (
          SELECT COALESCE(jsonb_agg(DISTINCT p), '[]'::jsonb)
          FROM jsonb_array_elements(
            COALESCE(${glanceState.value}->'providers', '[]'::jsonb) || ${JSON.stringify(value.providers)}::jsonb
          ) AS p
        ))`,
        dueAt: sql`COALESCE(${glanceState.dueAt}, ${dueAt.toISOString()}::timestamptz)`,
      },
    });
}

/**
 * Claims every timer that is due: the rows are deleted and returned in one
 * statement, so two sweeping instances never fire the same timer twice.
 */
export async function takeDueGlance(now = new Date()): Promise<GlanceRow[]> {
  const rows = await db
    .delete(glanceState)
    .where(and(isNotNull(glanceState.dueAt), lte(glanceState.dueAt, now)))
    .returning();
  return rows.map((r) => ({ key: r.key, value: r.value, dueAt: r.dueAt }));
}

/** Every row (tests and diagnostics). */
export async function listGlance(): Promise<GlanceRow[]> {
  const rows = await db.select().from(glanceState);
  return rows.map((r) => ({ key: r.key, value: r.value, dueAt: r.dueAt }));
}

/** Removes every row (tests). */
export async function resetGlanceState(): Promise<void> {
  await db.delete(glanceState);
}
