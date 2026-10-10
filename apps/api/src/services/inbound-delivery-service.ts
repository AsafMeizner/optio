/**
 * Inbound webhook dedupe (docs/plans/scale-out.md §3): every provider
 * retries and replays, and a delivery must fire an automation once however
 * many API instances receive copies. The claim is one row in
 * `inbound_webhook_deliveries` keyed by (source, the provider's delivery
 * id): the insert that returns a row is the first copy; a conflict is a
 * replay. Rows older than a day are swept (workers/sweep-worker.ts).
 *
 * Fails open: when the database is away, the delivery is accepted — the
 * provider's signature still gates it, and losing deliveries is worse than
 * a rare double fire.
 */
import { inboundWebhookDeliveries } from "../db/schema.js";
import { db } from "../db/client.js";
import { logger } from "../logger.js";

export type DeliverySource =
  | "github"
  | "slack"
  | "linear"
  | "pagerduty"
  | "gitlab"
  | "jira"
  | "sentry";

const MAX_DELIVERY_ID = 512;

/** True when this caller is the first to see the delivery. */
export async function claimInboundDelivery(source: DeliverySource, id: string): Promise<boolean> {
  const deliveryId = id.length > MAX_DELIVERY_ID ? id.slice(0, MAX_DELIVERY_ID) : id;
  try {
    const rows = await db
      .insert(inboundWebhookDeliveries)
      .values({ source, deliveryId })
      .onConflictDoNothing()
      .returning({ source: inboundWebhookDeliveries.source });
    return rows.length > 0;
  } catch (err) {
    logger.warn({ err, source }, "Webhook delivery dedupe failed in the database; accepting");
    return true;
  }
}
