/** The Postgres SQLSTATE on an error — drizzle wraps it ("Failed query: …"), so it may be on a `cause`. */
function hasPgCode(err: unknown, code: string): boolean {
  for (let e = err; e; e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: string }).code === code) return true;
  }
  return false;
}

/** A Postgres unique violation. */
export function isUniqueViolation(err: unknown): boolean {
  return hasPgCode(err, "23505");
}

/** `lock_timeout` ran out waiting for a lock (`lock_not_available`). */
export function isLockTimeout(err: unknown): boolean {
  return hasPgCode(err, "55P03");
}

/** `statement_timeout` (or a cancel) stopped the statement (`query_canceled`). */
export function isStatementTimeout(err: unknown): boolean {
  return hasPgCode(err, "57014");
}
