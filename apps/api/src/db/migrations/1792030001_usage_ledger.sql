-- Atomic usage deltas: every writer, including Local, retries and re-attachments,
-- records spend in the same transaction as its existing cumulative counters.
ALTER TABLE tasks ADD COLUMN cache_read_tokens bigint, ADD COLUMN cache_write_tokens bigint, ADD COLUMN cost_basis text;
ALTER TABLE pr_review_runs ADD COLUMN cache_read_tokens bigint, ADD COLUMN cache_write_tokens bigint, ADD COLUMN cost_basis text;
ALTER TABLE persistent_agent_turns ADD COLUMN cache_read_tokens bigint, ADD COLUMN cache_write_tokens bigint, ADD COLUMN cost_basis text, ADD COLUMN model_used text;
ALTER TABLE session_chat_turns ADD COLUMN usage jsonb;
--> statement-breakpoint
CREATE TABLE usage_ledger (
  id bigserial PRIMARY KEY,
  source_kind text NOT NULL,
  source_id uuid NOT NULL,
  workspace_id uuid,
  owner_user_id uuid,
  subject_id uuid NOT NULL,
  subject_kind text NOT NULL,
  subject_name text NOT NULL,
  work_id uuid NOT NULL,
  work_name text NOT NULL,
  href text NOT NULL,
  repo_url text,
  runtime text,
  model text,
  input_tokens bigint,
  output_tokens bigint,
  cache_read_tokens bigint,
  cache_write_tokens bigint,
  cost_usd numeric,
  cost_basis text NOT NULL,
  outcome text,
  retry boolean NOT NULL DEFAULT false,
  historical boolean NOT NULL DEFAULT false,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usage_ledger_workspace_time_idx ON usage_ledger (workspace_id, occurred_at DESC);
CREATE INDEX usage_ledger_subject_time_idx ON usage_ledger (workspace_id, subject_id, occurred_at DESC);
CREATE INDEX usage_ledger_source_idx ON usage_ledger (source_kind, source_id);
--> statement-breakpoint
CREATE TABLE usage_budgets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  subject_kind text NOT NULL CHECK (subject_kind IN ('organization', 'person', 'work')),
  subject_id uuid,
  name text NOT NULL,
  token_limit bigint CHECK (token_limit > 0),
  cost_limit numeric CHECK (cost_limit > 0),
  action text NOT NULL DEFAULT 'notify' CHECK (action IN ('notify', 'pause_new')),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (token_limit IS NOT NULL OR cost_limit IS NOT NULL),
  CHECK ((subject_kind = 'organization') = (subject_id IS NULL))
);
CREATE UNIQUE INDEX usage_budgets_scope_idx ON usage_budgets (workspace_id, subject_kind, COALESCE(subject_id, '00000000-0000-0000-0000-000000000000'::uuid));
--> statement-breakpoint
CREATE FUNCTION optio_capture_usage_row(kind text, n jsonb, o jsonb, historical boolean DEFAULT false) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  scope jsonb := n; definition jsonb; parent jsonb; u jsonb := n; previous jsonb := o;
  wid uuid; owner_id uuid; work_id uuid; work_name text; href text; runtime text; model text; basis text;
  ins bigint; outs bigint; reads bigint; writes bigint; cost numeric;
  prev_ins bigint; prev_outs bigint; prev_reads bigint; prev_writes bigint; prev_cost numeric;
  outcome text; prior_outcome text; at_time timestamptz := now();
