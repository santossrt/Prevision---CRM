-- Historical movements remain readable; new service requests always write a hash.
ALTER TABLE "public"."stock_movements"
  ADD COLUMN "request_hash" VARCHAR(64),
  ADD CONSTRAINT "stock_movements_request_hash_check"
    CHECK ("request_hash" IS NULL OR "request_hash" ~ '^[0-9a-f]{64}$');

CREATE INDEX "stock_movements_occurred_at_id_idx"
  ON "public"."stock_movements" ("occurred_at" DESC, "id" DESC);
