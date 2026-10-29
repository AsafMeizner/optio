import { beforeEach, describe, expect, it, vi } from "vitest";

const mockIsGitHubAppConfigured = vi.fn();

vi.mock("./github-app-service.js", () => ({
  getInstallationToken: vi.fn(),
  isGitHubAppConfigured: (...args: unknown[]) => mockIsGitHubAppConfigured(...args),
}));

const mockRetrieveSecretWithFallback = vi.fn();
vi.mock("./secret-service.js", () => ({
  retrieveSecretWithFallback: (...args: unknown[]) => mockRetrieveSecretWithFallback(...args),
}));

import { requiredGitTokenSecret } from "./git-access-env.js";

describe("requiredGitTokenSecret", () => {
  beforeEach(() => {
    mockIsGitHubAppConfigured.mockReset();
  });

  it("leaves GitLab tokens optional for host-only and environment setups, GitHub App or not", () => {
    mockIsGitHubAppConfigured.mockReturnValue(false);
    expect(requiredGitTokenSecret("gitlab")).toBeNull();
    mockIsGitHubAppConfigured.mockReturnValue(true);
    expect(requiredGitTokenSecret("gitlab")).toBeNull();
  });

  it("requires GitHub's token for a GitHub repo without a GitHub App", () => {
    mockIsGitHubAppConfigured.mockReturnValue(false);
    expect(requiredGitTokenSecret("github")).toBe("GITHUB_TOKEN");
    expect(requiredGitTokenSecret(undefined)).toBe("GITHUB_TOKEN");
  });

  it("requires none when a GitHub App mints installation tokens", () => {
    mockIsGitHubAppConfigured.mockReturnValue(true);
    expect(requiredGitTokenSecret("github")).toBeNull();
  });
});
