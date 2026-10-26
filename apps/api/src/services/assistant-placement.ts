/**
 * Where an Ask Optio turn runs.
 *
 * By default in a pooled agent pod per conversation (`agent-pod`).
 * `OPTIO_ASSISTANT_PLACEMENT=api-pod` opts in to running the turn in the API
 * pod itself, as a child process of this server (the process runtime), which
 * saves the pod an agent pod would cost.
 *
 * SECURITY: `api-pod` is opt-in only. The harness runs with its permission
 * checks skipped, as the API's own uid, in the API's container: whoever can
 * steer it — anyone who can use Ask Optio, or text it reads through the
 * controller MCP — can read the API process's environment
 * (`/proc/<pid>/environ`: `OPTIO_ENCRYPTION_KEY`, `DATABASE_URL`, `REDIS_URL`,
 * OAuth client secrets), the API's service-account token, and the other
 * in-pod turns' credentials. Scrubbing the child's own env does not help
 * against a same-uid process. Use it only where every Ask Optio user is
 * trusted with the deployment's secrets.
 *
 * A turn falls back to an agent pod when the API pod can't take it: the
 * harness isn't installed in the API image (every image has Claude Code and
 * Codex; a Copilot / Gemini / OpenCode / Cursor assistant runs in a pod),
 * the session has a repo (checkouts live in pods), or as many turns as the
 * pod allows are already running (`OPTIO_ASSISTANT_IN_POD_MAX`, default 3).
 */
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

export type AssistantPlacement = "api-pod" | "agent-pod";

/** The binary each harness is launched through (`buildPooledAgentCommand`). */
export const HARNESS_BINARIES: Record<string, string> = {
  "claude-code": "claude",
  codex: "codex",
  copilot: "copilot",
  gemini: "gemini",
  opencode: "opencode",
  cursor: "cursor-agent",
};

/**
 * Unset (or anything else), the placement is `agent-pod`: running a turn in
 * the API pod hands the API's secrets to the harness (see above), so it
 * happens only when a deployment asks for it explicitly.
 */
export function assistantPlacement(env: NodeJS.ProcessEnv = process.env): AssistantPlacement {
  return env.OPTIO_ASSISTANT_PLACEMENT?.trim() === "api-pod" ? "api-pod" : "agent-pod";
}

/** How many assistant turns the API pod runs at once before the rest go to agent pods. */
export function inPodTurnLimit(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseInt(env.OPTIO_ASSISTANT_IN_POD_MAX ?? "", 10);
  return Number.isInteger(n) && n > 0 ? n : 3;
}

const installed = new Map<string, boolean>();

/** Whether the harness's binary is on this process's PATH (cached per binary). */
export function harnessInstalled(runtime: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const bin = HARNESS_BINARIES[runtime];
  if (!bin) return false;
  const key = `${bin}:${env.PATH ?? ""}`;
  const cached = installed.get(key);
  if (cached !== undefined) return cached;
  const found = (env.PATH ?? "").split(delimiter).some((dir) => {
    if (!dir) return false;
    try {
      accessSync(join(dir, bin), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
  installed.set(key, found);
  return found;
}

/** Forget what was found on PATH (tests). */
export function resetHarnessLookup(): void {
  installed.clear();
}

export type TurnPlacement =
  | { where: "api-pod" }
  | { where: "agent-pod"; reason: "configured" | "repo" | "harness-missing" | "pod-full" };

/** Where this turn runs, given what the session is and what the pod is doing. */
export function placeAssistantTurn(
  input: { runtime: string; assistant: boolean; repoUrl: string | null; liveInPod: number },
  env: NodeJS.ProcessEnv = process.env,
): TurnPlacement {
  if (!input.assistant || assistantPlacement(env) !== "api-pod")
    return { where: "agent-pod", reason: "configured" };
  if (input.repoUrl) return { where: "agent-pod", reason: "repo" };
  if (!harnessInstalled(input.runtime, env))
    return { where: "agent-pod", reason: "harness-missing" };
  if (input.liveInPod >= inPodTurnLimit(env)) return { where: "agent-pod", reason: "pod-full" };
  return { where: "api-pod" };
}
