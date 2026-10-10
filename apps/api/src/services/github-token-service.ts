import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { tasks } from "../db/schema.js";
import {
  retrieveSecret,
  retrieveSecretWithFallback,
  storeSecret,
  deleteSecret,
} from "./secret-service.js";
import { isGitHubAppConfigured, getInstallationToken } from "./github-app-service.js";
import { LeaseLostError, leaseHolder, withLease } from "./lease-service.js";
import { logger } from "../logger.js";

const refreshLocks = new Map<string, Promise<string>>();
const TOKEN_REFRESH_BUFFER_MS = 10 * 60 * 1000;

export type GitHubTokenContext =
  | { taskId: string }
  | { userId: string; workspaceId?: string | null }
  | { server: true; workspaceId?: string | null };

export async function getGitHubToken(context: GitHubTokenContext): Promise<string> {
  if ("server" in context) return getServerToken(context.workspaceId);
  if ("taskId" in context) return getTokenForTask(context.taskId);
  return getTokenForUser(context.userId, context.workspaceId);
}

async function getServerToken(workspaceId?: string | null): Promise<string> {
  if (isGitHubAppConfigured()) {
    try {
      return await getInstallationToken();
    } catch (err) {
      logger.warn({ err }, "Installation token failed, falling back to PAT");
      return getPatFallback(workspaceId);
    }
  }
  return getPatFallback(workspaceId);
}

async function getTokenForTask(taskId: string): Promise<string> {
  const [task] = await db
    .select({ createdBy: tasks.createdBy, workspaceId: tasks.workspaceId })
    .from(tasks)
    .where(eq(tasks.id, taskId));

  if (!task?.createdBy) {
    // No user associated — use server/installation token (e.g., system-created tasks)
    return getServerToken();
  }
  return getTokenForUser(task.createdBy, task.workspaceId);
}

async function getTokenForUser(userId: string, workspaceId?: string | null): Promise<string> {
  try {
    const accessToken = await retrieveSecret("GITHUB_USER_ACCESS_TOKEN", `user:${userId}`);
    const expiresAt = await retrieveSecret("GITHUB_USER_TOKEN_EXPIRES_AT", `user:${userId}`);

    const expiryTime = new Date(expiresAt).getTime();
    if (Date.now() < expiryTime - TOKEN_REFRESH_BUFFER_MS) {
      return accessToken;
    }
    return refreshUserToken(userId, workspaceId);
  } catch (err) {
    logger.warn({ userId, err }, "No stored user token, falling back to PAT");
    return getPatFallback(workspaceId, userId);
  }
}

/**
 * One refresh of a user's token at a time, across API instances. GitHub
 * rotates the refresh token on use, so two instances refreshing the same
 * user at once would leave one of them with a dead refresh token: the
 * refresh runs under the lease `github-refresh:<userId>`; an instance that
 * finds it held waits for the holder and then reads the token the holder
 * stored, refreshing itself only if that token still isn't fresh. Within
 * one instance concurrent callers share one promise, as before.
 */
async function refreshUserToken(userId: string, workspaceId?: string | null): Promise<string> {
  const existing = refreshLocks.get(userId);
  if (existing) return existing;

  const refreshPromise = refreshUserTokenAcrossInstances(userId, workspaceId);
  refreshLocks.set(userId, refreshPromise);
  try {
    return await refreshPromise;
  } finally {
    refreshLocks.delete(userId);
  }
}

const REFRESH_LEASE_TTL_MS = 30_000;
const REFRESH_WAIT_MS = 30_000;

async function refreshUserTokenAcrossInstances(
  userId: string,
  workspaceId?: string | null,
): Promise<string> {
  const key = `github-refresh:${userId}`;
  const deadline = Date.now() + REFRESH_WAIT_MS;
  for (;;) {
    let result: string | null;
    try {
      result = await withLease(key, () => doRefreshUserToken(userId, workspaceId), {
        ttlMs: REFRESH_LEASE_TTL_MS,
      });
    } catch (err) {
      if (!(err instanceof LeaseLostError)) throw err;
      // The lease lapsed under the refresh (the database away for longer
      // than the TTL). Whatever the refresh did is stored: use it if it
      // landed, else go round again.
      logger.warn({ userId }, "GitHub token refresh outlived its lease");
      const stored = await storedFreshToken(userId);
      if (stored) return stored;
      if (Date.now() < deadline) continue;
      throw err;
    }
    if (result !== null) return result;

    // Another instance is refreshing this user: wait for it to let go, then
    // use what it stored.
    await new Promise((r) => setTimeout(r, 250));
    if (await leaseHolder(key)) {
      if (Date.now() < deadline) continue;
      logger.warn({ userId }, "Waited too long for another instance's GitHub token refresh");
      return doRefreshUserToken(userId, workspaceId);
    }
    const stored = await storedFreshToken(userId);
    if (stored) return stored;
    // The other instance's refresh didn't leave a fresh token: refresh ourselves.
  }
}

