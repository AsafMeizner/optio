-- What a Local host's connected daemon can do (its hello's capability
-- flags), so any API instance can answer capability questions about a
-- daemon connected to another one (docs/plans/scale-out.md §4). Read only
-- while the host's `local-host:<id>` lease is live; null until a daemon
-- connects under this version.
ALTER TABLE "local_hosts" ADD COLUMN IF NOT EXISTS "capabilities" jsonb;
