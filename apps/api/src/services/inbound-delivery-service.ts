/**
 * Inbound webhook dedupe (docs/plans/scale-out.md §3): every provider
 * retries and replays, and a delivery must fire an automation once however
 * many API instances receive copies. The claim is one row in
 * `inbound_webhook_deliveries` keyed by (source, the provider's delivery
 * id): the insert that returns a row is the first copy; a conflict is a
 * replay. Rows older than a day are swept (workers/sweep-worker.ts).
 *
 * Fails open: when the database is away or slow (the insert gets one
 * second — `statement_timeout` — so a webhook ack is never held hostage),
 * the delivery is accepted — the provider's signature still gates it, and
 * losing deliveries is worse than a rare double fire.
 */
import { sql } from "drizzle-orm";
import { inboundWebhookDeliveries } from "../db/schema.js";
import { db } from "../db/client.js";
import { logger } from "../logger.js";
import { isStatementTimeout } from "../utils/db-errors.js";

export type DeliverySource =
  | "github"
  | "slack"
  | "linear"
  | "pagerduty"
  | "gitlab"
  | "jira"
  | "sentry";

const MAX_DELIVERY_ID = 512;
/** How long the claim's insert may take before the delivery is accepted unclaimed. */
const CLAIM_TIMEOUT = "1s";

/** True when this caller is the first to see the delivery. */
export async function claimInboundDelivery(source: DeliverySource, id: string): Promise<boolean> {
  const deliveryId = id.length > MAX_DELIVERY_ID ? id.slice(0, MAX_DELIVERY_ID) : id;
  try {
    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${CLAIM_TIMEOUT}'`));
      return tx
        .insert(inboundWebhookDeliveries)
        .values({ source, deliveryId })
        .onConflictDoNothing()
        .returning({ source: inboundWebhookDeliveries.source });
    });
    return rows.length > 0;
  } catch (err) {
    if (isStatementTimeout(err)) {
      logger.warn({ source }, "Webhook delivery dedupe timed out in the database; accepting");
    } else {
      logger.warn({ err, source }, "Webhook delivery dedupe failed in the database; accepting");
    }
    return true;
  }
}
