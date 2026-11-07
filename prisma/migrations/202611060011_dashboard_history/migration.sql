BEGIN;
-- Record when the history row is inserted, after the application acquired its
-- authorization/catalog locks. CURRENT_TIMESTAMP is the transaction start and
-- could precede a value change committed while this transaction was waiting.
-- Existing append-only history is deliberately left intact.
ALTER TABLE "public"."product_value_history"
  ALTER COLUMN effective_at SET DEFAULT clock_timestamp(),
  ALTER COLUMN created_at SET DEFAULT clock_timestamp();

CREATE INDEX stock_movements_product_id_created_at_idx
  ON "public"."stock_movements"(product_id,created_at);
CREATE INDEX product_value_history_timeline_idx
  ON "public"."product_value_history"(product_id,type,effective_at,created_at,id);
COMMIT;
