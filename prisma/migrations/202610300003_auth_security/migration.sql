BEGIN;

ALTER TYPE "public"."AccessTokenPurpose" ADD VALUE 'GOOGLE_LINK';

ALTER TABLE "public"."users"
    ADD COLUMN "google_access_allowed" BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX "auth_accounts_user_id_provider_key"
    ON "public"."auth_accounts"("user_id", "provider");

CREATE TABLE "public"."rate_limit_buckets" (
    "key" CHAR(64) NOT NULL,
    "window_start" TIMESTAMPTZ(6) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "rate_limit_buckets_pkey" PRIMARY KEY ("key"),
    CONSTRAINT "rate_limit_buckets_key_check" CHECK ("key" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "rate_limit_buckets_count_check" CHECK ("count" >= 0),
    CONSTRAINT "rate_limit_buckets_expiration_check" CHECK ("expires_at" > "window_start")
);

CREATE INDEX "rate_limit_buckets_expires_at_idx"
    ON "public"."rate_limit_buckets"("expires_at");

DO $privileges$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'prevision_app') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "public"."rate_limit_buckets"
            TO "prevision_app";
    END IF;
END;
$privileges$;

COMMIT;
