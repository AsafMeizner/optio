/**
 * Mid-run user messages to a running task's agent. Claude Code runs with
 * `--input-format stream-json`, reading user messages from its stdin; under
 * the run protocol (run-attachment.ts) that stdin is a file in the run's
 * pod which any API instance can append to, so delivery no longer needs the
 * instance that is streaming the run.
 */
import type { tasks } from "../db/schema.js";
import * as podPool from "./agent-pod-pool.js";
import { getRuntime } from "./container-service.js";
import { publishEvent } from "./event-bus.js";
import * as messageService from "./task-message-service.js";
import { runHome } from "../utils/harness-config.js";
import { logger } from "../logger.js";

export interface TaskMessageDelivery {
  messageId: string;
  content: string;
  mode: "soft" | "interrupt";
}

/** The stream-json line a user message becomes on the agent's stdin. */
export function streamJsonUserLine(content: string, mode: "soft" | "interrupt"): string {
  const text =
    mode === "interrupt"
      ? `[URGENT INTERRUPT FROM USER — stop what you are doing and address this immediately] ${content}`
      : content;
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
  });
}

/**
 * Appends the message to the running task's stdin and marks it delivered.
 * A task whose agent is not running under the protocol (never started, or
 * a run on a machine) gets a delivery error the UI shows.
 */
export async function deliverTaskMessage(
  task: Pick<typeof tasks.$inferSelect, "id" | "execState" | "lastPodId" | "runTarget">,
  message: TaskMessageDelivery,
): Promise<boolean> {
  const log = logger.child({ taskId: task.id, messageId: message.messageId });
  try {
    if (task.runTarget === "local" || task.execState !== "started" || !task.lastPodId) {
      throw new Error("the agent is not running in a pod under the run protocol");
    }
    const pod = await podPool.getPod(task.lastPodId);
    if (!pod?.podName) throw new Error("the run's pod is gone");
    await getRuntime().deliverStdin(podPool.podHandle(pod), {
      runId: task.id,
      runDir: runHome(task.id).podDir,
      line: streamJsonUserLine(message.content, message.mode),
    });
    await messageService.markDelivered(message.messageId);
    await publishEvent({
      type: "task:message_delivered",
      taskId: task.id,
      messageId: message.messageId,
      timestamp: new Date().toISOString(),
    });
    return true;
  } catch (err) {
    log.warn({ err }, "Failed to deliver task message");
    await messageService
      .markDeliveryError(message.messageId, err instanceof Error ? err.message : "delivery failed")
      .catch(() => {});
    return false;
  }
}
