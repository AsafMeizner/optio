import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { reconcileRepo, type PullRequest } from "@optio/shared";
import { db } from "../db/client.js";
import { tasks } from "../db/schema.js";
import { insertRepo, insertTask } from "../test-utils/integration/fixtures.js";
import { buildWorldSnapshot } from "./reconcile-snapshot.js";
import { executeAction } from "./reconcile-executor.js";
import { getRedisClient } from "./event-bus.js";
import { reconcileQueue } from "./reconcile-queue.js";

// Only the GitLab API is mocked; snapshots, decisions, execution, the task
// row and the Redis wait count are real.
const git = vi.hoisted(() => ({
  getPullRequest: vi.fn(),
  getCIChecks: vi.fn(),
  getReviews: vi.fn(),
  mergePullRequest: vi.fn(),
}));
vi.mock("./git-token-service.js", () => ({
  getGitPlatformForRepo: async () => ({
    platform: { type: "gitlab", ...git },
    ri: {
      platform: "gitlab",
      host: "gitlab.com",
      owner: "it-org",
      repo: "merge-wait",
      apiBaseUrl: "https://gitlab.com/api/v4",
    },
  }),
}));

const url = "https://gitlab.com/it-org/merge-wait/-/merge_requests/42";
let pr: PullRequest & { mergeStatus?: string };

beforeEach(() => {
  vi.resetAllMocks();
  pr = {
    number: 42,
    title: "test",
    body: "",
    state: "open",
    merged: false,
    mergeable: null,
    mergeStatus: "checking",
    draft: false,
    headSha: `head-${Math.random().toString(36).slice(2)}`,
    baseBranch: "main",
    url,
    author: "it",
    assignees: [],
    labels: [],
    createdAt: "",
    updatedAt: "",
  };
  git.getPullRequest.mockImplementation(async () => ({ ...pr }));
  git.getCIChecks.mockResolvedValue([{ name: "test", status: "completed", conclusion: "success" }]);
  git.getReviews.mockResolvedValue([]);
});
afterAll(async () => {
  await reconcileQueue.close();
  const { prWatcherQueue } = await import("../workers/pr-watcher-worker.js");
  await prWatcherQueue.close();
  await getRedisClient().quit();
});

async function pass(taskId: string) {
  const snapshot = await buildWorldSnapshot({ kind: "repo", id: taskId });
  if (!snapshot) throw new Error("missing task");
  const action = reconcileRepo(snapshot);
  return { action, outcome: await executeAction(action, snapshot) };
}

/** The deferral's backoff has run out, as it would by the next pass. */
async function backoffElapsed(taskId: string) {
  await db
    .update(tasks)
    .set({ reconcileBackoffUntil: sql`now() - interval '1 second'` })
    .where(eq(tasks.id, taskId));
}

describe("the merge-wait budget", () => {
  it("is not reset by review-read deferrals in between not-ready passes", async () => {
    const repo = await insertRepo({
      repoUrl: "https://gitlab.com/it-org/merge-wait",
      autoMerge: true,
      reviewEnabled: false,
    });
    const task = await insertTask({
      repoUrl: repo.repoUrl,
      state: "pr_opened",
      prUrl: url,
      prChecksStatus: "passing",
    });

    const reasons: string[] = [];
    for (let i = 0; i < 60; i++) {
      // Every other pass the review state can't be read and the pass defers.
      if (i % 2 === 1) git.getReviews.mockRejectedValueOnce(new Error("incomplete"));
      const { outcome } = await pass(task.id);
      reasons.push(outcome.reason);
      await backoffElapsed(task.id);
      const [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
      if (row.state === "needs_attention") break;
    }

    const [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(reasons.filter((r) => r === "backoff_written")).toHaveLength(20);
    expect(reasons.filter((r) => r === "auto_merge_mr_not_ready")).toHaveLength(20);
    expect(reasons.at(-1)).toBe("auto_merge_not_ready_needs_attention");
    expect(row.state).toBe("needs_attention");
    expect(git.mergePullRequest).not.toHaveBeenCalled();
  });
});
