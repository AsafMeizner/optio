import type { GitPlatform, GitPlatformType, RepoIdentifier } from "@optio/shared";
import { parseRepoUrl } from "@optio/shared";
import { getGitHubToken } from "./github-token-service.js";
import { retrieveSecret, retrieveSecretWithFallback } from "./secret-service.js";
import { getCodeCommitCredentials } from "./codecommit-credential-service.js";
import { createGitPlatform } from "./git-platform/index.js";
import { logger } from "../logger.js";

export interface GitTokenContext {
  userId?: string;
  workspaceId?: string | null;
  server?: boolean;
  /** The GitLab host whose token is being requested. */
  host?: string | null;
}

/**
 * Resolve a git platform token for the given platform and context.
 * GitHub: delegates to the existing github-token-service (App → user OAuth → PAT).
 * GitLab: host-specific token, then plain token, at the personal / workspace / global scopes.
 * CodeCommit: returns a JSON-encoded AWS credential blob (or "workload-identity"
 * sentinel) — see codecommit-credential-service.
 */
export function gitLabTokenNameForHost(host: string): string {
  return `GITLAB_TOKEN_${host
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "_")}`;
}

export async function getGitToken(
  platform: GitPlatformType,
  context: GitTokenContext,
): Promise<string> {
  if (platform === "github") {
    if (context.server) return getGitHubToken({ server: true, workspaceId: context.workspaceId });
    if (context.userId)
      return getGitHubToken({ userId: context.userId, workspaceId: context.workspaceId });
    return getGitHubToken({ server: true, workspaceId: context.workspaceId });
  }

  if (platform === "codecommit") {
    return getCodeCommitCredentials(context.workspaceId);
  }

  // The person's own token, then the workspace's and organization's,
  // then the environment. Prefer the host-specific name at each scope.
  const userId = context.server ? null : (context.userId ?? null);
  const hostName = context.host ? gitLabTokenNameForHost(context.host) : null;
  const names = hostName ? [hostName, "GITLAB_TOKEN"] : ["GITLAB_TOKEN"];
  const lookups: Array<() => Promise<string>> = [];
  if (userId) {
    for (const name of names) {
      lookups.push(() => retrieveSecret(name, "user", undefined, userId));
    }
    lookups.push(() =>
      retrieveSecretWithFallback("GITLAB_USER_ACCESS_TOKEN", `user:${userId}`, context.workspaceId),
    );
  }
  for (const name of names) {
    lookups.push(() => retrieveSecretWithFallback(name, "global", context.workspaceId));
  }
  for (const lookup of lookups) {
    try {
      return await lookup();
    } catch {
      // Not at this scope — try the next.
    }
  }
  const envToken = (hostName ? process.env[hostName] : undefined) || process.env.GITLAB_TOKEN;
  if (envToken) return envToken;
  throw new Error(
    "No GitLab token available. Add a GITLAB_TOKEN secret or set the GITLAB_TOKEN environment variable.",
  );
}

/**
 * Parse a repo URL, resolve the appropriate token, and create a GitPlatform instance.
 * This is the primary entry point for consumers that need to interact with a git platform.
 */
export async function getGitPlatformForRepo(
  repoUrl: string,
  context: GitTokenContext & { platformHint?: GitPlatformType },
): Promise<{ platform: GitPlatform; ri: RepoIdentifier }> {
  const ri = parseRepoUrl(repoUrl);
  if (!ri) throw new Error(`Cannot parse repo URL: ${repoUrl}`);

  // Allow callers with a repo record to skip URL-based platform detection
  if (context.platformHint) ri.platform = context.platformHint;

  const token = await getGitToken(
    ri.platform,
    ri.platform === "gitlab" ? { ...context, host: ri.host } : context,
  );
  const platform = createGitPlatform(ri.platform, token);

  return { platform, ri };
}
