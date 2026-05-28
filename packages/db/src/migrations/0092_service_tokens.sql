CREATE TABLE IF NOT EXISTS "service_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "token_hash" text NOT NULL UNIQUE,
  "name" text NOT NULL,
  "scopes" text[] NOT NULL,
  "created_by_user_id" uuid REFERENCES "user"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "last_used_at" timestamptz,
  "revoked_at" timestamptz,
  "description" text
);

CREATE INDEX IF NOT EXISTS "service_tokens_token_hash_idx" ON "service_tokens" ("token_hash") WHERE "revoked_at" IS NULL;
CREATE INDEX IF NOT EXISTS "service_tokens_company_idx" ON "service_tokens" ("company_id");
