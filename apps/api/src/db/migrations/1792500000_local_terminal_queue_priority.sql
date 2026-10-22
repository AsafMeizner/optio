-- Order among the agent terminals waiting for a slot on a machine
-- (pending/capacity): lower starts first, ties by creation. "Move to front"
-- sets it below every other waiter's.
ALTER TABLE "local_terminals" ADD COLUMN IF NOT EXISTS "queue_priority" integer NOT NULL DEFAULT 100;
