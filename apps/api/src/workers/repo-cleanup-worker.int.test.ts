import { afterAll, describe, expect, it, vi } from "vitest";
import { inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { taskEvents } from "../db/schema.js";
import { insertTask } from "../test-utils/integration/fixtures.js";
import { getTask } from "../services/task-service.js";

// Exercise the sweep's real Postgres queries and task transitions, without
// touching pods. Local task activity lives on the terminal, so old task-row
// timestamps must never trigger the pod worker's stall/recovery policy.
vi.mock("../services/container-service.js", () => ({ getRuntime: () => ({}) }));
vi.mock("../services/reconcile-queue.js", () => ({ enqueueReconcile: vi.fn() }));
vi.mock("../services/repo-pool-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/repo-pool-service.js")>()),
  listRepoPods: async () => [],
  reconcileActiveTaskCounts: async () => 0,
  cleanupIdleRepoPods: async () => 0,
}));
vi.mock("../services/workflow-pool-service.js", () => ({
  reconcileActiveRunCounts: async () => 0,
  cleanupIdleWorkflowPods: async () => 0,
}));
vi.mock("../services/persistent-agent-pool-service.js", () => ({
  cleanupIdlePersistentAgentPods: async () => 0,
}));
vi.mock("../services/run-home-sweep-service.js", () => ({
  sweepFinishedRunHomes: async () => 0,
}));
vi.mock("../services/zombie-cleanup-service.js", () => ({
  cleanupZombieWorkflowRuns: async () => 0,
  cleanupOrphanedRepoTasks: async () => 0,
}));
vi.mock("../services/session-service.js", () => ({ cleanupExpiredSessions: async () => 0 }));

import { repoCleanupQueue, sweepPods } from "./repo-cleanup-worker.js";

afterAll(async () => {
  await repoCleanupQueue.close();
});

describe("pod cleanup leaves Local task liveness to its daemon", () => {
  it("ignores old Local rows while still detecting stale and stalled pod tasks", async () => {
    const old = new Date(Date.now() - 20 * 60_000);
    const local = await Promise.all(
      (["running", "provisioning"] as const).map((state) =>
        insertTask({
          state,
          runTarget: "local",
          updatedAt: old,
          lastActivityAt: old,
          activitySubstate: "active",
        }),
      ),
    );
    const podRunning = await insertTask({ state: "running", updatedAt: old });
    const podProvisioning = await insertTask({ state: "provisioning", updatedAt: old });
    const podSilent = await insertTask({
      state: "running",
      lastActivityAt: old,
      updatedAt: new Date(),
    });

    await sweepPods();

    for (const task of local) {
      expect(await getTask(task.id)).toMatchObject({
        state: task.state,
        activitySubstate: "active",
        errorMessage: null,
        worktreeState: null,
        updatedAt: old,
      });
    }
    expect(
      await db
        .select()
        .from(taskEvents)
        .where(
          inArray(
            taskEvents.taskId,
            local.map((t) => t.id),
          ),
        ),
    ).toEqual([]);
    expect(await getTask(podRunning.id)).toMatchObject({
      state: "needs_attention",
      worktreeState: "preserved",
    });
    expect(await getTask(podProvisioning.id)).toMatchObject({
      state: "failed",
      worktreeState: "preserved",
    });
    expect(await getTask(podSilent.id)).toMatchObject({
      state: "running",
      activitySubstate: "stalled",
    });
  });
});
