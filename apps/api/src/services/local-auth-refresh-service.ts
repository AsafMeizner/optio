/**
 * Refresh the cluster's CLAUDE_CODE_OAUTH_TOKEN from a paired machine's own
 * Claude Code login, through the Optio Local daemon — no Keychain one-liner,
 * no paste. The server asks the daemon for the machine's access token
 * (`credentials` frame), validates it against Anthropic, and stores it the
 * way the Secrets page would. Two ways in:
 *
 *  - explicit: POST /api/auth/claude-token/refresh-from-host (admin, own host)
 *  - automatic: the token-validation worker finds the stored token expired,
 *    or a capable daemon connects while it is known-expired — the server
 *    refreshes on its own and only shows the paste banner if that fails.
 *
 * Only a host owned by a workspace admin (or any host in auth-disabled dev)
 * may supply a token: it is the same power the Secrets page gates on admin.
 */
import { randomUUID } from "node:crypto";
import type { LocalDaemonMessage } from "@optio/shared";
import { logger } from "../logger.js";
import * as relay from "./local-relay.js";
import { getHost, type LocalHostRow } from "./local-host-service.js";
import { isAuthDisabled } from "./oauth/index.js";
import { getUserRole } from "./workspace-service.js";
import { invalidateCredentialsCache, invalidateUsageCache } from "./auth-service.js";
import { storeSecret } from "./secret-service.js";
import { publishEvent } from "./event-bus.js";
import { validateClaudeToken, recordTokenValidation } from "../workers/token-validation-worker.js";
import { like } from "drizzle-orm";
import { db } from "../db/client.js";
import { leases } from "../db/schema.js";
import { acquireLease } from "./lease-service.js";

/**
 * A daemon whose own login has expired runs `claude` once to renew it before
 * answering (up to 90s there), so the wait is generous.
 */
const REQUEST_TIMEOUT_MS = 120_000;
/** Don't hammer a machine whose token is also stale: one automatic attempt per host per window. */
const AUTO_RETRY_WINDOW_MS = 10 * 60_000;

type CredentialsResult = Extract<LocalDaemonMessage, { type: "credentials-result" }>;

interface Pending {
  hostId: string;
  resolve: (r: CredentialsResult) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const pending = new Map<string, Pending>();

/**
 * One automatic attempt per host per window, across every API instance: a
 * lease nobody renews (each claim names a fresh holder, so it is taken only
 * once the last one lapsed).
 */
const AUTO_ATTEMPT_LEASE = (hostId: string) => `claude-auto-refresh:${hostId}`;
function claimAutoAttempt(hostId: string): Promise<boolean> {
  return acquireLease(AUTO_ATTEMPT_LEASE(hostId), AUTO_RETRY_WINDOW_MS, randomUUID());
}

export type RefreshOutcome = { ok: true; hostId: string } | { ok: false; error: string };

/**
 * Ask a host's daemon — connected here or to another instance — for its
 * Claude access token. Rejects when offline or silent.
 */
export function requestCredentials(hostId: string): Promise<CredentialsResult> {
  const requestId = randomUUID();
  const answer = new Promise<CredentialsResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error("The machine did not answer in time"));
    }, REQUEST_TIMEOUT_MS);
    pending.set(requestId, { hostId, resolve, reject, timer });
  });
  void relay
    .sendToHost(hostId, { type: "credentials", requestId })
    .catch(() => false)
    .then((sent) => {
      const p = pending.get(requestId);
      if (sent || !p) return;
      clearTimeout(p.timer);
      pending.delete(requestId);
      p.reject(new Error("The machine is offline"));
    });
  return answer;
}

/** A daemon answered. Ignored unless the request is pending for that same host. */
export function deliverCredentialsResult(hostId: string, msg: CredentialsResult): boolean {
  const p = pending.get(msg.requestId);
  if (!p || p.hostId !== hostId) return false;
  clearTimeout(p.timer);
  pending.delete(msg.requestId);
  p.resolve(msg);
  return true;
}

