import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import { GitHubApiError } from "../services/git-platform/github.js";

const mockLaunchPrReview = vi.fn();
const mockGetPrReview = vi.fn();
const mockListPrReviewRuns = vi.fn();
const mockGetLatestRun = vi.fn();
const mockUpdatePrReviewDraft = vi.fn();
const mockSubmitReview = vi.fn();
const mockReReview = vi.fn();
const mockSetControlIntent = vi.fn();
const mockListReviewChat = vi.fn();
const mockPostReviewChat = vi.fn();
const mockMergePr = vi.fn();
const mockGetPrStatus = vi.fn();
vi.mock("../services/pr-review-service.js", () => ({
  launchPrReview: (...args: unknown[]) => mockLaunchPrReview(...args),
  getPrReview: (...args: unknown[]) => mockGetPrReview(...args),
  listPrReviewRuns: (...args: unknown[]) => mockListPrReviewRuns(...args),
  getLatestRun: (...args: unknown[]) => mockGetLatestRun(...args),
  updatePrReviewDraft: (...args: unknown[]) => mockUpdatePrReviewDraft(...args),
  submitReview: (...args: unknown[]) => mockSubmitReview(...args),
  reReview: (...args: unknown[]) => mockReReview(...args),
  setControlIntent: (...args: unknown[]) => mockSetControlIntent(...args),
  listReviewChat: (...args: unknown[]) => mockListReviewChat(...args),
  postReviewChat: (...args: unknown[]) => mockPostReviewChat(...args),
  mergePr: (...args: unknown[]) => mockMergePr(...args),
  getPrStatus: (...args: unknown[]) => mockGetPrStatus(...args),
}));
const mockGetRepoByUrl = vi.fn();
vi.mock("../services/repo-service.js", () => ({
  getRepoByUrl: (...args: unknown[]) => mockGetRepoByUrl(...args),
}));
const mockListLogs = vi.fn();
vi.mock("../services/run-log-service.js", () => ({
  listLogs: (...args: unknown[]) => mockListLogs(...args),
}));
vi.mock("../services/optio-action-service.js", () => ({
  logAction: vi.fn(() => Promise.resolve()),
}));
vi.mock("../db/client.js", () => ({ db: {} }));
vi.mock("../logger.js", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { prReviewRoutes } from "./pr-reviews.js";

describe("POST /api/pr-reviews", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildRouteTestApp(prReviewRoutes);
  });

  it("reports a GitHub failure in words, not GitHub's raw JSON", async () => {
    mockLaunchPrReview.mockRejectedValue(
      new GitHubApiError(
        401,
        JSON.stringify({
          message: "Bad credentials",
          documentation_url: "https://docs.github.com/rest",
          status: "401",
        }),
      ),
    );

    const res = await app.inject({
      method: "POST",
      url: "/api/pr-reviews",
      payload: { prUrl: "https://github.com/acme/widgets/pull/7" },
    });

    // Optio's own status stays 400 (a 401 here would read as "not signed in
    // to Optio"); GitHub's status travels in the message.
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: "GitHub API error 401: Bad credentials (see https://docs.github.com/rest)",
    });
  });

  it("passes other failures through unchanged", async () => {
    mockLaunchPrReview.mockRejectedValue(new Error("Could not parse PR URL"));

    const res = await app.inject({
      method: "POST",
      url: "/api/pr-reviews",
      payload: { prUrl: "not a url" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "Could not parse PR URL" });
  });
});

