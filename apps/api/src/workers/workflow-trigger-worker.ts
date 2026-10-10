import { Queue, Worker } from "bullmq";
import { parseIntEnv } from "@optio/shared";
import { logger } from "../logger.js";
import { getBullMQOptions } from "../services/redis-config.js";
import { advanceScheduleCas, listDueScheduleTriggers } from "../services/trigger-service.js";
import { fireTrigger } from "../services/trigger-dispatch.js";
import { scheduleRepeat } from "../services/repeat-jobs.js";
import { underPollerLease } from "../services/poller-lease.js";

const bullmqOpts = getBullMQOptions();

export const workflowTriggerQueue = new Queue("workflow-trigger-checker", {
  ...bullmqOpts,
});

/**
 * Polls for due schedule triggers and hands each to the trigger dispatcher,
 * which starts whatever the trigger targets (a Job run, a Task, a Local
 * terminal, an agent turn, a re-review). A sweep runs on one instance at a
 * time (a poller lease), and each trigger is advanced **before** it fires,
 * by compare-and-swap on the `next_fire_at` the sweep saw: two sweeps that
 * overlap anyway both see the trigger due, and only the one whose update
 * lands fires it. The schedule is advanced whether or not the dispatch
 * succeeds, so one broken target can't re-fire every tick.
 */
export function startWorkflowTriggerWorker() {
  void scheduleRepeat(
    workflowTriggerQueue,
    "workflow-trigger-checker.check-workflow-triggers",
    parseIntEnv("OPTIO_WORKFLOW_TRIGGER_INTERVAL", 60000),
  ).catch(() => {});

  const worker = new Worker(
    "workflow-trigger-checker",
    async () => {
      await underPollerLease("workflow-trigger-checker", () => checkDueScheduleTriggers());
    },
    { ...bullmqOpts, concurrency: 1 },
  );

  worker.on("failed", (_job, err) => {
    logger.error({ err }, "Workflow trigger checker failed");
  });

  return worker;
}

/** One sweep: fires every due schedule trigger it manages to advance first. Returns how many fired. */
export async function checkDueScheduleTriggers(): Promise<number> {
  const triggers = await listDueScheduleTriggers();
  if (triggers.length === 0) return 0;

  logger.info({ count: triggers.length }, "Processing due schedule triggers");

  let fired = 0;
  for (const trigger of triggers) {
    const config = trigger.config as Record<string, unknown> | null;
    const cronExpression = config?.cronExpression as string | undefined;

    if (!cronExpression) {
      logger.warn(
        { triggerId: trigger.id, targetType: trigger.targetType, targetId: trigger.targetId },
        "Schedule trigger missing cronExpression in config, skipping",
      );
      continue;
    }

    // Advance first: the firing belongs to whoever moved the schedule off
    // the tick the sweep saw. A sweep that lost the race skips the trigger.
    let advanced = false;
    try {
      advanced = await advanceScheduleCas(trigger.id, cronExpression, trigger.nextFireAt);
    } catch (err) {
      logger.error({ err, triggerId: trigger.id }, "Failed to advance schedule trigger");
      continue;
    }
    if (!advanced) {
      logger.debug({ triggerId: trigger.id }, "Schedule trigger already fired by another sweep");
      continue;
    }

    try {
      await fireTrigger(trigger, {
        source: "schedule",
        params: trigger.paramMapping ?? undefined,
      });
      fired++;
    } catch (err) {
      logger.error(
        {
          err,
          triggerId: trigger.id,
          targetType: trigger.targetType,
          targetId: trigger.targetId,
        },
        "Failed to fire schedule trigger",
      );
    }
  }
  return fired;
}
