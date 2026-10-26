/**
 * How a pod signs in to git — the same for every pod that clones or pushes: a
 * Repo Task, a review, a persistent agent with a repo.
 *
 * Repo pods use Optio's credential helper (a GitHub App installation token
 * from /api/internal/git-credentials, signed with an owner/workspace-derived
 * key). Persistent agents use a short-lived installation token. Without a GitHub App, both use the workspace's GitHub / GitLab
 * tokens.
 */
import {
  gitCredentialScope,
  gitCredentialKey,
  installationRepoFor,
} from "./git-credential-scope.js";
import { getInstallationToken, isGitHubAppConfigured } from "./github-app-service.js";
import { retrieveSecretWithFallback } from "./secret-service.js";

const apiInternalUrl = () =>
  process.env.OPTIO_API_INTERNAL_URL ?? `http://localhost:${process.env.API_PORT ?? "4000"}`;

/**
 * Add git sign-in to a pod's env, in place. A token the env already has (the
 * caller's own pick) wins over the workspace's. `runId` scopes the per-run
 * credential URL (user-scoped git operations at exec time); `helper: false`
 * signs in with a token instead of the credential helper. `repoUrl` is the
 * one repo the pod works in: every GitHub App installation token it gets is
 * limited to that repo (null: a pod with no repo — the installation's).
 */
export async function applyGitAccess(
  env: Record<string, string>,
  opts: {
    workspaceId: string | null;
    ownerUserId?: string | null;
    repoUrl: string | null;
    runId?: string;
    helper?: boolean;
  },
): Promise<void> {
  for (const name of ["GITHUB_TOKEN", "GITLAB_TOKEN", "GITLAB_HOST"]) {
    if (env[name]) continue;
    const value = await retrieveSecretWithFallback(
      name,
      "global",
      opts.workspaceId,
      opts.ownerUserId,
    ).catch(() => null);
    if (value) env[name] = value;
  }
  if (opts.helper === false) {
    // A turn's installation token (an hour) rather than a long-lived one,
    // limited to the turn's repo; none for a repo that isn't on GitHub.
    if (isGitHubAppConfigured()) {
      const repo = opts.repoUrl ? installationRepoFor(opts.repoUrl) : null;
      if (repo) env.GITHUB_TOKEN = await getInstallationToken(repo);
      else if (!opts.repoUrl) env.GITHUB_TOKEN = await getInstallationToken();
    }
    return;
  }
  const scope = gitCredentialScope({
    workspaceId: opts.workspaceId,
    ownerUserId: opts.ownerUserId ?? null,
    repoUrl: opts.repoUrl,
  });
  const base = `${apiInternalUrl()}/api/internal/git-credentials?scope=${scope}`;
  // Pod-level: repo-init.sh's clone with the installation token.
  env.OPTIO_GIT_CREDENTIAL_URL = base;
  // Run-level: injected at exec time for user-scoped git operations.
  if (opts.runId) env.OPTIO_GIT_TASK_CREDENTIAL_URL = base;
  env.OPTIO_CREDENTIAL_SECRET = gitCredentialKey(scope);
  // With a GitHub App the helper mints tokens; a static one would only leak.
  if (isGitHubAppConfigured()) delete env.GITHUB_TOKEN;
}
