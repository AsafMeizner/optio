import type { LocalDaemonMessage, LocalHostAgentLimits } from "@optio/shared";
import * as relay from "./local-relay.js";
import { HostRequests } from "./local-host-requests.js";
import { handleAgentLimits, type LocalHostRow } from "./local-host-service.js";

/**
 * The refresh button on a machine's Codex usage pill: ask its daemon to read
 * Codex's limits now (Codex's app server answers `account/rateLimits/read`;
 * the session log only moves when Codex runs). Mirrors local-dirs-service's
 * request / answer pairing.
 */

const REQUEST_TIMEOUT_MS = 30_000;

type LimitsResult = Extract<LocalDaemonMessage, { type: "limits-refresh-result" }>;

/** Why the limits couldn't be refreshed, with the HTTP status that says so. */
export class LimitsRefreshError extends Error {
  constructor(
    message: string,
    readonly status: 409 | 502 | 504,
  ) {
    super(message);
  }
}

const requests = new HostRequests<LimitsResult>({
  timeoutMs: REQUEST_TIMEOUT_MS,
  timeoutError: () => new LimitsRefreshError("The machine did not answer in time", 504),
  offlineError: () => new LimitsRefreshError("The machine is offline", 409),
});

/** A daemon answered. Ignored unless the request is pending for that same host. */
export function deliverLimitsResult(hostId: string, msg: LimitsResult): boolean {
  return requests.deliver(hostId, msg);
}

export async function refreshHostLimits(host: LocalHostRow): Promise<LocalHostAgentLimits> {
  const caps = await relay.hostCapabilities(host.id);
  if (!caps) {
    throw new LimitsRefreshError(`${host.name} is offline — start \`optio local up\` on it`, 409);
  }
  if (!caps.refreshLimits) {
    throw new LimitsRefreshError(
      `Optio Local on ${host.name} can't refresh limits yet — update it and restart \`optio local up\``,
      409,
    );
  }
  const result = await requests.ask(
    host.id,
    (requestId) => ({ type: "limits-refresh", requestId }),
    () => new LimitsRefreshError(`${host.name} is offline`, 409),
  );
  if (result.error) throw new LimitsRefreshError(result.error, 502);
  const limits = result.limits ?? {};
  // The daemon also sends an agent-limits frame; store these too so the
  // response and the host row agree even if that frame is still in flight.
  await handleAgentLimits(host.id, limits);
  return limits;
}
