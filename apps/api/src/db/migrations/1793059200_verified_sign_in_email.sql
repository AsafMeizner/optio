-- Email-based privileges require an assertion from the identity provider.
-- Existing users obtain this assertion at their next successful sign-in.
ALTER TABLE "users" ADD COLUMN "email_verified" boolean NOT NULL DEFAULT false;