describe("PR review routes stay inside the caller's workspace", () => {
  let app: FastifyInstance;
  const foreign = { id: "rev-1", workspaceId: "ws-other", state: "ready" };

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetPrReview.mockResolvedValue(foreign);
    app = await buildRouteTestApp(prReviewRoutes);
  });

  it.each([
    ["GET", "/api/pr-reviews/rev-1"],
    ["GET", "/api/pr-reviews/rev-1/runs"],
    ["GET", "/api/pr-reviews/rev-1/chat"],
    ["GET", "/api/pr-reviews/rev-1/logs"],
    ["GET", "/api/tasks/rev-1/review-draft"],
    ["POST", "/api/pr-reviews/rev-1/submit"],
    ["POST", "/api/pr-reviews/rev-1/re-review"],
    ["POST", "/api/pr-reviews/rev-1/cancel"],
  ] as const)("%s %s is a 404 for another workspace's review", async (method, url) => {
    const res = await app.inject({ method, url });
    expect(res.statusCode).toBe(404);
    expect(mockSubmitReview).not.toHaveBeenCalled();
    expect(mockReReview).not.toHaveBeenCalled();
    expect(mockSetControlIntent).not.toHaveBeenCalled();
    expect(mockListLogs).not.toHaveBeenCalled();
  });

  it("refuses to edit or chat with another workspace's review", async () => {
    const patch = await app.inject({
      method: "PATCH",
      url: "/api/pr-reviews/rev-1",
      payload: { summary: "lgtm" },
    });
    const chat = await app.inject({
      method: "POST",
      url: "/api/pr-reviews/rev-1/chat",
      payload: { message: "hi" },
    });
    expect(patch.statusCode).toBe(404);
    expect(chat.statusCode).toBe(404);
    expect(mockUpdatePrReviewDraft).not.toHaveBeenCalled();
    expect(mockPostReviewChat).not.toHaveBeenCalled();
  });

  it("reads logs only for the review's own runs", async () => {
    mockGetPrReview.mockResolvedValue({ ...foreign, workspaceId: "ws-1" });
    mockListPrReviewRuns.mockResolvedValue([{ id: "run-mine" }]);
    const res = await app.inject({ method: "GET", url: "/api/pr-reviews/rev-1/logs?runId=run-x" });
    expect(res.statusCode).toBe(404);
    expect(mockListLogs).not.toHaveBeenCalled();
  });

  it("acts on a review in the caller's workspace", async () => {
    mockGetPrReview.mockResolvedValue({ ...foreign, workspaceId: "ws-1" });
    const res = await app.inject({ method: "POST", url: "/api/pr-reviews/rev-1/cancel" });
    expect(res.statusCode).toBe(200);
    expect(mockSetControlIntent).toHaveBeenCalledWith("rev-1", "cancel");
  });

  it("merges or reads status only for PRs of the workspace's repos", async () => {
    mockGetRepoByUrl.mockResolvedValue(null);
    const merge = await app.inject({
      method: "POST",
      url: "/api/pull-requests/merge",
      payload: { prUrl: "https://github.com/victim/private/pull/3", mergeMethod: "squash" },
    });
    const status = await app.inject({
      method: "GET",
      url: "/api/pull-requests/status?prUrl=https://github.com/victim/private/pull/3",
    });
    expect(merge.statusCode).toBe(400);
    expect(status.statusCode).toBe(400);
    expect(mockMergePr).not.toHaveBeenCalled();
    expect(mockGetPrStatus).not.toHaveBeenCalled();
    expect(mockGetRepoByUrl).toHaveBeenCalledWith("https://github.com/victim/private", "ws-1");

    mockGetRepoByUrl.mockResolvedValue({ id: "repo-1" });
    mockMergePr.mockResolvedValue({ merged: true });
    const ok = await app.inject({
      method: "POST",
      url: "/api/pull-requests/merge",
      payload: { prUrl: "https://github.com/acme/widgets/pull/3", mergeMethod: "squash" },
    });
    expect(ok.statusCode).toBe(200);
  });

  it("launches with the caller's workspace as the expected scope", async () => {
    mockLaunchPrReview.mockResolvedValue({ review: { id: "rev-2" } });
    await app.inject({
      method: "POST",
      url: "/api/pr-reviews",
      payload: { prUrl: "https://github.com/acme/widgets/pull/7" },
    });
    expect(mockLaunchPrReview).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-1", expectedWorkspaceId: "ws-1" }),
    );
  });
});