/** Whether this host's owner is allowed to seed the cluster's Claude token. */
export async function hostMayRefreshToken(host: LocalHostRow): Promise<boolean> {
  if (!host.userId) return isAuthDisabled();
  if (!host.workspaceId) return false;
  return (await getUserRole(host.workspaceId, host.userId)) === "admin";
}

/**
 * Pull the token from `host`, validate it, store it. `trigger` is for the
 * log line. Never throws: every failure is an outcome the UI can show.
 */
export async function refreshClaudeTokenFromHost(
  host: LocalHostRow,
  trigger: "manual" | "auto",
): Promise<RefreshOutcome> {
  const caps = await relay.hostCapabilities(host.id);
  if (!caps?.claudeCredentials) {
    return {
      ok: false,
      error: caps
        ? "That machine has no Claude Code login to share — run `claude` on it and sign in"
        : "That machine is offline",
    };
  }
  let result: CredentialsResult;
  try {
    result = await requestCredentials(host.id);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (!result.token) {
    return { ok: false, error: result.error ?? "The machine sent no token" };
  }
  const token = result.token.trim();
  if (!/^sk-ant-oat01-[A-Za-z0-9_-]{20,}$/.test(token) || token.length > 1024) {
    return { ok: false, error: "The machine sent something that is not a Claude OAuth token" };
  }
  const validation = await validateClaudeToken(token);
  if (!validation.valid) {
    return {
      ok: false,
      error: `The token on ${host.name} is expired too and \`claude\` there could not renew it — sign in again on that machine`,
    };
  }
  // Global scope: that's what the token-validation worker, the usage probe,
  // and agent pods read (the same row scripts/update-claude-auth.sh writes).
  await storeSecret("CLAUDE_CODE_OAUTH_TOKEN", token, "global", null, null);
  invalidateCredentialsCache();
  invalidateUsageCache();
  await recordTokenValidation({ valid: true, tokenExists: true }).catch(() => {});
  await publishEvent({ type: "auth:status_changed", timestamp: new Date().toISOString() }).catch(
    () => {},
  );
  logger.info(
    { hostId: host.id, host: host.name, trigger },
    "Claude OAuth token refreshed from a paired machine",
  );
  return { ok: true, hostId: host.id };
}

/**
 * Try every online, credential-bearing host whose owner may seed the token
 * (each at most once per window). True when one of them worked.
 */
export async function autoRefreshClaudeToken(reason: string): Promise<boolean> {
  for (const { hostId } of await relay.hostsWithClaudeCredentials()) {
    if (!(await claimAutoAttempt(hostId))) continue;
    const host = await getHost(hostId);
    if (!host || !(await hostMayRefreshToken(host))) continue;
    const outcome = await refreshClaudeTokenFromHost(host, "auto");
    if (outcome.ok) return true;
    logger.info({ hostId, reason, error: outcome.error }, "automatic Claude token refresh skipped");
  }
  return false;
}

/**
 * A capable daemon just connected: if the stored token is known-expired (or
 * missing), refresh from it right away so "start the daemon" is the fix.
 */
export async function maybeRefreshOnHello(host: LocalHostRow): Promise<void> {
  const { getCachedTokenValidation } = await import("../workers/token-validation-worker.js");
  const cached = await getCachedTokenValidation();
  if (!cached || (cached.valid && cached.tokenExists)) return;
  if (!(await hostMayRefreshToken(host))) return;
  if (!(await claimAutoAttempt(host.id))) return;
  await refreshClaudeTokenFromHost(host, "auto");
}

export async function resetAuthRefreshForTests(): Promise<void> {
  for (const p of pending.values()) clearTimeout(p.timer);
  pending.clear();
  await db.delete(leases).where(like(leases.key, "claude-auto-refresh:%"));
}