BEGIN
  -- Most writes are liveness/log bookkeeping. Avoid all attribution joins when
  -- neither measured usage nor a terminal outcome changed.
  IF NOT historical AND o <> '{}'::jsonb AND
    (n->'usage',n->'input_tokens',n->'output_tokens',n->'cache_read_tokens',n->'cache_write_tokens',n->'cost_usd',n->'state',n->'halt_reason',n->'exit_code') IS NOT DISTINCT FROM
    (o->'usage',o->'input_tokens',o->'output_tokens',o->'cache_read_tokens',o->'cache_write_tokens',o->'cost_usd',o->'state',o->'halt_reason',o->'exit_code') THEN RETURN; END IF;
  IF kind = 'tasks' THEN
    IF n->>'parent_task_id' IS NOT NULL THEN SELECT to_jsonb(t) INTO parent FROM tasks t WHERE id = (n->>'parent_task_id')::uuid; END IF;
    work_id := COALESCE((parent->>'work_id')::uuid, (parent->>'id')::uuid, (n->>'work_id')::uuid, (n->>'id')::uuid);
    SELECT to_jsonb(d) INTO definition FROM work_definitions d WHERE id = work_id;
    work_name := COALESCE(definition->>'name', parent->>'title', n->>'title', 'Work');
    href := CASE WHEN n->>'kind' = 'standalone' THEN '/jobs/' || (n->>'work_id') || '/runs/' || (n->>'id') ELSE '/tasks/' || (n->>'id') END;
    runtime := n->>'agent_type';
  ELSIF kind = 'persistent_agent_turns' THEN
    SELECT to_jsonb(a) INTO scope FROM persistent_agents a WHERE id = (n->>'agent_id')::uuid;
    work_id := (n->>'agent_id')::uuid; work_name := scope->>'name'; href := '/agents/' || work_id;
    runtime := scope->>'agent_runtime'; model := COALESCE(n->>'model_used', scope->>'model');
  ELSIF kind = 'pr_review_runs' THEN
    SELECT to_jsonb(p) INTO scope FROM pr_reviews p WHERE id = (n->>'pr_review_id')::uuid;
    work_id := (n->>'pr_review_id')::uuid; work_name := 'Review ' || (scope->>'repo_owner') || '/' || (scope->>'repo_name') || '#' || (scope->>'pr_number'); href := '/reviews/' || work_id;
    runtime := 'claude-code';
  ELSIF kind = 'local_terminals' THEN
    -- Linked terminals are accounted for through their run, never twice.
    IF n->>'task_id' IS NOT NULL OR n->>'workflow_run_id' IS NOT NULL THEN RETURN; END IF;
    u := n->'usage'; previous := o->'usage';
    owner_id := (n->>'user_id')::uuid;
    work_id := COALESCE((n->>'blueprint_id')::uuid, (n->>'id')::uuid);
    SELECT to_jsonb(d) INTO definition FROM work_definitions d WHERE id = work_id;
    work_name := COALESCE(definition->>'name', n->>'title', 'Local session'); href := '/local/' || (n->>'id'); runtime := n->'spec'->>'agent';
  ELSIF kind = 'session_chat_turns' THEN
    SELECT to_jsonb(s) INTO scope FROM interactive_sessions s WHERE id = (n->>'session_id')::uuid;
    owner_id := (scope->>'user_id')::uuid;
    work_id := (n->>'session_id')::uuid; work_name := COALESCE(scope->>'title', scope->>'branch', 'Pod session'); href := '/sessions/' || work_id;
    u := n->'usage'; previous := o->'usage'; runtime := 'claude-code';
  ELSIF kind = 'interactive_sessions' THEN
    -- Only historical sessions: new usage is recorded per chat turn.
    owner_id := (n->>'user_id')::uuid; work_id := (n->>'id')::uuid;
    work_name := COALESCE(n->>'title', n->>'branch', 'Pod session'); href := '/sessions/' || work_id; runtime := 'claude-code';
  ELSE RETURN;
  END IF;
  wid := (scope->>'workspace_id')::uuid;
  owner_id := COALESCE(owner_id, (scope->>'owner_user_id')::uuid);
  model := COALESCE(model, u->>'model_used', u->>'model');
  basis := COALESCE(u->>'cost_basis', u->>'costBasis', CASE WHEN kind = 'local_terminals' OR n->>'run_target' = 'local' THEN 'estimated' ELSE 'reported' END);
  ins := COALESCE((u->>'input_tokens')::bigint, (u->>'inputTokens')::bigint);
  outs := COALESCE((u->>'output_tokens')::bigint, (u->>'outputTokens')::bigint);
  reads := COALESCE((u->>'cache_read_tokens')::bigint, (u->>'cacheReadTokens')::bigint);
  writes := COALESCE((u->>'cache_write_tokens')::bigint, (u->>'cacheWriteTokens')::bigint);
  cost := COALESCE(NULLIF(u->>'cost_usd','')::numeric, (u->>'costUsd')::numeric);
  prev_ins := COALESCE((previous->>'input_tokens')::bigint, (previous->>'inputTokens')::bigint, 0);
  prev_outs := COALESCE((previous->>'output_tokens')::bigint, (previous->>'outputTokens')::bigint, 0);
  prev_reads := COALESCE((previous->>'cache_read_tokens')::bigint, (previous->>'cacheReadTokens')::bigint, 0);
  prev_writes := COALESCE((previous->>'cache_write_tokens')::bigint, (previous->>'cacheWriteTokens')::bigint, 0);
  prev_cost := COALESCE(NULLIF(previous->>'cost_usd','')::numeric, (previous->>'costUsd')::numeric, 0);
  -- A snapshot can temporarily lose its price while retaining measured
  -- tokens. When pricing returns, do not charge an already recorded cost twice.
  IF cost IS NOT NULL AND NOT historical AND COALESCE(NULLIF(previous->>'cost_usd',''),previous->>'costUsd') IS NULL THEN
    SELECT GREATEST(prev_cost,COALESCE(SUM(l.cost_usd),0)) INTO prev_cost
      FROM usage_ledger l WHERE l.source_kind=kind AND l.source_id=(n->>'id')::uuid;
  END IF;
  IF kind = 'local_terminals' THEN
    ins := ins + COALESCE(reads,0) + COALESCE(writes,0);
    prev_ins := prev_ins + prev_reads + prev_writes;
  END IF;
  outcome := CASE WHEN n->>'state' = 'completed' OR n->>'halt_reason' = 'natural' OR (n->>'state' = 'exited' AND n->>'exit_code' = '0') THEN 'completed'
    WHEN n->>'state' IN ('failed','interrupted','cancelled') OR n->>'halt_reason' IN ('error','cancelled') OR (n->>'state' = 'exited' AND n->>'exit_code' <> '0') THEN 'failed' END;
  prior_outcome := CASE WHEN o->>'state' = 'completed' OR o->>'halt_reason' = 'natural' OR (o->>'state' = 'exited' AND o->>'exit_code' = '0') THEN 'completed'
    WHEN o->>'state' IN ('failed','interrupted','cancelled') OR o->>'halt_reason' IN ('error','cancelled') OR (o->>'state' = 'exited' AND o->>'exit_code' <> '0') THEN 'failed' END;
  -- Ignore unchanged totals, status-only writes and duplicate daemon reports.
  IF COALESCE(ins,0) <= prev_ins AND COALESCE(outs,0) <= prev_outs AND COALESCE(reads,0) <= prev_reads AND COALESCE(writes,0) <= prev_writes AND COALESCE(cost,0) <= prev_cost AND (outcome IS NULL OR outcome IS NOT DISTINCT FROM prior_outcome) THEN RETURN; END IF;
  IF historical THEN at_time := COALESCE((n->>'finished_at')::timestamptz, (n->>'completed_at')::timestamptz, (n->>'updated_at')::timestamptz, (n->>'created_at')::timestamptz, now()); END IF;
  INSERT INTO usage_ledger(source_kind,source_id,workspace_id,owner_user_id,subject_id,subject_kind,subject_name,work_id,work_name,href,repo_url,runtime,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost_usd,cost_basis,outcome,retry,historical,occurred_at)
  VALUES(kind,(n->>'id')::uuid,wid,owner_id,COALESCE(owner_id,work_id),CASE WHEN owner_id IS NULL THEN 'work' ELSE 'person' END,
    COALESCE(work_name,'Work'),work_id,COALESCE(work_name,'Work'),href,scope->>'repo_url',runtime,model,
    CASE WHEN ins IS NULL THEN NULL ELSE GREATEST(0,ins-prev_ins) END, CASE WHEN outs IS NULL THEN NULL ELSE GREATEST(0,outs-prev_outs) END,
    CASE WHEN reads IS NULL THEN NULL ELSE GREATEST(0,reads-prev_reads) END, CASE WHEN writes IS NULL THEN NULL ELSE GREATEST(0,writes-prev_writes) END,
    CASE WHEN cost IS NULL THEN NULL ELSE GREATEST(0,cost-prev_cost) END, CASE WHEN cost IS NULL THEN 'unknown' ELSE basis END,
    outcome,COALESCE((n->>'retry_count')::integer,0)>0,historical,at_time);
END $$;
--> statement-breakpoint
CREATE FUNCTION optio_capture_usage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  PERFORM optio_capture_usage_row(TG_TABLE_NAME,to_jsonb(NEW),CASE WHEN TG_OP='INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END);
  RETURN NEW;
END $$;
--> statement-breakpoint
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['tasks','pr_review_runs','persistent_agent_turns','local_terminals','session_chat_turns'] LOOP
    EXECUTE format('CREATE TRIGGER record_usage AFTER INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION optio_capture_usage()',t);
  END LOOP;
END $$;
--> statement-breakpoint
-- Old totals have no observation timestamp. Keep them, explicitly marked as
-- historical estimates of timing, rather than fabricating daily usage.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['tasks','pr_review_runs','persistent_agent_turns','local_terminals','interactive_sessions'] LOOP
    EXECUTE format('SELECT optio_capture_usage_row(%L,to_jsonb(t),''{}''::jsonb,true) FROM %I t',t,t);
  END LOOP;
END $$;
