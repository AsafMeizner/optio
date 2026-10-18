ALTER TABLE "session_chat_turns" ADD COLUMN "prompt" text;
CREATE INDEX "session_chat_turns_queued_idx" ON "session_chat_turns" ("session_id", "started_at") WHERE "state" = 'queued';
ALTER TABLE "session_chat_turns" DROP CONSTRAINT "session_chat_turns_state_check";
ALTER TABLE "session_chat_turns" ADD CONSTRAINT "session_chat_turns_state_check" CHECK ("state" IN ('queued', 'running', 'completed', 'interrupted'));
