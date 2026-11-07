BEGIN;
ALTER TYPE "public"."AuditModule" ADD VALUE 'INVENTORY';
CREATE TYPE "public"."InventoryStatus" AS ENUM ('OPEN', 'COMPLETED', 'CANCELED');
CREATE TYPE "public"."InventoryOperationKind" AS ENUM ('CREATE', 'COUNT', 'REBASE', 'COMPLETE', 'CANCEL');

CREATE TABLE "public"."inventories" (
  "id" UUID NOT NULL,
  "title" VARCHAR(160) NOT NULL,
  "notes" TEXT,
  "status" "public"."InventoryStatus" NOT NULL DEFAULT 'OPEN',
  "version" INTEGER NOT NULL DEFAULT 0,
  "opened_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMPTZ(6),
  "canceled_at" TIMESTAMPTZ(6),
  "created_by_id" UUID NOT NULL,
  "completed_by_id" UUID,
  "canceled_by_id" UUID,
  CONSTRAINT "inventories_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "inventories_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT,
  CONSTRAINT "inventories_completed_by_id_fkey" FOREIGN KEY ("completed_by_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT,
  CONSTRAINT "inventories_canceled_by_id_fkey" FOREIGN KEY ("canceled_by_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT,
  CONSTRAINT "inventories_title_check" CHECK (length(btrim(title)) > 0),
  CONSTRAINT "inventories_version_check" CHECK (version >= 0),
  CONSTRAINT "inventories_state_check" CHECK (
    (status = 'OPEN' AND completed_at IS NULL AND completed_by_id IS NULL AND canceled_at IS NULL AND canceled_by_id IS NULL)
    OR (status = 'COMPLETED' AND completed_at IS NOT NULL AND completed_at >= opened_at AND completed_by_id IS NOT NULL AND canceled_at IS NULL AND canceled_by_id IS NULL)
    OR (status = 'CANCELED' AND canceled_at IS NOT NULL AND canceled_at >= opened_at AND canceled_by_id IS NOT NULL AND completed_at IS NULL AND completed_by_id IS NULL)
  )
);

CREATE TABLE "public"."inventory_items" (
  "inventory_id" UUID NOT NULL,
  "product_id" UUID NOT NULL,
  "name" VARCHAR(160) NOT NULL,
  "sku" VARCHAR(64) NOT NULL,
  "unit_of_measure" VARCHAR(20) NOT NULL,
  "category_name" VARCHAR(100) NOT NULL,
  "baseline_quantity" DECIMAL(18,4) NOT NULL,
  "baseline_version" INTEGER NOT NULL,
  "counted_quantity" DECIMAL(18,4),
  "justification" VARCHAR(600),
  "counted_by_id" UUID,
  "counted_at" TIMESTAMPTZ(6),
  "movement_id" UUID,
  CONSTRAINT "inventory_items_pkey" PRIMARY KEY (inventory_id, product_id),
  CONSTRAINT "inventory_items_inventory_id_fkey" FOREIGN KEY (inventory_id) REFERENCES "public"."inventories"(id) ON DELETE RESTRICT,
  CONSTRAINT "inventory_items_product_id_fkey" FOREIGN KEY (product_id) REFERENCES "public"."products"(id) ON DELETE RESTRICT,
  CONSTRAINT "inventory_items_counted_by_id_fkey" FOREIGN KEY (counted_by_id) REFERENCES "public"."users"(id) ON DELETE RESTRICT,
  CONSTRAINT "inventory_items_movement_id_fkey" FOREIGN KEY (movement_id) REFERENCES "public"."stock_movements"(id) ON DELETE RESTRICT,
  CONSTRAINT "inventory_items_quantities_check" CHECK (
    baseline_quantity >= 0 AND baseline_quantity <> 'NaN'::numeric AND baseline_version >= 0
    AND (counted_quantity IS NULL OR (counted_quantity >= 0 AND counted_quantity <> 'NaN'::numeric))
  ),
  CONSTRAINT "inventory_items_count_pair_check" CHECK (
    (counted_quantity IS NULL AND counted_by_id IS NULL AND counted_at IS NULL AND justification IS NULL)
    OR (counted_quantity IS NOT NULL AND counted_by_id IS NOT NULL AND counted_at IS NOT NULL)
  ),
  CONSTRAINT "inventory_items_justification_check" CHECK (
    counted_quantity IS NULL OR counted_quantity = baseline_quantity OR (justification IS NOT NULL AND length(btrim(justification)) > 0)
  ),
  CONSTRAINT "inventory_items_movement_count_check" CHECK (movement_id IS NULL OR (counted_quantity IS NOT NULL AND counted_quantity <> baseline_quantity))
);
CREATE UNIQUE INDEX "inventory_items_movement_id_key" ON "public"."inventory_items"(movement_id);
CREATE INDEX "inventory_items_product_id_idx" ON "public"."inventory_items"(product_id);
CREATE INDEX "inventory_items_counted_by_id_idx" ON "public"."inventory_items"(counted_by_id);

CREATE TABLE "public"."inventory_operations" (
  "key" UUID NOT NULL,
  "inventory_id" UUID NOT NULL,
  "actor_id" UUID NOT NULL,
  "kind" "public"."InventoryOperationKind" NOT NULL,
  "request_hash" VARCHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "inventory_operations_pkey" PRIMARY KEY (key),
  CONSTRAINT "inventory_operations_inventory_id_fkey" FOREIGN KEY (inventory_id) REFERENCES "public"."inventories"(id) ON DELETE RESTRICT,
  CONSTRAINT "inventory_operations_actor_id_fkey" FOREIGN KEY (actor_id) REFERENCES "public"."users"(id) ON DELETE RESTRICT,
  CONSTRAINT "inventory_operations_hash_check" CHECK (request_hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX "inventories_status_opened_at_idx" ON "public"."inventories"(status, opened_at);
CREATE INDEX "inventories_created_by_id_opened_at_idx" ON "public"."inventories"(created_by_id, opened_at);
CREATE INDEX "inventory_operations_inventory_id_created_at_idx" ON "public"."inventory_operations"(inventory_id, created_at);
CREATE INDEX "inventory_operations_actor_id_idx" ON "public"."inventory_operations"(actor_id);

CREATE FUNCTION "public"."guard_closed_inventory"()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
BEGIN
  IF OLD.status <> 'OPEN' OR TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'Inventory history cannot be changed or deleted';
  END IF;
  IF NEW.id <> OLD.id OR NEW.created_by_id <> OLD.created_by_id OR NEW.opened_at <> OLD.opened_at THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'Inventory identity cannot be changed';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "inventories_preserve_history" BEFORE UPDATE OR DELETE ON "public"."inventories"
FOR EACH ROW EXECUTE FUNCTION "public"."guard_closed_inventory"();

CREATE FUNCTION "public"."guard_inventory_item"()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
DECLARE parent_status "public"."InventoryStatus";
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'Inventory items cannot be deleted';
  END IF;
  SELECT status INTO parent_status FROM "public"."inventories" WHERE id = NEW.inventory_id FOR UPDATE;
  IF parent_status IS DISTINCT FROM 'OPEN'::"public"."InventoryStatus" THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'Closed inventory items cannot be changed';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.inventory_id <> OLD.inventory_id OR NEW.product_id <> OLD.product_id
      OR NEW.name <> OLD.name OR NEW.sku <> OLD.sku OR NEW.unit_of_measure <> OLD.unit_of_measure OR NEW.category_name <> OLD.category_name) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'Inventory item identity cannot be changed';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "inventory_items_preserve_history" BEFORE INSERT OR UPDATE OR DELETE ON "public"."inventory_items"
FOR EACH ROW EXECUTE FUNCTION "public"."guard_inventory_item"();
CREATE TRIGGER "inventory_operations_append_only" BEFORE UPDATE OR DELETE ON "public"."inventory_operations"
FOR EACH ROW EXECUTE FUNCTION "public"."reject_history_mutation"();

DO $privileges$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'prevision_app') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE "public"."inventories", "public"."inventory_items" TO "prevision_app";
    GRANT SELECT, INSERT ON TABLE "public"."inventory_operations" TO "prevision_app";
  END IF;
END;
$privileges$;
COMMIT;
