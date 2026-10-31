import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorldSnapshot } from "@optio/shared";
vi.mock("../db/client.js", () => ({
  db: {
    select: () => ({
      from: () => ({ where: async () => [{ createdBy: "u-1", workspaceId: "ws-1" }] }),
    }),
  },
}));
vi.mock("./github-token-service.js", () => ({ getGitHubToken: vi.fn() }));
vi.mock("./secret-service.js", () => ({ retrieveSecretWithFallback: vi.fn() }));
vi.mock("./codecommit-credential-service.js", () => ({ getCodeCommitCredentials: vi.fn() }));
import { retrieveSecretWithFallback } from "./secret-service.js";
import { getGitHubToken } from "./github-token-service.js";
import { loadResumeFacts } from "./resume-facts.js";
afterEach(() => vi.unstubAllGlobals());
describe("resume facts deployment trust boundary", () => {
  it.each(["gitlab.attacker.invalid", "attacker.invalid"])(
    "refuses %s before resolving credentials or calling the network",
    async (host) => {
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      const repoUrl = `https://${host}/org/repo`;
      const snap = {
        run: {
          kind: "repo",
          ref: { id: "task-1" },
          spec: { repoUrl, repoBranch: "develop", workspaceId: "ws-1" },
          status: {
            prUrl: `${repoUrl}/${host.startsWith("gitlab") ? "-/merge_requests" : "pull"}/1`,
          },
        },
      } as unknown as WorldSnapshot;
      expect(await loadResumeFacts(snap, "ci_failure")).toEqual({ targetBranch: "develop" });
      expect(retrieveSecretWithFallback).not.toHaveBeenCalled();
      expect(getGitHubToken).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});
