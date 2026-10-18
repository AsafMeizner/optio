import type { ControllerPrincipal } from "./controller-auth.js";
import { ControllerError, requireChange } from "./controller-access.js";
import { getControllerWork } from "./controller-service.js";
import { controlTask, TaskControlError, type TaskControl } from "./task-control-service.js";
import { deleteWork } from "./work-write-service.js";
import { cancelWorkflowRun, retryWorkflowRun } from "./workflow-service.js";
import { setControlIntent } from "./persistent-agent-service.js";
import { enqueueReconcile } from "./reconcile-queue.js";

export async function controlControllerRun(
  p: ControllerPrincipal,
  id: string,
  action: TaskControl,
  prompt?: string,
) {
  const work = await getControllerWork(p, id);
  requireChange(p, work.data);
  if (work.kind !== "run") throw new ControllerError(400, "Use a run id from list_runs");
  if (p.run?.id === id) throw new ControllerError(409, "Cannot control your own run");
  if (work.data.kind === "standalone") {
    if (action !== "cancel" && action !== "retry")
      throw new ControllerError(400, "Job runs support cancel or retry");
    try {
      const run = await (action === "cancel" ? cancelWorkflowRun(id) : retryWorkflowRun(id));
      return { id, state: run.state, action };
    } catch (err) {
      if (err instanceof Error && /^Cannot (retry|cancel) workflow run/.test(err.message))
        throw new ControllerError(409, err.message);
      throw err;
    }
  }
  try {
    const run = await controlTask(id, action, { prompt, userId: p.actor.userId ?? undefined });
    return { id, state: run?.state, action };
  } catch (err) {
    if (
      err instanceof TaskControlError ||
      (err instanceof Error && err.name === "InvalidTransitionError")
    )
      throw new ControllerError(409, err.message);
    throw err;
  }
}
export async function deleteControllerWork(p: ControllerPrincipal, id: string) {
  const work = await getControllerWork(p, id);
  requireChange(p, work.data);
  if (work.kind !== "definition")
    throw new ControllerError(
      400,
      "Delete a recurring definition; cancel runs or archive agents instead",
    );
  return { id, deleted: await deleteWork(id, p.actor) };
}
export async function controlControllerAgent(
  p: ControllerPrincipal,
  id: string,
  action: "pause" | "resume" | "archive" | "restart",
) {
  const work = await getControllerWork(p, id);
  requireChange(p, work.data);
  if (work.kind !== "agent") throw new ControllerError(400, "Use a persistent agent id");
  if (p.run?.agentId === id) throw new ControllerError(409, "Cannot control your own agent");
  await setControlIntent(id, action, p.actor.workspaceId);
  await enqueueReconcile({ kind: "persistent-agent", id }, { reason: `control_intent_${action}` });
  return { id, action, accepted: true };
}
