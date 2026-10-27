import { setOutboundDefaults } from "../../utils/outbound-url.js";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GitLabApiError, GitLabPlatform } from "./gitlab.js";
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
            "PRIVATE-TOKEN": "glpat-test123",
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

      const checks = await platform.getCIChecks(ri, "abc123");

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch.mock.calls[0][0]).toContain(`/pipelines?sha=abc123`);
      expect(mockFetch.mock.calls[1][0]).toContain(`/pipelines/100/jobs`);
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
  });
  describe("a review that requests changes", () => {
    const note = (author: string, body: string, created_at: string, extra: object = {}) => ({
      author: { username: author },
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
      mockJsonResponse([]);

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
      mockJsonResponse([]);

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
      mockJsonResponse([]);

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
      mockJsonResponse([]);

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
      mockJsonResponse([]);

      const reviews = await platform.getReviews(ri, 7);

      expect(reviews.map((r) => r.state)).toEqual(["CHANGES_REQUESTED", "APPROVED"]);
      expect(determineReviewStatus(reviews).status).toBe("approved");
    });

    it("a note that only mentions changes is a comment", async () => {
      mockJsonResponse({ approved_by: [] });
      mockJsonResponse([note("bob", "The changes requested last week look fine", "2026-01-01")]);
      mockJsonResponse([]);

      expect((await platform.getReviews(ri, 7)).map((r) => r.state)).toEqual(["COMMENTED"]);
    });

    it("a failed notes read leaves the list incomplete, since a change request may be missing", async () => {
      mockJsonResponse({ approved_by: [] });
      mockJsonResponse({ message: "500 Internal Server Error" }, false, 500);
      mockJsonResponse([]);

      await expect(platform.getReviews(ri, 7)).rejects.toThrow("GitLab review state is incomplete");
    });

    it("reads a busy MR's newest notes: a full page asks for the next", async () => {
      const older = Array.from({ length: 100 }, (_, i) =>
        note("bob", `note ${i}`, `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}Z`),
      );
      mockJsonResponse({ approved_by: [] });
      mockJsonResponse(older);
      mockJsonResponse([note("bob", "oldest", "2025-12-31T00:00:00Z")]);
      mockJsonResponse([]);

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
