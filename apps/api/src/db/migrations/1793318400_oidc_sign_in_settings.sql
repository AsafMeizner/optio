ALTER TABLE "auth_provider_configs" ADD COLUMN "settings" jsonb;

CREATE TABLE IF NOT EXISTS "user_identities" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "provider" text NOT NULL,
  "external_id" text NOT NULL,
  "email" text,
  "linked_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "user_identities_provider_external_key"
  ON "user_identities" ("provider", "external_id");
CREATE INDEX IF NOT EXISTS "user_identities_user_idx" ON "user_identities" ("user_id");

