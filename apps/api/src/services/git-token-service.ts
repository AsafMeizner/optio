import type { GitPlatform, GitPlatformType, RepoIdentifier } from "@optio/shared";
import { parseRepoUrl } from "@optio/shared";
import { getGitHubToken } from "./github-token-service.js";
import { retrieveSecretWithFallback } from "./secret-service.js";
import { getCodeCommitCredentials } from "./codecommit-credential-service.js";
import { createGitPlatform } from "./git-platform/index.js";
import { logger } from "../logger.js";

export interface GitTokenContext {
  userId?: string;
  workspaceId?: string | null;
  server?: boolean;
}

/**
 * Resolve a git platform token for the given platform and context.
 * GitHub: delegates to the existing github-token-service (App → user OAuth → PAT).
 * GitLab: checks GITLAB_TOKEN secret (workspace-scoped → global).
 * CodeCommit: returns a JSON-encoded AWS credential blob (or "workload-identity"
 * sentinel) — see codecommit-credential-service.
 */
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

  // GitLab: try user-scoped token, then workspace/global GITLAB_TOKEN
  if (context.userId) {
    try {
      return await retrieveSecretWithFallback(
        "GITLAB_USER_ACCESS_TOKEN",
        `user:${context.userId}`,
        context.workspaceId,
      );
    } catch {
      logger.debug({ userId: context.userId }, "No user GitLab token, trying global");
    }
  }

  try {
    return await retrieveSecretWithFallback("GITLAB_TOKEN", "global", context.workspaceId);
  } catch {
    // Fall back to env var
    const envToken = process.env.GITLAB_TOKEN;
    if (envToken) return envToken;
    throw new Error(
      "No GitLab token available. Add a GITLAB_TOKEN secret or set the GITLAB_TOKEN environment variable.",
    );
  }
}

/** Hosts named in comma-separated env vars, lower-cased. */
function envHosts(...names: string[]): string[] {
  return names
    .flatMap((name) => (process.env[name] ?? "").split(","))
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Hosts the deployment's git credentials may be sent to without a lookup:
 * github.com, gitlab.com, and the hosts an operator listed (`GITLAB_HOSTS` /
 * `OPTIO_GITLAB_HOSTS`; `GITHUB_HOSTS` / `OPTIO_GITHUB_HOSTS` for GitHub
 * Enterprise).
 */
export function isListedGitHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "github.com" || h === "gitlab.com") return true;
  return envHosts(
    "GITLAB_HOSTS",
    "OPTIO_GITLAB_HOSTS",
    "GITHUB_HOSTS",
    "OPTIO_GITHUB_HOSTS",
  ).includes(h);
}

/**
 * May the API attach the deployment's git token to API calls for this repo?
 * The API host comes from the repo / PR URL — any host other than
 * github.com is taken for GitHub Enterprise (`https://<host>/api/v3`), any
 * host containing "gitlab" for GitLab — and those URLs reach here from people
 * (ad-hoc tasks, `/api/pull-requests/status?prUrl=`) and from agents (the PR
 * URL an agent printed). Only built-in or deployment-configured hosts get
 * tokens. Workspace admins may register repositories, but registration is
 * not permission to receive deployment credentials. CodeCommit is reached
 * through the AWS SDK by region, never by the URL's host.
 */
export async function isTrustedGitHost(
  ri: Pick<RepoIdentifier, "host" | "platform">,
): Promise<boolean> {
  if (ri.platform === "codecommit") return true;
  return isListedGitHost(ri.host);
}

/**
 * Parse a repo URL, resolve the appropriate token, and create a GitPlatform instance.
 * This is the primary entry point for consumers that need to interact with a git platform.
 * Throws for a host the deployment's credentials must not go to (`isTrustedGitHost`).
 */
export async function getGitPlatformForRepo(
  repoUrl: string,
  context: GitTokenContext & { platformHint?: GitPlatformType },
): Promise<{ platform: GitPlatform; ri: RepoIdentifier }> {
  const ri = parseRepoUrl(repoUrl);
  if (!ri) throw new Error(`Cannot parse repo URL: ${repoUrl}`);

  // Allow callers with a repo record to skip URL-based platform detection
  if (context.platformHint) ri.platform = context.platformHint;

  if (!(await isTrustedGitHost(ri))) {
    throw new Error(
      `Refusing to send git credentials to ${ri.host}: a deployment operator must list ` +
        "the host in GITHUB_HOSTS / GITLAB_HOSTS",
    );
  }

  const token = await getGitToken(ri.platform, context);
  const platform = createGitPlatform(ri.platform, token);

  return { platform, ri };
}
