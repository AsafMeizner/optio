ALTER TABLE "interactive_sessions" ADD COLUMN "links" jsonb NOT NULL DEFAULT '[]'::jsonb;
