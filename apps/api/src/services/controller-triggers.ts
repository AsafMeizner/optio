import { isSelfSecretTriggerType } from "@optio/shared";
import type { ControllerPrincipal } from "./controller-auth.js";
import { ControllerError } from "./controller-access.js";
import { triggerTarget } from "./controller-service.js";
import * as triggers from "./trigger-service.js";

function checkConfig(type: string, config: Record<string, unknown> | undefined) {
  if (config && Object.hasOwn(config, "secret"))
    throw new ControllerError(
      400,
      "Configure trigger secrets in the UI; MCP does not accept credentials",
    );
  const problem = triggers.validateTriggerConfig(type, config);
  if (problem) throw new ControllerError(400, problem);
}
async function write<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (err instanceof Error && err.message === "duplicate_webhook_path")
      throw new ControllerError(409, "Webhook path is already in use");
    if (err instanceof Error && err.message === "unsupported_type")
      throw new ControllerError(400, "This trigger type is not supported by this work");
    throw err;
  }
}
export async function createControllerTrigger(
  p: ControllerPrincipal,
  id: string,
  input: {
    type: string;
    config: Record<string, unknown>;
    paramMapping?: Record<string, unknown>;
    enabled?: boolean;
  },
) {
  const target = await triggerTarget(p, id, true);
  // These receivers need a one-time secret handed to a person on creation.
  if (isSelfSecretTriggerType(input.type))
    throw new ControllerError(
      400,
      "Create this trigger in the UI to receive its one-time secret. MCP can subsequently edit its filters and enabled state.",
    );
  checkConfig(input.type, input.config);
  return {
    trigger: triggers.publicTrigger(
      await write(() => triggers.createTrigger({ ...target, ...input })),
    ),
  };
}
export async function updateControllerTrigger(
  p: ControllerPrincipal,
  id: string,
  triggerId: string,
  input: triggers.UpdateTriggerInput,
) {
  const target = await triggerTarget(p, id, true);
  const existing = await triggers.getTriggerFor(target.targetType, id, triggerId);
  if (!existing) throw new ControllerError(404, "Trigger not found");
  if (input.config !== undefined) checkConfig(existing.type, input.config ?? {});
  const row = await write(() => triggers.updateTrigger(triggerId, input));
  return { trigger: row && triggers.publicTrigger(row) };
}
export async function deleteControllerTrigger(
  p: ControllerPrincipal,
  id: string,
  triggerId: string,
) {
  const target = await triggerTarget(p, id, true);
  if (!(await triggers.getTriggerFor(target.targetType, id, triggerId)))
    throw new ControllerError(404, "Trigger not found");
  await triggers.deleteTrigger(triggerId);
  return { deleted: true, triggerId };
}
