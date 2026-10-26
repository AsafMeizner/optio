import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const registeredRows: { id: string }[] = [];
const limit = vi.fn(async () => registeredRows);
vi.mock("../db/client.js", () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit }) }) }) },
}));
vi.mock("./github-token-service.js", () => ({
  getGitHubToken: vi.fn(async () => "ghs_server_token"),
}));
vi.mock("./secret-service.js", () => ({
  retrieveSecretWithFallback: vi.fn(async () => "glpat-server-token"),
}));
vi.mock("./codecommit-credential-service.js", () => ({
  getCodeCommitCredentials: vi.fn(async () => "workload-identity"),
}));

import { getGitPlatformForRepo, isListedGitHost, isTrustedGitHost } from "./git-token-service.js";

const ENV_KEYS = ["GITLAB_HOSTS", "OPTIO_GITLAB_HOSTS", "GITHUB_HOSTS", "OPTIO_GITHUB_HOSTS"];
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  registeredRows.length = 0;
  limit.mockClear();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("isListedGitHost", () => {
  it("lists github.com, gitlab.com and the operator's hosts", () => {
    expect(isListedGitHost("github.com")).toBe(true);
    expect(isListedGitHost("GitLab.com")).toBe(true);
    expect(isListedGitHost("git.corp.example")).toBe(false);
    process.env.GITLAB_HOSTS = "git.corp.example, other.example";
    process.env.GITHUB_HOSTS = "ghe.corp.example";
    expect(isListedGitHost("git.corp.example")).toBe(true);
    expect(isListedGitHost("ghe.corp.example")).toBe(true);
  });
});

describe("isTrustedGitHost", () => {
  it("trusts the host of a registered repo, and nothing else", async () => {
    const registered = vi.fn(async (h: string) => h === "ghe.corp.example");
    expect(
      await isTrustedGitHost({ host: "ghe.corp.example", platform: "github" }, registered),
    ).toBe(true);
    expect(
      await isTrustedGitHost({ host: "attacker.example", platform: "github" }, registered),
    ).toBe(false);
    expect(
      await isTrustedGitHost({ host: "gitlab.attacker.example", platform: "gitlab" }, registered),
    ).toBe(false);
  });

  it("trusts CodeCommit (reached by region through the AWS SDK)", async () => {
    expect(
      await isTrustedGitHost(
        { host: "git-codecommit.us-east-1.amazonaws.com", platform: "codecommit" },
        async () => false,
      ),
    ).toBe(true);
  });
});

describe("getGitPlatformForRepo", () => {
  it("refuses to hand the server token to an unregistered, unlisted host", async () => {
    // A PR URL on a host someone controls: the GitHub client would call
    // https://attacker.example/api/v3/... with `Authorization: Bearer <token>`.
    await expect(
      getGitPlatformForRepo("https://attacker.example/o/r", { server: true }),
    ).rejects.toThrow(/Refusing to send git credentials to attacker\.example/);
    await expect(
      getGitPlatformForRepo("https://gitlab.attacker.example/g/r", { server: true }),
    ).rejects.toThrow(/Refusing/);
  });

  it("serves github.com, listed hosts and registered hosts as before", async () => {
    const gh = await getGitPlatformForRepo("https://github.com/o/r", { server: true });
    expect(gh.ri.apiBaseUrl).toBe("https://api.github.com");
    expect(limit).not.toHaveBeenCalled();

    process.env.GITLAB_HOSTS = "git.corp.example";
    const gl = await getGitPlatformForRepo("https://git.corp.example/g/r", { server: true });
    expect(gl.platform.type).toBe("gitlab");

    registeredRows.push({ id: "repo-1" });
    const ghe = await getGitPlatformForRepo("https://ghe.corp.example/o/r", { server: true });
    expect(ghe.ri.apiBaseUrl).toBe("https://ghe.corp.example/api/v3");
    expect(limit).toHaveBeenCalledTimes(1);
  });
});