/** The user's stored access token while it is fresh, else null. */
async function storedFreshToken(userId: string): Promise<string | null> {
  try {
    const accessToken = await retrieveSecret("GITHUB_USER_ACCESS_TOKEN", `user:${userId}`);
    const expiresAt = await retrieveSecret("GITHUB_USER_TOKEN_EXPIRES_AT", `user:${userId}`);
    return Date.now() < new Date(expiresAt).getTime() - TOKEN_REFRESH_BUFFER_MS
      ? accessToken
      : null;
  } catch {
    return null;
  }
}

async function doRefreshUserToken(userId: string, workspaceId?: string | null): Promise<string> {
  const clientId = process.env.GITHUB_APP_CLIENT_ID;
  const clientSecret = process.env.GITHUB_APP_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    await deleteUserGitHubTokens(userId);
    return getPatFallback(workspaceId, userId);
  }

  try {
    const refreshToken = await retrieveSecret("GITHUB_USER_REFRESH_TOKEN", `user:${userId}`);

    const res = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });

    if (!res.ok) throw new Error(`GitHub token refresh failed: ${res.status}`);

    const data = (await res.json()) as Record<string, string | number>;
    if (data.error) {
      const errorCode = String(data.error);
      // Only delete tokens on definitive revocation — not transient failures
      if (errorCode === "bad_refresh_token" || errorCode === "incorrect_client_credentials") {
        logger.error({ userId, errorCode }, "GitHub token revoked, deleting stored tokens");
        await deleteUserGitHubTokens(userId);
      }
      throw new Error(`GitHub token refresh error: ${errorCode}`);
    }

    const newAccessToken = data.access_token as string;
    const newRefreshToken = data.refresh_token as string;
    const expiresIn = (data.expires_in as number) ?? 28800;

    await storeUserGitHubTokens(userId, {
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
      expiresIn,
    });

    return newAccessToken;
  } catch (err) {
    // Don't delete tokens on transient errors (network, 5xx) — only the
    // definitive revocation cases above delete them before re-throwing.
    logger.warn({ userId, err }, "Token refresh failed, falling back to PAT");
    return getPatFallback(workspaceId, userId);
  }
}

/**
 * Last-resort fallback: try to retrieve a manually-configured GITHUB_TOKEN PAT.
 * Returns the token if found, throws a descriptive error if not.
 */
async function getPatFallback(workspaceId?: string | null, userId?: string): Promise<string> {
  try {
    return await retrieveSecretWithFallback("GITHUB_TOKEN", "global", workspaceId, userId);
  } catch {
    if (userId && isGitHubAppConfigured()) return getInstallationToken();
    throw new Error(
      "No GitHub token available. Configure a GitHub App (recommended) or add a GITHUB_TOKEN secret.",
    );
  }
}

export async function storeUserGitHubTokens(
  userId: string,
  tokens: { accessToken: string; refreshToken: string; expiresIn: number },
): Promise<void> {
  const scope = `user:${userId}`;
  const expiresAt = new Date(Date.now() + tokens.expiresIn * 1000).toISOString();
  await Promise.all([
    storeSecret("GITHUB_USER_ACCESS_TOKEN", tokens.accessToken, scope),
    storeSecret("GITHUB_USER_REFRESH_TOKEN", tokens.refreshToken, scope),
    storeSecret("GITHUB_USER_TOKEN_EXPIRES_AT", expiresAt, scope),
  ]);
}

export async function deleteUserGitHubTokens(userId: string): Promise<void> {
  const scope = `user:${userId}`;
  await Promise.all([
    deleteSecret("GITHUB_USER_ACCESS_TOKEN", scope),
    deleteSecret("GITHUB_USER_REFRESH_TOKEN", scope),
    deleteSecret("GITHUB_USER_TOKEN_EXPIRES_AT", scope),
  ]);
}
