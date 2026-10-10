import { logger } from "../logger.js";

/**
 * Task cancellation — actually stops the agent when a task is cancelled.
 *
 * Historically, cancelling a task was a pure DB state flip: the task showed
 * as `cancelled` in the UI while the agent process kept running inside the
 * repo pod, burning tokens and even opening PRs afterwards (#549). Under the
 * run protocol (docs/plans/scale-out.md §1) the agent is a process group in
 * its pod that any API instance can signal, so a cancel received by one
 * instance stops a run another instance is streaming:
 *
 *  1. `killRun` (`signalRun`): TERM to the run's supervisor, found from the
 *     database (the task's pod, its run directory), which stops the agent
 *     and records exit 143. The instance attached to the run sees the agent
 *     exit, finds the task cancelled, and leaves it so.
 *  2. Only when there was no live supervisor to signal (a run that predates
 *     the protocol, or whose pid file is gone): the env-based in-pod kill,
 *     `killOrphanedAgentInPod`, which TERM-then-KILLs every process whose
 *     environment carries `OPTIO_TASK_ID=<taskId>`.
 *
 * Either way the task's worktree is preserved for inspection.
 *
 * Kept in its own module (rather than task-service) and using lazy imports
 * for collaborators so there is no static dependency cycle between
 * task-service, repo-pool-service, and the task worker.
 */
export async function terminateTaskExecution(
  taskId: string,
): Promise<{ signalled: boolean; agentKilled: boolean }> {
  let signalled = false;
  let agentKilled = false;

  try {
    const taskService = await import("./task-service.js");
    const repoPool = await import("./repo-pool-service.js");

    const task = await taskService.getTask(taskId);
    const podId = task?.lastPodId;
    if (podId) {
      if (task?.execState === "started") {
        const { signalRun } = await import("./run-attachment.js");
        signalled = await signalRun(podId, taskId, "TERM");
      }
      if (!signalled) agentKilled = await repoPool.killOrphanedAgentInPod(podId, taskId);
      await repoPool.updateWorktreeState(taskId, "preserved");
    }
  } catch (err) {
    logger.warn({ err, taskId }, "Failed to kill in-pod agent for cancelled task");
  }

  logger.info({ taskId, signalled, agentKilled }, "Terminated execution for cancelled task");
  return { signalled, agentKilled };
}
