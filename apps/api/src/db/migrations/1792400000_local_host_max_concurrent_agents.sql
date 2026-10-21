-- How many agent terminals a paired machine runs at once; automation spawns
-- past it wait in pending/capacity.
ALTER TABLE "local_hosts" ADD COLUMN IF NOT EXISTS "max_concurrent_agents" integer NOT NULL DEFAULT 3;
