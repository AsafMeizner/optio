ALTER TABLE interactive_sessions ADD COLUMN agent_runtime text;
ALTER TABLE interactive_sessions ADD COLUMN agent_options jsonb;
ALTER TABLE interactive_sessions ADD COLUMN initial_prompt text NOT NULL DEFAULT '';
ALTER TABLE interactive_sessions ADD COLUMN settings jsonb;
ALTER TABLE interactive_sessions ADD COLUMN assistant boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX interactive_sessions_assistant_owner_key ON interactive_sessions
  (COALESCE(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid),
   COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE assistant AND state = 'active';
ALTER TABLE optio_settings ADD COLUMN agent_runtime text NOT NULL DEFAULT 'claude-code';
ALTER TABLE optio_settings ADD COLUMN agent_options jsonb NOT NULL DEFAULT '{}';
CREATE TABLE session_tool_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES interactive_sessions(id) ON DELETE CASCADE,
  turn_id uuid NOT NULL REFERENCES session_chat_turns(id) ON DELETE CASCADE,
  tool text NOT NULL,
  args jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  feedback text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX session_tool_approvals_session_idx ON session_tool_approvals(session_id);
