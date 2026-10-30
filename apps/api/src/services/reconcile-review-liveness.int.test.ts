import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { reconcileRepo, type CICheck, type PullRequest } from "@optio/shared";
import { db } from "../db/client.js";
import { tasks } from "../db/schema.js";
import { insertRepo, insertTask } from "../test-utils/integration/fixtures.js";
import { buildWorldSnapshot } from "./reconcile-snapshot.js";
import { executeAction } from "./reconcile-executor.js";
import { getRedisClient } from "./event-bus.js";
import { reconcileQueue } from "./reconcile-queue.js";

// Only the external git host is mocked. Snapshots, decisions, execution,
// state transitions, retry jobs and the shared grace period use real DB/Redis.
const git = vi.hoisted(() => ({
  getPullRequest: vi.fn(),
  getCIChecks: vi.fn(),
  getReviews: vi.fn(),
  mergePullRequest: vi.fn(),
}));
vi.mock("./git-token-service.js", () => ({
  getGitPlatformForRepo: async () => ({
    platform: { type: "github", ...git },
    ri: {
      platform: "github",
      host: "github.com",
      owner: "it-org",
      repo: "merge",
      apiBaseUrl: "https://api.github.com",
    },
  }),
}));

let pr: PullRequest;
let checks: CICheck[];

beforeEach(() => {
  vi.resetAllMocks();
  pr = {
    number: 42,
    title: "test",
    body: "",
    state: "open",
    merged: false,
    mergeable: true,
    draft: false,
    headSha: "head-a",
    baseBranch: "main",
    url: "https://github.com/it-org/merge/pull/42",
    author: "it",
    assignees: [],
    labels: [],
    createdAt: "",
    updatedAt: "",
  };
  checks = [];
  git.getPullRequest.mockImplementation(async () => ({ ...pr }));
  git.getCIChecks.mockImplementation(async () => checks);
  git.getReviews.mockResolvedValue([]);
  git.mergePullRequest.mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await reconcileQueue.close();
  const { prWatcherQueue } = await import("../workers/pr-watcher-worker.js");
  await prWatcherQueue.close();
  await getRedisClient().quit();
});

async function candidate(autoResume = false) {
  const repo = await insertRepo({ autoMerge: true, autoResume, reviewEnabled: false });
  return insertTask({
    repoUrl: repo.repoUrl,
    state: "pr_opened",
    prUrl: pr.url,
    prChecksStatus: "passing",
  });
}

async function pass(taskId: string) {
  const snapshot = await buildWorldSnapshot({ kind: "repo", id: taskId });
  if (!snapshot) throw new Error("missing task");
  const action = reconcileRepo(snapshot);
  return { snapshot, action };
}

// One reviewer requests changes, another approves later. The merge guard
// reads each reviewer's latest say, so the change request still blocks; the
// review status must agree, or the planner keeps choosing a merge the
// executor keeps skipping, and the task never resumes or asks for attention.
describe("a change request outlives someone else's later approval", () => {
  beforeEach(() => {
    checks = [{ name: "test", status: "completed", conclusion: "success" }];
    git.getReviews.mockResolvedValue([
      { author: "alice", state: "CHANGES_REQUESTED", body: "Handle the empty list" },
      { author: "bob", state: "APPROVED", body: "" },
    ]);
  });

  it("asks for attention instead of retrying the merge", async () => {
    const task = await candidate();
    const { snapshot, action } = await pass(task.id);
    expect(snapshot.pr?.reviewStatus).toBe("changes_requested");
    expect(action).toMatchObject({ kind: "transition", to: "needs_attention" });
    await executeAction(action, snapshot);
    const [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(row.state).toBe("needs_attention");
    expect(row.prReviewStatus).toBe("changes_requested");
    expect(git.mergePullRequest).not.toHaveBeenCalled();
  });

  it("resumes the agent with the request when auto-resume is on", async () => {
    const task = await candidate(true);
    const { snapshot, action } = await pass(task.id);
    expect(action).toMatchObject({ kind: "resumeAgent", resumeReason: "review" });
    expect(snapshot.pr?.latestReviewComments).toBe("Handle the empty list");
    expect(git.mergePullRequest).not.toHaveBeenCalled();
  });

  it("merges once the requester approves too", async () => {
    git.getReviews.mockResolvedValue([
      { author: "alice", state: "CHANGES_REQUESTED", body: "Handle the empty list" },
      { author: "bob", state: "APPROVED", body: "" },
      { author: "alice", state: "APPROVED", body: "" },
    ]);
    const task = await candidate();
    const { snapshot, action } = await pass(task.id);
    expect(action.kind).toBe("autoMergePr");
    expect((await executeAction(action, snapshot)).reason).toBe("auto_merged");
  });
});
