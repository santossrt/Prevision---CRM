BEGIN;

CREATE TYPE "public"."StockAlertKind" AS ENUM ('EMPTY', 'LOW');

CREATE TABLE "public"."stock_alerts" (
  "product_id" UUID NOT NULL,
  "kind" "public"."StockAlertKind" NOT NULL,
  "opened_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolved_at" TIMESTAMPTZ(6),
  CONSTRAINT "stock_alerts_pkey" PRIMARY KEY ("product_id"),
  CONSTRAINT "stock_alerts_product_id_fkey" FOREIGN KEY ("product_id")
    REFERENCES "public"."products"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "stock_alerts_timestamps_check" CHECK (
    "changed_at" >= "opened_at"
    AND ("resolved_at" IS NULL OR (
      "resolved_at" >= "opened_at" AND "resolved_at" = "changed_at"
    ))
  )
);

CREATE INDEX "stock_alerts_resolved_at_kind_changed_at_idx"
  ON "public"."stock_alerts" ("resolved_at", "kind", "changed_at");

-- Both product settings and balance changes update the same derived row in the
-- transaction that changed stock. No movement or balance is written here.
CREATE FUNCTION "public"."sync_stock_alert"(target_product_id UUID)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
DECLARE
  product_active boolean;
  current_quantity numeric;
  minimum_quantity numeric;
  previous_change timestamptz;
  transition_time timestamptz;
  next_kind "public"."StockAlertKind";
BEGIN
  -- Serialize cross-row setting/balance changes for this product. The two-key
  -- namespace is separate from the application's one-key authorization locks.
  PERFORM pg_advisory_xact_lock(2026103107, hashtext(target_product_id::text));

  SELECT p.is_active, b.quantity, p.minimum_stock, a.changed_at
    INTO product_active, current_quantity, minimum_quantity, previous_change
    FROM "public"."products" p
    JOIN "public"."stock_balances" b ON b.product_id = p.id
    LEFT JOIN "public"."stock_alerts" a ON a.product_id = p.id
    WHERE p.id = target_product_id;

  transition_time := greatest(clock_timestamp(), previous_change);

  IF NOT FOUND OR NOT product_active OR current_quantity > minimum_quantity THEN
    UPDATE "public"."stock_alerts"
      SET resolved_at = greatest(transition_time, changed_at),
          changed_at = greatest(transition_time, changed_at)
      WHERE product_id = target_product_id AND resolved_at IS NULL;
    RETURN;
  END IF;

  next_kind := CASE WHEN current_quantity = 0
    THEN 'EMPTY'::"public"."StockAlertKind"
    ELSE 'LOW'::"public"."StockAlertKind" END;

  INSERT INTO "public"."stock_alerts" AS current_alert
      (product_id, kind, opened_at, changed_at, resolved_at)
    VALUES (target_product_id, next_kind, transition_time, transition_time, NULL)
    ON CONFLICT (product_id) DO UPDATE SET
      kind = EXCLUDED.kind,
      opened_at = CASE WHEN current_alert.resolved_at IS NOT NULL
        THEN EXCLUDED.opened_at ELSE current_alert.opened_at END,
      changed_at = EXCLUDED.changed_at,
      resolved_at = NULL
    WHERE current_alert.resolved_at IS NOT NULL OR current_alert.kind <> EXCLUDED.kind;
END;
$function$;

CREATE FUNCTION "public"."refresh_stock_alert_after_product"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  PERFORM "public"."sync_stock_alert"(NEW.id);
  RETURN NEW;
END;
$function$;

CREATE FUNCTION "public"."refresh_stock_alert_after_balance"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  PERFORM "public"."sync_stock_alert"(NEW.product_id);
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "products_refresh_stock_alert"
AFTER INSERT OR UPDATE OF "minimum_stock", "is_active" ON "public"."products"
FOR EACH ROW EXECUTE FUNCTION "public"."refresh_stock_alert_after_product"();

CREATE TRIGGER "stock_balances_refresh_stock_alert"
AFTER INSERT OR UPDATE OF "quantity" ON "public"."stock_balances"
FOR EACH ROW EXECUTE FUNCTION "public"."refresh_stock_alert_after_balance"();

-- Initialize existing shortages without changing catalog, balances or ledger.
INSERT INTO "public"."stock_alerts" (product_id, kind)
SELECT p.id, CASE WHEN b.quantity = 0 THEN 'EMPTY'::"public"."StockAlertKind"
  ELSE 'LOW'::"public"."StockAlertKind" END
FROM "public"."products" p
JOIN "public"."stock_balances" b ON b.product_id = p.id
WHERE p.is_active AND (b.quantity = 0 OR b.quantity <= p.minimum_stock);

DO $privileges$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'prevision_app') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE "public"."stock_alerts" TO "prevision_app";
  END IF;
END;
$privileges$;

COMMIT;
