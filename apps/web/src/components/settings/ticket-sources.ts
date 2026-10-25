import { featureAllows, type DeploymentFeatures } from "@optio/shared";

export interface TicketSourceOption {
  value: string;
  label: string;
}

/**
 * Sources Settings → Tickets can add that upstream's list leaves out:
 * GitLab issues (packages/ticket-providers gitlab.ts — a host, a project
 * path and a token per provider).
 */
const EXTRA_TICKET_SOURCES: TicketSourceOption[] = [{ value: "gitlab", label: "GitLab Issues" }];

/**
 * The ticket sources Settings → Tickets offers: those of
 * `upstream` plus the extras, the ones the feature lists allow.
 */
export function ticketSourceOptions(
  upstream: readonly TicketSourceOption[],
  features: DeploymentFeatures,
): TicketSourceOption[] {
  return [...upstream, ...EXTRA_TICKET_SOURCES].filter((s) =>
    featureAllows("ticketSources", s.value, features),
  );
}
