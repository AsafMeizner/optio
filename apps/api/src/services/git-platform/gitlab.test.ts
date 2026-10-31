import { setOutboundDefaults } from "../../utils/outbound-url.js";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  GitLabApiError,
  GitLabNotReadyError,
  GitLabPlatform,
  classifyGitLabFailure,
} from "./gitlab.js";
import { determineReviewStatus } from "../../workers/pr-watcher-worker.js";
import { buildCommentsSection } from "../ticket-context.js";
import type { RepoIdentifier } from "@optio/shared";

const ri: RepoIdentifier = {
  platform: "gitlab",
  host: "gitlab.com",
  owner: "acme",
  repo: "widgets",
  apiBaseUrl: "https://gitlab.com/api/v4",
};

const projectId = encodeURIComponent("acme/widgets");
const mockFetch = vi.fn();

describe("GitLabPlatform", () => {
  let platform: GitLabPlatform;
  let originalFetch: typeof globalThis.fetch;
  let restoreOutbound: () => void;

  beforeEach(() => {
    restoreOutbound = setOutboundDefaults({
      resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
      fetchImpl: mockFetch,
    });
    originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as any;
    platform = new GitLabPlatform("glpat-test123");
    mockFetch.mockReset();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    restoreOutbound();
  });

  function mockJsonResponse(data: any, ok = true, status = 200) {
    mockFetch.mockResolvedValueOnce({
      ok,
      status,
      json: () => Promise.resolve(data),
      text: () => Promise.resolve(JSON.stringify(data)),
    });
  }

  it("has type gitlab", () => {
    expect(platform.type).toBe("gitlab");
  });

  describe("change-request authority", () => {
    async function reviews(
      options: {
        resolvable?: boolean;
        assigned?: boolean;
        own?: boolean;
        access?: number;
        memberError?: boolean;
        authorId?: number;
      } = {},
    ) {
      mockJsonResponse({ approved_by: [] });
      mockJsonResponse([
        {
          id: 1,
          author: { id: options.authorId ?? 42, username: "same-name" },
          body: "Changes requested: please change this",
          resolvable: options.resolvable ?? true,
          resolved: false,
          created_at: "2026-10-01",
        },
      ]);
      mockJsonResponse(options.assigned ? [{ user: { id: 42, username: "reviewer" } }] : []);
      if (options.resolvable !== false && !options.assigned && options.authorId !== 0) {
        mockJsonResponse({ id: options.own ? 42 : 99, username: "same-name" });
        if (!options.own)
          mockJsonResponse(
            options.memberError
              ? { message: "503 Service Unavailable" }
              : [{ id: 42, username: "same-name", access_level: options.access ?? 10 }],
            !options.memberError,
            options.memberError ? 503 : 200,
          );
      }
      return platform.getReviews(ri, 7);
    }
    it("ignores a Guest's resolvable request despite a matching token username", async () => {
      expect((await reviews())[0].state).toBe("COMMENTED");
      expect(String(mockFetch.mock.calls[4][0])).toBe(
        `https://gitlab.com/api/v4/projects/${projectId}/members/all?per_page=100&user_ids%5B%5D=42`,
      );
    });
    it("ignores plain notes even from an assigned reviewer", async () => {
      expect((await reviews({ assigned: true, resolvable: false }))[0].state).toBe("COMMENTED");
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });
    it("accepts an assigned reviewer's resolvable thread", async () => {
      expect((await reviews({ assigned: true }))[0].state).toBe("CHANGES_REQUESTED");
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });
    it("accepts the token user's resolvable thread by numeric ID", async () => {
      expect((await reviews({ own: true }))[0].state).toBe("CHANGES_REQUESTED");
      expect(mockFetch).toHaveBeenCalledTimes(4);
    });
    it("accepts a Developer's resolvable thread", async () => {
      expect((await reviews({ access: 30 }))[0].state).toBe("CHANGES_REQUESTED");
    });
    it("rejects authors without a stable numeric ID", async () => {
      expect((await reviews({ authorId: 0 }))[0].state).toBe("COMMENTED");
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });
    it("checks many change-request authors in one members read", async () => {
      const authors = Array.from({ length: 40 }, (_, i) => 1000 + i);
      mockJsonResponse({ approved_by: [] });
      mockJsonResponse(
        authors.map((id, i) => ({
          id: i + 1,
          author: { id, username: `guest${id}` },
          body: "Changes requested: no",
          resolvable: true,
          resolved: false,
          created_at: `2026-10-01T00:00:${String(i).padStart(2, "0")}Z`,
        })),
      );
      mockJsonResponse([]);
      mockJsonResponse({ id: 99, username: "optio-bot" });
      mockJsonResponse([
        { id: 1005, access_level: 10 },
        { id: 1007, access_level: 30 },
      ]);

      const states = (await platform.getReviews(ri, 7)).map((r) => r.state);

      expect(mockFetch).toHaveBeenCalledTimes(5);
      expect(states.filter((s) => s === "CHANGES_REQUESTED")).toHaveLength(1);
      expect(states[7]).toBe("CHANGES_REQUESTED");
    });
    it("fails closed when a GitLab that ignores user_ids fills the page with others", async () => {
      mockJsonResponse({ approved_by: [] });
      mockJsonResponse([
        {
          id: 1,
          author: { id: 42, username: "someone" },
          body: "Changes requested: please",
          resolvable: true,
          resolved: false,
          created_at: "2026-10-01",
        },
      ]);
      mockJsonResponse([]);
      mockJsonResponse({ id: 99, username: "optio-bot" });
      mockJsonResponse(Array.from({ length: 100 }, (_, i) => ({ id: 500 + i, access_level: 40 })));

      await expect(platform.getReviews(ri, 7)).rejects.toThrow("GitLab review state is incomplete");
    });
    it("fails closed when membership authority cannot be read", async () => {
      await expect(reviews({ memberError: true })).rejects.toThrow(
        "GitLab review state is incomplete",
      );
    });
  });

  describe("getPullRequest", () => {
    it("fetches MR and maps to PullRequest", async () => {
      mockJsonResponse({
        iid: 7,
        title: "Add feature",
        description: "Implements X",
        state: "opened",
        draft: false,
        sha: "def456",
        diff_refs: { head_sha: "def456" },
        target_branch: "main",
        web_url: "https://gitlab.com/acme/widgets/-/merge_requests/7",
        author: { username: "alice" },
        assignees: [],
        labels: ["feature"],
        merge_status: "can_be_merged",
        created_at: "2024-01-01",
        updated_at: "2024-01-02",
      });

      const pr = await platform.getPullRequest(ri, 7);

      expect(mockFetch).toHaveBeenCalledWith(
        `https://gitlab.com/api/v4/projects/${projectId}/merge_requests/7`,
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer glpat-test123",
          }),
        }),
      );
      expect(pr.number).toBe(7);
      expect(pr.title).toBe("Add feature");
      expect(pr.body).toBe("Implements X");
      expect(pr.state).toBe("open");
      expect(pr.merged).toBe(false);
      expect(pr.mergeable).toBe(true);
      expect(pr.headSha).toBe("def456");
    });

    it("maps merged MR state correctly", async () => {
      mockJsonResponse({
        iid: 8,
        state: "merged",
        title: "",
        description: "",
        sha: "abc",
        target_branch: "main",
        web_url: "",
        author: { username: "bob" },
        merge_status: "can_be_merged",
        created_at: "",
        updated_at: "",
      });

      const pr = await platform.getPullRequest(ri, 8);
      expect(pr.state).toBe("closed");
      expect(pr.merged).toBe(true);
    });
  });

  describe("getCIChecks", () => {
    it("fetches pipelines then jobs", async () => {
      // First call: pipelines
      mockJsonResponse([{ id: 100 }]);
      // Second call: jobs
      mockJsonResponse([
        { name: "build", status: "success" },
        { name: "test", status: "failed" },
        { name: "deploy", status: "manual" },
      ]);

      // Third call: trigger jobs (none)
      mockJsonResponse([]);

      const checks = await platform.getCIChecks(ri, "abc123");

      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(mockFetch.mock.calls[0][0]).toContain(`/pipelines?sha=abc123`);
      expect(mockFetch.mock.calls[1][0]).toContain(`/pipelines/100/jobs`);
      expect(mockFetch.mock.calls[2][0]).toContain(`/pipelines/100/bridges`);
      expect(checks).toEqual([
        { name: "build", status: "completed", conclusion: "success" },
        { name: "test", status: "completed", conclusion: "failure" },
        { name: "deploy", status: "completed", conclusion: "skipped" },
      ]);
    });

    it("returns empty array when no pipelines", async () => {
      mockJsonResponse([]);
      const checks = await platform.getCIChecks(ri, "abc123");
      expect(checks).toEqual([]);
    });

    it("uses the MR's head pipeline (a merged-results pipeline runs on another SHA)", async () => {
      mockJsonResponse({
        iid: 7,
        state: "opened",
        sha: "head1",
        head_pipeline: { id: 555, sha: "merge-commit", status: "running" },
      });
      await platform.getPullRequest(ri, 7);
      mockJsonResponse([{ name: "test", status: "running" }]);
      mockJsonResponse([]);

      const checks = await platform.getCIChecks(ri, "head1");

      const urls = mockFetch.mock.calls.map((c) => String(c[0]));
      expect(urls.some((u) => u.includes("/pipelines?sha="))).toBe(false);
      expect(urls[1]).toContain("/pipelines/555/jobs");
      expect(checks).toEqual([{ name: "test", status: "in_progress", conclusion: null }]);
    });

    it("looks the pipeline up by SHA when the MR read was for another head", async () => {
      mockJsonResponse({ iid: 7, state: "opened", sha: "old", head_pipeline: { id: 1 } });
      await platform.getPullRequest(ri, 7);
      mockJsonResponse([{ id: 2, status: "success" }]);
      mockJsonResponse([{ name: "build", status: "success" }]);
      mockJsonResponse([]);

      await platform.getCIChecks(ri, "new");

      expect(String(mockFetch.mock.calls[1][0])).toContain("/pipelines?sha=new");
      expect(String(mockFetch.mock.calls[2][0])).toContain("/pipelines/2/jobs");
    });

    it("a job allowed to fail doesn't fail the checks (passed with warnings)", async () => {
      mockJsonResponse([{ id: 3, status: "success" }]);
      mockJsonResponse([
        { name: "build", status: "success" },
        { name: "lint", status: "failed", allow_failure: true },
      ]);
      mockJsonResponse([]);

      const checks = await platform.getCIChecks(ri, "abc");

      expect(checks).toEqual([
        { name: "build", status: "completed", conclusion: "success" },
        { name: "lint", status: "completed", conclusion: "skipped" },
      ]);
    });

    it("counts trigger jobs (child pipelines) as checks", async () => {
      mockJsonResponse([{ id: 4, status: "failed" }]);
      mockJsonResponse([{ name: "build", status: "success" }]);
      mockJsonResponse([{ name: "trigger-e2e", status: "failed" }]);

      const checks = await platform.getCIChecks(ri, "abc");

      expect(checks).toContainEqual({
        name: "trigger-e2e",
        status: "completed",
        conclusion: "failure",
      });
    });

    it("the pipeline's own status wins over a job list that says nothing", async () => {
      // Failed, but no listed job failed (an older GitLab without the bridges API)
      mockJsonResponse([{ id: 5, status: "failed" }]);
      mockJsonResponse([{ name: "build", status: "success" }]);
      mockJsonResponse({ message: "404 Not Found" }, false, 404);
      expect(await platform.getCIChecks(ri, "a")).toContainEqual({
        name: "pipeline #5",
        status: "completed",
        conclusion: "failure",
      });

      // Still running with every listed job done
      mockJsonResponse([{ id: 6, status: "running" }]);
      mockJsonResponse([{ name: "build", status: "success" }]);
      mockJsonResponse([]);
      expect(await platform.getCIChecks(ri, "b")).toContainEqual({
        name: "pipeline #6",
        status: "in_progress",
        conclusion: null,
      });

      // A pipeline with no jobs listed at all
      mockJsonResponse([{ id: 7, status: "success" }]);
      mockJsonResponse([]);
      mockJsonResponse([]);
      expect(await platform.getCIChecks(ri, "c")).toEqual([
        { name: "pipeline #7", status: "completed", conclusion: "success" },
      ]);
    });

    it("reads every page of a large pipeline's jobs", async () => {
      mockJsonResponse([{ id: 8, status: "success" }]);
      const page = Array.from({ length: 100 }, (_, i) => ({ name: `j${i}`, status: "success" }));
      mockJsonResponse(page);
      mockJsonResponse([]); // bridges
      mockJsonResponse([{ name: "j100", status: "success" }]);

      const checks = await platform.getCIChecks(ri, "abc");

      expect(checks).toHaveLength(101);
    });
  });

  describe("getReviews", () => {
    it("combines approvals and discussion notes", async () => {
      // Approvals
      mockJsonResponse({
        approved_by: [{ user: { username: "alice" } }],
      });
      // Notes
      mockJsonResponse([
        { author: { username: "bob" }, body: "Looks good", system: false },
        { author: { username: "system" }, body: "merged", system: true },
      ]);
      // Reviewers
      mockJsonResponse([]);

      const reviews = await platform.getReviews(ri, 7);

      expect(reviews).toEqual([
        { author: "alice", state: "APPROVED", body: "" },
        { author: "bob", state: "COMMENTED", body: "Looks good" },
      ]);
    });

    it("tolerates the approvals 404 (CE) and the reviewers 404 (older GitLab)", async () => {
      mockJsonResponse({ message: "404 Not Found" }, false, 404);
      mockJsonResponse([{ author: { username: "bob" }, body: "LGTM", system: false }]);
      mockJsonResponse({ message: "404 Not Found" }, false, 404);

      const reviews = await platform.getReviews(ri, 7);

      expect(reviews).toEqual([{ author: "bob", state: "COMMENTED", body: "LGTM" }]);
    });

    it("reports a failed reviewers read as incomplete, so the merge guard blocks", async () => {
      mockJsonResponse({ approved_by: [] });
      mockJsonResponse([]);
      mockJsonResponse({ message: "500 Internal Server Error" }, false, 500);

      await expect(platform.getReviews(ri, 7)).rejects.toThrow("GitLab review state is incomplete");
    });

    it("reports a failed approvals read (other than 404) or a network error as incomplete", async () => {
      mockJsonResponse({ message: "403 Forbidden" }, false, 403);
      mockJsonResponse([]);
      mockJsonResponse([]);
      await expect(platform.getReviews(ri, 7)).rejects.toThrow("GitLab review state is incomplete");

      mockJsonResponse({ approved_by: [] });
      mockJsonResponse([]);
      mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));
      await expect(platform.getReviews(ri, 7)).rejects.toThrow("GitLab review state is incomplete");
    });

    it("reads a reviewer's requested changes last", async () => {
      mockJsonResponse({ approved_by: [{ user: { username: "alice" } }] });
      mockJsonResponse([]);
      mockJsonResponse([
        { user: { username: "carol" }, state: "requested_changes" },
        { user: { username: "dave" }, state: "reviewed" },
      ]);

      const reviews = await platform.getReviews(ri, 7);

      expect(reviews).toEqual([
        { author: "alice", state: "APPROVED", body: "" },
        { author: "carol", state: "CHANGES_REQUESTED", body: "" },
      ]);
      expect(mockFetch.mock.calls[2][0]).toBe(
        `https://gitlab.com/api/v4/projects/${projectId}/merge_requests/7/reviewers`,
      );
    });
  });

  describe("mergePullRequest", () => {
    it("guards an automatic merge with the checked head SHA", async () => {
      mockJsonResponse({ state: "merged" });
      await platform.mergePullRequest(ri, 7, "squash", "checked-head");
      expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({
        should_remove_source_branch: true,
        squash: true,
        sha: "checked-head",
      });
    });

    it("sends PUT with squash option", async () => {
      mockJsonResponse({ state: "merged" });

      await platform.mergePullRequest(ri, 7, "squash");

      const call = mockFetch.mock.calls[0];
      expect(call[0]).toBe(
        `https://gitlab.com/api/v4/projects/${projectId}/merge_requests/7/merge`,
      );
      expect(call[1].method).toBe("PUT");
      const body = JSON.parse(call[1].body);
      expect(body.squash).toBe(true);
      expect(body.should_remove_source_branch).toBe(true);
    });

    it("'rebase' rebases with GitLab first (there is no merge_method), then merges the result", async () => {
      vi.useFakeTimers();
      try {
        mockJsonResponse({ rebase_in_progress: true });
        mockJsonResponse({ iid: 7, rebase_in_progress: false, sha: "rebased" });
        mockJsonResponse({ state: "merged" });
        const done = platform.mergePullRequest(ri, 7, "rebase");
        await vi.runAllTimersAsync();
        await done;
        expect(mockFetch.mock.calls[0][0]).toContain("/merge_requests/7/rebase");
        const body = JSON.parse(mockFetch.mock.calls[2][1].body);
        expect(body).toEqual({ should_remove_source_branch: true, sha: "rebased" });
        expect(body).not.toHaveProperty("merge_method");
      } finally {
        vi.useRealTimers();
      }
    });

    describe("while GitLab is still checking the MR (405 / 406)", () => {
      beforeEach(() => vi.useFakeTimers());
      afterEach(() => vi.useRealTimers());

      const notAllowed = () =>
        mockFetch.mockResolvedValueOnce({
          ok: false,
          status: 405,
          text: () => Promise.resolve('{"message":"405 Method Not Allowed"}'),
        });

      it("polls the MR until it is mergeable, then merges", async () => {
        notAllowed();
        mockJsonResponse({ iid: 7, state: "opened", detailed_merge_status: "checking" });
        mockJsonResponse({ iid: 7, state: "opened", detailed_merge_status: "mergeable" });
        mockJsonResponse({ state: "merged" });
        const done = platform.mergePullRequest(ri, 7, "squash", "head");
        await vi.runAllTimersAsync();
        await expect(done).resolves.toBeUndefined();
        expect(mockFetch.mock.calls.map((c) => c[1]?.method ?? "GET")).toEqual([
          "PUT",
          "GET",
          "GET",
          "PUT",
        ]);
      });

      it("gives up with GitLabNotReadyError after 5 polls that stay unchecked", async () => {
        notAllowed();
        for (let i = 0; i < 5; i++) {
          mockJsonResponse({ iid: 7, state: "opened", detailed_merge_status: "unchecked" });
        }
        const done = platform.mergePullRequest(ri, 7, "merge");
        const caught = done.catch((e) => e);
        await vi.runAllTimersAsync();
        const err = await caught;
        expect(err).toBeInstanceOf(GitLabNotReadyError);
        expect(err.mergeStatus).toBe("unchecked");
        expect(mockFetch).toHaveBeenCalledTimes(6);
      });

      it("a blocker that isn't a check in progress is not-ready at once", async () => {
        notAllowed();
        mockJsonResponse({ iid: 7, state: "opened", detailed_merge_status: "ci_must_pass" });
        const caught = platform.mergePullRequest(ri, 7, "merge").catch((e) => e);
        await vi.runAllTimersAsync();
        const err = await caught;
        expect(err).toBeInstanceOf(GitLabNotReadyError);
        expect(err.mergeStatus).toBe("ci_must_pass");
        expect(mockFetch).toHaveBeenCalledTimes(2);
      });

      it("an MR that only needs a rebase is rebased by GitLab, then merged", async () => {
        notAllowed();
        mockJsonResponse({ iid: 7, state: "opened", detailed_merge_status: "need_rebase" });
        mockJsonResponse({ rebase_in_progress: true }); // PUT /rebase
        mockJsonResponse({ iid: 7, rebase_in_progress: true, sha: "old" });
        mockJsonResponse({ iid: 7, rebase_in_progress: false, merge_error: null, sha: "rebased" });
        mockJsonResponse({ state: "merged" });
        const done = platform.mergePullRequest(ri, 7, "merge");
        await vi.runAllTimersAsync();
        await expect(done).resolves.toBeUndefined();
        const calls = mockFetch.mock.calls.map((c) => `${c[1]?.method ?? "GET"} ${c[0]}`);
        expect(calls[2]).toMatch(/^PUT .*\/merge_requests\/7\/rebase$/);
        expect(calls[3]).toContain("include_rebase_in_progress=true");
        expect(calls[5]).toMatch(/^PUT .*\/merge_requests\/7\/merge$/);
        expect(JSON.parse(mockFetch.mock.calls[5][1].body).sha).toBe("rebased");
      });

      it("a merge guarded by a checked head waits for CI on the rebased head", async () => {
        notAllowed();
        mockJsonResponse({ iid: 7, state: "opened", detailed_merge_status: "need_rebase" });
        mockJsonResponse({ rebase_in_progress: true });
        mockJsonResponse({ iid: 7, rebase_in_progress: false, sha: "rebased" });
        const caught = platform.mergePullRequest(ri, 7, "squash", "checked").catch((e) => e);
        await vi.runAllTimersAsync();
        const err = await caught;
        expect(err).toBeInstanceOf(GitLabNotReadyError);
        expect(err.mergeStatus).toBe("need_rebase");
        expect(mockFetch).toHaveBeenCalledTimes(4);
        // A pinned squash merge still has GitLab rebase (documented on
        // mergePullRequest), but leaves the rebased head for a later pass.
        const calls = mockFetch.mock.calls.map((c) => `${c[1]?.method ?? "GET"} ${c[0]}`);
        expect(calls[2]).toMatch(/^PUT .*\/merge_requests\/7\/rebase$/);
        expect(calls.filter((c) => /^PUT .*\/merge$/.test(c))).toHaveLength(1);
      });

      it("a rebase GitLab couldn't do is a conflict", async () => {
        notAllowed();
        mockJsonResponse({ iid: 7, state: "opened", detailed_merge_status: "need_rebase" });
        mockJsonResponse({ rebase_in_progress: true });
        mockJsonResponse({
          iid: 7,
          rebase_in_progress: false,
          merge_error:
            "Rebase failed: Rebase locally, resolve all conflicts, then push the branch.",
          sha: "old",
        });
        const caught = platform.mergePullRequest(ri, 7, "merge").catch((e) => e);
        await vi.runAllTimersAsync();
        const err = await caught;
        expect(err).toBeInstanceOf(GitLabNotReadyError);
        expect(err.mergeStatus).toBe("conflict");
      });

      it("an MR merged meanwhile is done", async () => {
        notAllowed();
        mockJsonResponse({ iid: 7, state: "merged", detailed_merge_status: "not_open" });
        const done = platform.mergePullRequest(ri, 7, "merge");
        await vi.runAllTimersAsync();
        await expect(done).resolves.toBeUndefined();
      });
    });

    it("other errors stay GitLabApiErrors, with their status", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 409,
        text: () => Promise.resolve("SHA does not match HEAD"),
      });
      const err = await platform.mergePullRequest(ri, 7, "merge", "old").catch((e) => e);
      expect(err).toBeInstanceOf(GitLabApiError);
      expect(err.status).toBe(409);
      expect(err.message).toBe("GitLab API error 409: SHA does not match HEAD");
    });
  });

  describe("submitReview", () => {
    it("approves and posts body as note", async () => {
      // Approve call
      mockJsonResponse({});
      // Note call
      mockJsonResponse({});

      const result = await platform.submitReview(ri, 7, {
        event: "APPROVE",
        body: "Ship it!",
      });

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch.mock.calls[0][0]).toContain("/approve");
      expect(mockFetch.mock.calls[1][0]).toContain("/notes");
      expect(result.url).toContain("merge_requests/7");
    });

    it("posts REQUEST_CHANGES with prefix", async () => {
      // Note call (no approve call for REQUEST_CHANGES)
      mockJsonResponse({});

      await platform.submitReview(ri, 7, {
        event: "REQUEST_CHANGES",
        body: "Fix tests",
      });

      const noteBody = JSON.parse(mockFetch.mock.calls[0][1].body).body;
      expect(noteBody).toContain("**Changes Requested:**");
      expect(noteBody).toContain("Fix tests");
    });
  });

  describe("listIssues", () => {
    it("maps GitLab issue fields", async () => {
      mockJsonResponse([
        {
          id: 1,
          iid: 10,
          title: "Bug",
          description: "broken",
          state: "opened",
          web_url: "https://gitlab.com/acme/widgets/-/issues/10",
          labels: ["bug"],
          author: { username: "alice" },
          assignee: null,
          created_at: "2024-01-01",
          updated_at: "2024-01-02",
        },
      ]);

      const issues = await platform.listIssues(ri, { state: "open" });

      expect(mockFetch.mock.calls[0][0]).toContain("state=opened");
      expect(issues).toHaveLength(1);
      expect(issues[0].number).toBe(10);
      expect(issues[0].state).toBe("open");
      expect(issues[0].body).toBe("broken");
      expect(issues[0].isPullRequest).toBe(false);
    });
  });

  describe("closeIssue", () => {
    it("sends PUT with state_event close", async () => {
      mockJsonResponse({});

      await platform.closeIssue(ri, 10);

      const call = mockFetch.mock.calls[0];
      expect(call[1].method).toBe("PUT");
      const body = JSON.parse(call[1].body);
      expect(body.state_event).toBe("close");
    });
  });

  describe("createLabel", () => {
    it("ignores 409 (already exists)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 409,
        text: () => Promise.resolve("already exists"),
      });

      await expect(
        platform.createLabel(ri, { name: "optio", color: "6d28d9" }),
      ).resolves.not.toThrow();
    });

    it("prepends # to color", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(""),
      });

      await platform.createLabel(ri, { name: "optio", color: "6d28d9" });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.color).toBe("#6d28d9");
    });
  });

  describe("getRepoMetadata", () => {
    it("maps GitLab project fields", async () => {
      mockJsonResponse({
        path_with_namespace: "acme/widgets",
        default_branch: "develop",
        visibility: "private",
      });

      const meta = await platform.getRepoMetadata(ri);

      expect(meta).toEqual({
        fullName: "acme/widgets",
        defaultBranch: "develop",
        isPrivate: true,
      });
    });

    it("detects public visibility", async () => {
      mockJsonResponse({
        path_with_namespace: "acme/widgets",
        default_branch: "main",
        visibility: "public",
      });

      const meta = await platform.getRepoMetadata(ri);
      expect(meta.isPrivate).toBe(false);
    });
  });

  describe("listRepoContents", () => {
    it("uses repository/tree endpoint", async () => {
      mockJsonResponse([
        { name: "README.md", type: "blob" },
        { name: "src", type: "tree" },
      ]);

      const contents = await platform.listRepoContents(ri);

      expect(mockFetch.mock.calls[0][0]).toContain("/repository/tree");
      expect(contents).toEqual([
        { name: "README.md", type: "file" },
        { name: "src", type: "dir" },
      ]);
    });
  });

  describe("error handling", () => {
    it("throws on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: () => Promise.resolve("Not Found"),
      });

      await expect(platform.getPullRequest(ri, 999)).rejects.toThrow("GitLab API error 404");
    });

    it("keeps GitLab's rate-limit headers and classifies a 429, 401 and 403", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response("Retry later", {
          status: 429,
          headers: {
            "Retry-After": "30",
            "RateLimit-Remaining": "0",
            "RateLimit-Reset": "2000000000",
          },
        }),
      );
      const err = await platform.getPullRequest(ri, 1).catch((e) => e);
      expect(err).toBeInstanceOf(GitLabApiError);
      expect(err).toMatchObject({
        status: 429,
        retryAfterMs: 30_000,
        rateLimitRemaining: 0,
        rateLimitResetMs: 2_000_000_000_000,
      });
      expect(classifyGitLabFailure(err)).toEqual({
        kind: "primary_rate_limit",
        retryAfterMs: 30_000,
        resetAtMs: 2_000_000_000_000,
      });

      // No reset header: Retry-After from now
      const before = Date.now();
      const noReset = classifyGitLabFailure(new GitLabApiError(429, "", { retryAfterMs: 5_000 }));
      expect(noReset?.resetAtMs).toBeGreaterThanOrEqual(before + 5_000);

      expect(classifyGitLabFailure(new GitLabApiError(401, ""))?.kind).toBe("auth");
      expect(classifyGitLabFailure(new GitLabApiError(403, ""))?.kind).toBe("permission");
      expect(classifyGitLabFailure(new GitLabApiError(500, ""))).toBeNull();
      expect(classifyGitLabFailure(new Error("GitLab API error 429"))).toBeNull();
    });
  });

  describe("a review that requests changes", () => {
    const note = (author: string, body: string, created_at: string, extra: object = {}) => ({
      author: {
        id: author === "carol" ? 201 : author === "optio-bot" ? 202 : 203,
        username: author,
      },
      resolvable: true,
      resolved: false,
      body,
      created_at,
      system: false,
      ...extra,
    });
    const approvedNote = (author: string, created_at: string) => ({
      author: { username: author },
      body: "approved this merge request",
      created_at,
      system: true,
    });

    it("reads a note opening with 'Changes requested:' as CHANGES_REQUESTED, so the work resumes", async () => {
      mockJsonResponse({ approved_by: [] });
      // newest first, as asked
      mockJsonResponse([
        note("optio-bot", "Changes requested: the retry loop never ends", "2026-01-02T00:00:00Z"),
        note("bob", "Looks mostly fine", "2026-01-01T00:00:00Z"),
      ]);
      mockJsonResponse({ message: "404 Not Found" }, false, 404);
      mockJsonResponse({ id: 202, username: "optio-bot" });

      const reviews = await platform.getReviews(ri, 7);

      expect(reviews).toEqual([
        { author: "bob", state: "COMMENTED", body: "Looks mostly fine" },
        {
          author: "optio-bot",
          state: "CHANGES_REQUESTED",
          body: "Changes requested: the retry loop never ends",
        },
      ]);
      expect(determineReviewStatus(reviews)).toEqual({
        status: "changes_requested",
        comments: "Changes requested: the retry loop never ends",
      });
      expect(String(mockFetch.mock.calls[1][0])).toBe(
        `https://gitlab.com/api/v4/projects/${projectId}/merge_requests/7/notes?sort=desc&order_by=created_at&per_page=100&page=1`,
      );
    });

    it("also reads the bold form submitReview and the review prompts post", async () => {
      mockJsonResponse({ approved_by: [] });
      mockJsonResponse([note("carol", "**Changes Requested:**\n\nFix it", "2026-01-01T00:00:00Z")]);
      mockJsonResponse([
        { user: { id: 201, username: "carol" } },
        { user: { id: 202, username: "optio-bot" } },
      ]);

      const [review] = await platform.getReviews(ri, 7);

      expect(review.state).toBe("CHANGES_REQUESTED");
    });

    it("a resolved change-request thread is settled", async () => {
      mockJsonResponse({ approved_by: [] });
      mockJsonResponse([
        note("carol", "**Changes Requested:**\n\nFix it", "2026-01-01T00:00:00Z", {
          resolvable: true,
          resolved: true,
        }),
      ]);
      mockJsonResponse([
        { user: { id: 201, username: "carol" } },
        { user: { id: 202, username: "optio-bot" } },
      ]);

      const reviews = await platform.getReviews(ri, 7);

      expect(reviews.map((r) => r.state)).toEqual(["COMMENTED"]);
      expect(determineReviewStatus(reviews).status).toBe("pending");
    });

    it("the reviewer's approval after their change request supersedes it", async () => {
      mockJsonResponse({ approved_by: [{ user: { username: "carol" } }] });
      mockJsonResponse([
        approvedNote("carol", "2026-01-03T00:00:00Z"),
        note("carol", "Changes requested: fix it", "2026-01-02T00:00:00Z"),
      ]);
      mockJsonResponse([
        { user: { id: 201, username: "carol" } },
        { user: { id: 202, username: "optio-bot" } },
      ]);

      const reviews = await platform.getReviews(ri, 7);

      expect(reviews.map((r) => r.state)).toEqual(["CHANGES_REQUESTED", "APPROVED"]);
      expect(determineReviewStatus(reviews).status).toBe("approved");
    });

    it("an approval before the change request does not", async () => {
      mockJsonResponse({ approved_by: [{ user: { username: "carol" } }] });
      mockJsonResponse([
        note("carol", "Changes requested: one more thing", "2026-01-03T00:00:00Z"),
        approvedNote("carol", "2026-01-02T00:00:00Z"),
      ]);
      mockJsonResponse([
        { user: { id: 201, username: "carol" } },
        { user: { id: 202, username: "optio-bot" } },
      ]);

      const reviews = await platform.getReviews(ri, 7);

      expect(reviews.map((r) => r.state)).toEqual(["APPROVED", "CHANGES_REQUESTED"]);
      expect(determineReviewStatus(reviews).status).toBe("changes_requested");
    });

    it("approve, request changes, approve again: the fresh approval settles the request", async () => {
      // The second approval was refused as already given, so submitReview
      // withdrew and re-gave it: GitLab's notes then date it after the request.
      mockJsonResponse({ approved_by: [{ user: { username: "carol" } }] });
      mockJsonResponse([
        approvedNote("carol", "2026-01-04T00:00:01Z"),
        {
          author: { username: "carol" },
          body: "unapproved this merge request",
          created_at: "2026-01-04T00:00:00Z",
          system: true,
        },
        note("carol", "Changes requested: one more thing", "2026-01-03T00:00:00Z"),
        approvedNote("carol", "2026-01-02T00:00:00Z"),
      ]);
      mockJsonResponse([
        { user: { id: 201, username: "carol" } },
        { user: { id: 202, username: "optio-bot" } },
      ]);

      const reviews = await platform.getReviews(ri, 7);

      expect(reviews.map((r) => r.state)).toEqual(["CHANGES_REQUESTED", "APPROVED"]);
      expect(determineReviewStatus(reviews).status).toBe("approved");
    });

    it("a note that only mentions changes is a comment", async () => {
      mockJsonResponse({ approved_by: [] });
      mockJsonResponse([note("bob", "The changes requested last week look fine", "2026-01-01")]);
      mockJsonResponse([
        { user: { id: 201, username: "carol" } },
        { user: { id: 202, username: "optio-bot" } },
      ]);

      expect((await platform.getReviews(ri, 7)).map((r) => r.state)).toEqual(["COMMENTED"]);
    });

    it("a failed notes read leaves the list incomplete, since a change request may be missing", async () => {
      mockJsonResponse({ approved_by: [] });
      mockJsonResponse({ message: "500 Internal Server Error" }, false, 500);
      mockJsonResponse([
        { user: { id: 201, username: "carol" } },
        { user: { id: 202, username: "optio-bot" } },
      ]);

      await expect(platform.getReviews(ri, 7)).rejects.toThrow("GitLab review state is incomplete");
    });

    it("reads a busy MR's newest notes: a full page asks for the next", async () => {
      const older = Array.from({ length: 100 }, (_, i) =>
        note("bob", `note ${i}`, `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}Z`),
      );
      mockJsonResponse({ approved_by: [] });
      mockJsonResponse(older);
      mockJsonResponse([note("bob", "oldest", "2025-12-31T00:00:00Z")]);
      mockJsonResponse([
        { user: { id: 201, username: "carol" } },
        { user: { id: 202, username: "optio-bot" } },
      ]);

      const reviews = await platform.getReviews(ri, 7);

      expect(reviews).toHaveLength(101);
      expect(String(mockFetch.mock.calls[2][0])).toContain("sort=desc");
      expect(String(mockFetch.mock.calls[2][0])).toContain("page=2");
    });
  });

  describe("MR conversation", () => {
    it("reads the MR's own notes for its discussion, not issue #7's", async () => {
      mockJsonResponse([
        {
          author: { username: "bob" },
          body: "On line 3",
          position: { new_path: "a.ts", new_line: 3 },
          system: false,
        },
        { author: { username: "bob" }, body: "Why this approach?", system: false, created_at: "t" },
        { author: { username: "ghost" }, body: "added 1 commit", system: true },
      ]);

      const comments = await platform.getPullRequestComments(ri, 7);

      expect(comments).toEqual([{ author: "bob", body: "Why this approach?", createdAt: "t" }]);
      expect(String(mockFetch.mock.calls[0][0])).toContain(
        `/projects/${projectId}/merge_requests/7/notes?`,
      );
    });

    it("issue comments still come from the issue", async () => {
      mockJsonResponse([{ author: { username: "dana" }, body: "Repro steps", system: false }]);

      const comments = await platform.getIssueComments(ri, 7);

      expect(comments.map((c) => c.body)).toEqual(["Repro steps"]);
      expect(String(mockFetch.mock.calls[0][0])).toContain(
        `/projects/${projectId}/issues/7/notes?`,
      );
    });

    it("an issue's prompt gets its 30 newest comments, from one page", async () => {
      const notes = Array.from({ length: 100 }, (_, i) => ({
        author: { username: "dana" },
        body: `comment ${99 - i} ${"x".repeat(1000)}`,
        created_at: `t${99 - i}`,
        system: false,
      }));
      mockJsonResponse(notes); // newest first, a full page

      const comments = await platform.getIssueComments(ri, 7);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(comments).toHaveLength(30);
      expect(comments[0].createdAt).toBe("t70");
      expect(comments[29].createdAt).toBe("t99");
      expect(buildCommentsSection(comments).length).toBeLessThan(40_000);
    });

    it("leaves resolved threads out of the inline comments", async () => {
      mockJsonResponse([
        {
          author: { username: "bob" },
          body: "still open",
          position: { new_path: "a.ts", new_line: 3 },
          resolvable: true,
          resolved: false,
          system: false,
        },
        {
          author: { username: "bob" },
          body: "done",
          position: { new_path: "a.ts", new_line: 9 },
          resolvable: true,
          resolved: true,
          system: false,
        },
      ]);

      const inline = await platform.getInlineComments(ri, 7);

      expect(inline.map((c) => c.body)).toEqual(["still open"]);
    });
  });

  describe("MRs from a fork", () => {
    it("names the source project as the head repo", async () => {
      mockJsonResponse({
        iid: 9,
        source_branch: "fix",
        source_project_id: 42,
        target_project_id: 7,
      });
      mockJsonResponse({ id: 42, path_with_namespace: "someone/widgets" });

      const pr = await platform.getPullRequest(ri, 9);

      expect(pr.headRepo).toBe("someone/widgets");
      expect(mockFetch.mock.calls[1][0]).toBe("https://gitlab.com/api/v4/projects/42");
    });

    it("an MR from the project itself needs no lookup and has no head repo", async () => {
      mockJsonResponse([{ iid: 1, source_project_id: 7, target_project_id: 7 }]);

      const [pr] = await platform.listOpenPullRequests(ri);

      expect(pr.headRepo).toBeUndefined();
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("a fork the token can't see leaves the head repo unknown", async () => {
      mockJsonResponse([{ iid: 1, source_project_id: 42, target_project_id: 7 }]);
      mockJsonResponse({ message: "404 Project Not Found" }, false, 404);

      const [pr] = await platform.listOpenPullRequests(ri);

      expect(pr.headRepo).toBeUndefined();
    });
  });

  describe("submitReview findings", () => {
    const diffRefs = { diff_refs: { base_sha: "b", start_sha: "s", head_sha: "h" } };

    it("puts a comment on a removed line (side LEFT) on the old file", async () => {
      mockJsonResponse({}); // note
      mockJsonResponse(diffRefs);
      mockJsonResponse({}); // discussion

      await platform.submitReview(ri, 7, {
        event: "COMMENT",
        body: "Two things",
        comments: [{ path: "a.ts", line: 4, side: "LEFT", body: "This was needed" }],
      });

      const position = JSON.parse(mockFetch.mock.calls[2][1].body).position;
      expect(position.old_line).toBe(4);
      expect(position.new_line).toBeUndefined();
    });

    it("posts a finding GitLab won't place on the diff as a located note", async () => {
      mockJsonResponse({}); // note
      mockJsonResponse(diffRefs);
      mockJsonResponse({ message: "400 line_code can't be blank" }, false, 400);
      mockJsonResponse({}); // fallback note

      await platform.submitReview(ri, 7, {
        event: "COMMENT",
        body: "One thing",
        comments: [{ path: "a.ts", line: 40, body: "Unchecked input" }],
      });

      expect(mockFetch.mock.calls[3][0]).toContain("/merge_requests/7/notes");
      expect(JSON.parse(mockFetch.mock.calls[3][1].body).body).toBe(
        "**a.ts:40**\n\nUnchecked input",
      );
    });

    it("requests changes in a resolvable thread", async () => {
      mockJsonResponse({});

      await platform.submitReview(ri, 7, { event: "REQUEST_CHANGES", body: "Fix tests" });

      expect(mockFetch.mock.calls[0][0]).toBe(
        `https://gitlab.com/api/v4/projects/${projectId}/merge_requests/7/discussions`,
      );
      expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({
        body: "**Changes Requested:**\n\nFix tests",
      });
    });

    it("approves the reviewed commit, and stops when the MR has moved on", async () => {
      mockJsonResponse({});
      mockJsonResponse({});
      await platform.submitReview(ri, 7, { event: "APPROVE", body: "Ship it", commitId: "abc" });
      expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({ sha: "abc" });

      mockFetch.mockReset();
      mockJsonResponse({ message: "SHA does not match HEAD of source branch" }, false, 409);
      await expect(
        platform.submitReview(ri, 7, { event: "APPROVE", body: "Ship it", commitId: "old" }),
      ).rejects.toMatchObject({ status: 409 });
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("an approval GitLab refuses for another reason still posts the review", async () => {
      mockJsonResponse({ message: "401 Unauthorized" }, false, 401);
      mockJsonResponse({ user_has_approved: false });
      mockJsonResponse({});

      await platform.submitReview(ri, 7, { event: "APPROVE", body: "Ship it" });

      expect(mockFetch.mock.calls[1][0]).toContain("/merge_requests/7/approvals");
      expect(mockFetch.mock.calls[2][0]).toContain("/notes");
    });

    it("an approval the reviewer already gave is withdrawn and given again, dated now", async () => {
      mockJsonResponse({ message: "401 Unauthorized" }, false, 401);
      mockJsonResponse({ user_has_approved: true });
      mockJsonResponse({}); // unapprove
      mockJsonResponse({}); // approve
      mockJsonResponse({}); // note

      await platform.submitReview(ri, 7, { event: "APPROVE", body: "Fixed", commitId: "abc" });

      const calls = mockFetch.mock.calls.map((c) => [c[1]?.method ?? "GET", String(c[0])]);
      expect(calls.map(([m, u]) => `${m} ${u.split("/merge_requests/7")[1]}`)).toEqual([
        "POST /approve",
        "GET /approvals",
        "POST /unapprove",
        "POST /approve",
        "POST /notes",
      ]);
      expect(JSON.parse(mockFetch.mock.calls[3][1].body)).toEqual({ sha: "abc" });
    });

    it("a re-approval refused because the MR moved on stops the submission", async () => {
      mockJsonResponse({ message: "401 Unauthorized" }, false, 401);
      mockJsonResponse({ user_has_approved: true });
      mockJsonResponse({}); // unapprove
      mockJsonResponse({ message: "SHA does not match HEAD of source branch" }, false, 409);

      await expect(
        platform.submitReview(ri, 7, { event: "APPROVE", body: "Fixed", commitId: "old" }),
      ).rejects.toMatchObject({ status: 409 });
      expect(mockFetch).toHaveBeenCalledTimes(4);
    });
  });
  describe("mergeable from detailed_merge_status", () => {
    const read = async (fields: Record<string, unknown>) => {
      mockJsonResponse({ iid: 7, state: "opened", ...fields });
      return platform.getPullRequest(ri, 7);
    };

    it("is unknown while GitLab is still checking, whatever merge_status says", async () => {
      for (const s of ["unchecked", "checking", "preparing"]) {
        const pr = await read({ detailed_merge_status: s, merge_status: "can_be_merged" });
        expect(pr.mergeable).toBeNull();
        expect(pr.mergeStatus).toBe(s);
      }
    });

    it("is true when mergeable, false for a conflict", async () => {
      expect((await read({ detailed_merge_status: "mergeable" })).mergeable).toBe(true);
      expect((await read({ detailed_merge_status: "conflict" })).mergeable).toBe(false);
    });

    it("a branch that is only behind (need_rebase) is no conflict", async () => {
      const pr = await read({
        detailed_merge_status: "need_rebase",
        merge_status: "cannot_be_merged",
      });
      expect(pr.mergeable).toBe(true);
      expect(pr.mergeStatus).toBe("need_rebase");
    });

    it("a blocker that isn't a conflict (CI) leaves it to merge_status", async () => {
      const pr = await read({
        detailed_merge_status: "ci_must_pass",
        merge_status: "can_be_merged",
      });
      expect(pr.mergeable).toBe(true);
      expect(pr.mergeStatus).toBe("ci_must_pass");
    });
  });
  describe("listBranches", () => {
    it("searches repository/branches and puts the default branch first", async () => {
      mockJsonResponse([
        { name: "release/1.0", default: false, protected: true },
        { name: "release/main", default: true, protected: true },
        { name: "release/wip", default: false, protected: false },
      ]);

      const branches = await platform.listBranches(ri, { search: "rel", perPage: 20 });

      expect(String(mockFetch.mock.calls[0][0])).toBe(
        `https://gitlab.com/api/v4/projects/${projectId}/repository/branches?per_page=20&search=rel`,
      );
      expect(mockFetch.mock.calls[0][1]).toEqual(
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: "Bearer glpat-test123" }),
        }),
      );
      expect(branches).toEqual([
        { name: "release/main", default: true, protected: true },
        { name: "release/1.0", default: false, protected: true },
        { name: "release/wip", default: false, protected: false },
      ]);
    });

    it("lists all branches (capped at 100) without a query", async () => {
      mockJsonResponse([{ name: "main", default: true }]);

      await platform.listBranches(ri);

      const url = String(mockFetch.mock.calls[0][0]);
      expect(url).toContain("/repository/branches?per_page=100");
      expect(url).not.toContain("search=");
    });
  });
});

it.each(["getPullRequest", "createLabel"] as const)(
  "never forwards PRIVATE-TOKEN through a redirect from %s",
  async (operation) => {
    const { createServer } = await import("node:http");
    const requests: string[] = [];
    const server = createServer((req, res) => {
      requests.push(req.url!);
      res.writeHead(302, { location: `/stolen` });
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as import("node:net").AddressInfo;
    const restore = setOutboundDefaults({
      fetchImpl: undefined,
      resolveHost: async () => [{ address: "127.0.0.1", family: 4 }],
      policy: { allowPrivate: false, allowAll: false, allowedHosts: ["127.0.0.1"] },
    });
    try {
      const platform = new GitLabPlatform("private-token");
      const target = { ...ri, apiBaseUrl: `http://gitlab.test:${port}/api/v4` };
      await expect(
        operation === "getPullRequest"
          ? platform.getPullRequest(target, 1)
          : platform.createLabel(target, { name: "optio", color: "00ff00" }),
      ).rejects.toThrow();
      expect(requests).toHaveLength(1);
      expect(requests[0]).not.toBe("/stolen");
    } finally {
      restore();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
