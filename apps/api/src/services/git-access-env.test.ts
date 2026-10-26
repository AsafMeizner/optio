import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const installationToken = vi.hoisted(() => vi.fn());
vi.mock("./github-app-service.js", () => ({
  isGitHubAppConfigured: () => true,
  getInstallationToken: installationToken,
}));
vi.mock("./secret-service.js", () => ({
  retrieveSecretWithFallback: vi.fn().mockRejectedValue(new Error("none")),
}));

import { applyGitAccess } from "./git-access-env.js";
import { parseGitCredentialScope } from "./git-credential-scope.js";

beforeEach(() => {
  vi.stubEnv("OPTIO_ENCRYPTION_KEY", "unit-test-git-access-key");
  installationToken.mockReset().mockResolvedValue("ghs_repo");
});
afterEach(() => vi.unstubAllEnvs());

describe("applyGitAccess", () => {
  it("gives a turn a token for its own repo only", async () => {
    const env: Record<string, string> = {};
    await applyGitAccess(env, {
      workspaceId: null,
      repoUrl: "https://github.com/acme/widgets.git",
      helper: false,
    });
    expect(installationToken).toHaveBeenCalledWith({ owner: "acme", name: "widgets" });
    expect(env.GITHUB_TOKEN).toBe("ghs_repo");
  });

  it("gives a turn on a non-GitHub repo no GitHub App token", async () => {
    const env: Record<string, string> = {};
    await applyGitAccess(env, {
      workspaceId: null,
      repoUrl: "https://gitlab.com/acme/widgets",
      helper: false,
    });
    expect(installationToken).not.toHaveBeenCalled();
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });

  it("binds the credential helper's signed scope to the pod's repo", async () => {
    const env: Record<string, string> = {};
    await applyGitAccess(env, {
      workspaceId: null,
      ownerUserId: null,
      repoUrl: "git@github.com:Acme/Widgets.git",
    });
    const scope = new URL(env.OPTIO_GIT_CREDENTIAL_URL).searchParams.get("scope")!;
    expect(parseGitCredentialScope(scope)).toEqual({
      workspaceId: null,
      ownerUserId: null,
      repo: "https://github.com/acme/widgets",
    });
    expect(env.OPTIO_CREDENTIAL_SECRET).toMatch(/^[0-9a-f]{64}$/);
  });
});
