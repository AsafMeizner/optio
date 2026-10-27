import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { db } from "../db/client.js";
import { users, sessions, wsUpgradeTokens } from "../db/schema.js";
import { eq, and, lt, sql } from "drizzle-orm";
import type { OAuthUser } from "./oauth/provider.js";

const SESSION_MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days absolute max
const SESSION_SLIDING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days sliding window

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface SessionUser {
  id: string;
  provider: string;
  email: string;
  displayName: string;
  /** Provider handle (GitHub login / GitLab username); null when unknown. */
  username: string | null;
  avatarUrl: string | null;
  workspaceId: string | null;
  workspaceRole: string | null;
  /** May change how everyone signs in (Settings → Sign-in). Filled by /api/auth/me. */
  deploymentAdmin?: boolean;
}

/** Find or create a user from an OAuth profile, then create a session. */
export async function createSession(
  provider: string,
  profile: OAuthUser,
): Promise<{ token: string; user: SessionUser }> {
  // Upsert user
  const existing = await db
    .select()
    .from(users)
    .where(and(eq(users.provider, provider), eq(users.externalId, profile.externalId)))
    .limit(1);

  let user: (typeof existing)[0];

  if (existing.length > 0) {
    // Update user info on login
    const updated = await db
      .update(users)
      .set({
        email: profile.email,
        emailVerified: profile.emailVerified === true,
        displayName: profile.displayName,
        username: profile.username ?? null,
        avatarUrl: profile.avatarUrl ?? null,
        lastLoginAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(users.id, existing[0].id))
      .returning();
    user = updated[0];
  } else {
    const inserted = await db
      .insert(users)
      .values({
        provider,
        externalId: profile.externalId,
        email: profile.email,
        emailVerified: profile.emailVerified === true,
        displayName: profile.displayName,
        username: profile.username ?? null,
        avatarUrl: profile.avatarUrl ?? null,
      })
      .returning();
    user = inserted[0];
  }

  // Create session token
  const token = randomBytes(32).toString("hex");
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + SESSION_SLIDING_WINDOW_MS);

  await db.insert(sessions).values({
    userId: user.id,
    tokenHash,
    expiresAt,
  });

  return {
    token,
    user: {
      id: user.id,
      provider: user.provider,
      email: user.email,
      displayName: user.displayName,
      username: user.username,
      avatarUrl: user.avatarUrl,
      workspaceId: user.defaultWorkspaceId,
      workspaceRole: null,
    },
  };
}

/** Validate a session token and return the user if valid. */
export async function validateSession(token: string): Promise<SessionUser | null> {
  const tokenHash = hashToken(token);
  const now = new Date();

  const rows = await db
    .select({
      sessionId: sessions.id,
      tokenHash: sessions.tokenHash,
      sessionCreatedAt: sessions.createdAt,
      expiresAt: sessions.expiresAt,
      userId: users.id,
      provider: users.provider,
      email: users.email,
      displayName: users.displayName,
      username: users.username,
      avatarUrl: users.avatarUrl,
      defaultWorkspaceId: users.defaultWorkspaceId,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.tokenHash, tokenHash))
    .limit(1);

  if (rows.length === 0) return null;

  const row = rows[0];

  // Constant-time comparison of token hash (defense-in-depth)
  if (!timingSafeEqual(Buffer.from(row.tokenHash), Buffer.from(tokenHash))) return null;

  // Check expiry in application code
  if (row.expiresAt <= now) return null;

  // Sliding-window: extend session expiry on successful validation
  const slidingExpiry = new Date(now.getTime() + SESSION_SLIDING_WINDOW_MS);
  const maxExpiry = new Date(row.sessionCreatedAt.getTime() + SESSION_MAX_TTL_MS);
  const newExpiry = slidingExpiry < maxExpiry ? slidingExpiry : maxExpiry;
  if (newExpiry > now) {
    await db.update(sessions).set({ expiresAt: newExpiry }).where(eq(sessions.id, row.sessionId));
  }

  return {
    id: row.userId,
    provider: row.provider,
    email: row.email,
    displayName: row.displayName,
    username: row.username,
    avatarUrl: row.avatarUrl,
    workspaceId: row.defaultWorkspaceId,
    workspaceRole: null, // resolved by auth middleware from header/cookie
  };
}

/** Revoke a session by token. */
export async function revokeSession(token: string): Promise<void> {
  const tokenHash = hashToken(token);
  await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
}

/** Revoke all sessions for a user. */
export async function revokeAllUserSessions(userId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.userId, userId));
}

// ── Single-use WebSocket upgrade tokens (ws_upgrade_tokens) ───────────────

const WS_TOKEN_TTL_SECONDS = 30; // just enough for the WS upgrade

/**
 * Create a short-lived, single-use token for WebSocket authentication.
 *
 * The browser fetches it from whichever API instance answers
 * `/api/auth/ws-token` and upgrades `/ws/*` through the ingress to any
 * instance, so the token lives in `ws_upgrade_tokens` (hashed; the raw
 * token is never stored), not in process memory. Expired rows are swept by
 * the housekeeping worker.
 */
export async function createWsToken(userId: string): Promise<string> {
  const token = randomBytes(32).toString("hex");
  // Expiry on the database's clock, as validation compares it: API pods'
  // clocks may disagree by more than the token lives.
  await db.insert(wsUpgradeTokens).values({
    tokenHash: hashToken(token),
    userId,
    expiresAt: sql`now() + make_interval(secs => ${WS_TOKEN_TTL_SECONDS})`,
  });
  return token;
}

/**
 * Validate and consume a single-use WebSocket upgrade token.
 * Returns the SessionUser on success (token is deleted), or null if
 * the token is invalid, expired, or already consumed.
 *
 * Consuming is one `DELETE … RETURNING` on the hash: exactly one of two
 * concurrent upgrades with the same token (on any instances) gets the row.
 * The lookup is an equality on a SHA-256 of 32 random bytes, so a timing
 * side channel on the comparison reveals nothing an attacker could use.
 */
export async function validateWsToken(token: string): Promise<SessionUser | null> {
  const [entry] = await db
    .delete(wsUpgradeTokens)
    .where(eq(wsUpgradeTokens.tokenHash, hashToken(token)))
    .returning({
      userId: wsUpgradeTokens.userId,
      live: sql<boolean>`${wsUpgradeTokens.expiresAt} > now()`,
    });

  // Consumed either way: an expired token is spent, not left to retry.
  if (!entry || !entry.live) return null;

  // Look up the user by ID
  const rows = await db
    .select({
      userId: users.id,
      provider: users.provider,
      email: users.email,
      displayName: users.displayName,
      username: users.username,
      avatarUrl: users.avatarUrl,
      defaultWorkspaceId: users.defaultWorkspaceId,
    })
    .from(users)
    .where(eq(users.id, entry.userId))
    .limit(1);

  if (rows.length === 0) return null;

  const row = rows[0];
  return {
    id: row.userId,
    provider: row.provider,
    email: row.email,
    displayName: row.displayName,
    username: row.username,
    avatarUrl: row.avatarUrl,
    workspaceId: row.defaultWorkspaceId,
    workspaceRole: null,
  };
}

/** Delete all expired sessions. Returns count of deleted rows. */
export async function cleanupExpiredSessions(): Promise<number> {
  const result = await db.delete(sessions).where(lt(sessions.expiresAt, new Date())).returning();
  return result.length;
}
