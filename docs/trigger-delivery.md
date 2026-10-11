# Durable trigger delivery

**Work → Trigger history** (`/work/deliveries`) shows pending, started, failed and
skipped deliveries. A successful delivery means its work was created; execution
may still be queued or running. Private delivery history follows work ownership.
Only an actor allowed to run the work can retry a failed dispatch.

Signed workspace receivers verify and normalize events, then persist them in
`trigger_events` **before** returning success. If persistence fails, the receiver
returns an error so the sender can retry. Provider delivery IDs deduplicate
receipts; sources without an ID use a digest of their normalized payload. Slack
retry headers do not suppress a delivery that was never persisted.

A background worker matches events and creates one `trigger_occurrences` row per
matching trigger. Matching errors retry with backoff. Schedule advancement and
creation of its occurrence commit in the same transaction; a failed insert rolls
both back. The scheduler keeps its existing missed-tick behavior: after downtime
it creates the due occurrence and advances to the next future tick, rather than
replaying every missed cron interval.

Each occurrence's UUID is also the created run, Local terminal or persistent
agent message ID. If dispatch crashes after creating the target, the next attempt
recovers that same target. Postgres row locks coordinate replicas. Dispatch is
serialized within each API process to bound database connections while a receipt
transaction holds a lock and the target writes on another connection. BullMQ
wakes the poller; Postgres owns the pending work.

Dispatch failures retry up to eight times with exponential backoff, capped at
five minutes. Failed occurrences remain available for an explicit retry, using
the original identity. Deleted or disabled triggers/targets are skipped. Ownership changes also skip pending dispatch, so it cannot silently run with a different owner’s credentials. History retains the original name; manual retry checks current ownership too. Ticket
trigger occurrences deduplicate by trigger plus ticket source and external ID.
The trigger's `last_fired_at` now records actual dispatch, not schedule advancement.

Generic and per-trigger self-secret webhook endpoints still return the existing
run/task/terminal response on immediate success. If dispatch fails after durable
acceptance, they return `202 { queued: true, deliveryId }`. To make sender retries
idempotent, supply an `Idempotency-Key` header (scoped to that trigger); without
one, each authenticated request is a new firing. This header does not replace
signature or shared-secret authentication.

Completed payloads are cleared after one day. Completed receipt identities and
history are retained for 90 days, so deduplication is bounded by that retention.
Pending and failed deliveries retain their payload for recovery. The history API
never returns payloads or trigger secrets. GitHub's auxiliary ticket/PR event
handling retains its existing receipt path; this durable queue covers trigger
fan-out.
