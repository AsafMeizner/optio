CREATE TABLE trigger_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL,
  delivery_key text NOT NULL,
  payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  received_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  error text,
  UNIQUE (source, delivery_key)
);
CREATE INDEX trigger_events_pending_idx ON trigger_events (next_attempt_at) WHERE state = 'pending';
--> statement-breakpoint
CREATE TABLE trigger_occurrences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurrence_key text NOT NULL UNIQUE,
  trigger_id uuid NOT NULL,
  target_type text NOT NULL,
  target_id uuid NOT NULL,
  target_name text NOT NULL DEFAULT 'Work',
  workspace_id uuid,
  owner_user_id uuid,
  source text NOT NULL,
  firing jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  received_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  result jsonb,
  error text
);
CREATE INDEX trigger_occurrences_pending_idx ON trigger_occurrences (next_attempt_at) WHERE state = 'pending';
CREATE INDEX trigger_occurrences_target_idx ON trigger_occurrences (workspace_id, target_id, received_at DESC);
