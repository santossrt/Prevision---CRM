BEGIN;
CREATE TYPE "public"."NotificationKind" AS ENUM ('STOCK_LOW','STOCK_EMPTY','STOCK_MOVEMENT','INVENTORY_COMPLETED','INVENTORY_DIVERGENCE','ADMIN_NOTICE');

CREATE TABLE "public"."notifications" (
  id UUID NOT NULL PRIMARY KEY,
  kind "public"."NotificationKind" NOT NULL,
  title VARCHAR(120) NOT NULL,
  message VARCHAR(2000) NOT NULL,
  event_key VARCHAR(200) NOT NULL,
  entity_type VARCHAR(32),
  entity_id UUID,
  required_permission VARCHAR(100),
  actor_id UUID REFERENCES "public"."users"(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT notifications_content_check CHECK (length(btrim(title))>0 AND length(btrim(message))>0 AND length(btrim(event_key))>0),
  CONSTRAINT notifications_source_check CHECK ((
    (kind='ADMIN_NOTICE' AND entity_type IS NULL AND entity_id IS NULL AND required_permission IS NULL AND actor_id IS NOT NULL)
    OR (kind IN ('STOCK_LOW','STOCK_EMPTY') AND entity_type='Product' AND entity_id IS NOT NULL AND required_permission='stock.read')
    OR (kind='STOCK_MOVEMENT' AND entity_type='StockMovement' AND entity_id IS NOT NULL AND required_permission='stock.read' AND actor_id IS NOT NULL)
    OR (kind IN ('INVENTORY_COMPLETED','INVENTORY_DIVERGENCE') AND entity_type='Inventory' AND entity_id IS NOT NULL AND required_permission='stock.read' AND actor_id IS NOT NULL)
  ) IS TRUE)
);
CREATE UNIQUE INDEX notifications_event_key_key ON "public"."notifications"(event_key);
CREATE INDEX notifications_required_permission_created_at_idx ON "public"."notifications"(required_permission,created_at);
CREATE INDEX notifications_kind_created_at_idx ON "public"."notifications"(kind,created_at);

CREATE TABLE "public"."notification_reads" (
  notification_id UUID NOT NULL REFERENCES "public"."notifications"(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  user_id UUID NOT NULL REFERENCES "public"."users"(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  read_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(notification_id,user_id)
);
CREATE INDEX notification_reads_user_id_read_at_idx ON "public"."notification_reads"(user_id,read_at);

CREATE TABLE "public"."user_preferences" (
  user_id UUID NOT NULL PRIMARY KEY REFERENCES "public"."users"(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  theme VARCHAR(10) NOT NULL DEFAULT 'system',
  version INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT user_preferences_shape_check CHECK (theme IN ('system','light','dark') AND version>=0)
);
CREATE FUNCTION "public"."guard_user_preference"() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
BEGIN
  IF TG_OP='DELETE' OR NEW.user_id<>OLD.user_id OR NEW.version<>OLD.version+1 OR NEW.updated_at<OLD.updated_at THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='Preference owner and version must be preserved';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER user_preferences_preserve_owner BEFORE UPDATE OR DELETE ON "public"."user_preferences"
FOR EACH ROW EXECUTE FUNCTION "public"."guard_user_preference"();
CREATE TRIGGER notifications_append_only BEFORE UPDATE OR DELETE ON "public"."notifications"
FOR EACH ROW EXECUTE FUNCTION "public"."reject_history_mutation"();
CREATE TRIGGER notification_reads_append_only BEFORE UPDATE OR DELETE ON "public"."notification_reads"
FOR EACH ROW EXECUTE FUNCTION "public"."reject_history_mutation"();

-- Notifications share the transaction of the source operation. A rollback
-- cannot leave a notification about a movement that was never committed.
CREATE FUNCTION "public"."notify_stock_alert_transition"() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
DECLARE product_name text; product_sku text; current_quantity numeric; minimum_quantity numeric;
BEGIN
  IF NEW.resolved_at IS NOT NULL THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' THEN
    IF OLD.resolved_at IS NULL AND OLD.kind=NEW.kind THEN RETURN NEW; END IF;
  END IF;
  SELECT p.name,p.sku,b.quantity,p.minimum_stock INTO product_name,product_sku,current_quantity,minimum_quantity
    FROM "public"."products" p JOIN "public"."stock_balances" b ON b.product_id=p.id WHERE p.id=NEW.product_id;
  INSERT INTO "public"."notifications"(id,kind,title,message,event_key,entity_type,entity_id,required_permission,created_at)
  VALUES(gen_random_uuid(),CASE WHEN NEW.kind='EMPTY' THEN 'STOCK_EMPTY'::"public"."NotificationKind" ELSE 'STOCK_LOW'::"public"."NotificationKind" END,
    CASE WHEN NEW.kind='EMPTY' THEN 'Produto sem estoque' ELSE 'Estoque baixo' END,
    product_name || ' (SKU ' || product_sku || '). Saldo: ' || current_quantity::text || '; mínimo: ' || minimum_quantity::text || '.',
    'stock-alert:' || NEW.product_id::text || ':' || NEW.kind::text || ':' || extract(epoch from NEW.changed_at)::text,
    'Product',NEW.product_id,'stock.read',clock_timestamp()) ON CONFLICT(event_key) DO NOTHING;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER stock_alerts_create_notification AFTER INSERT OR UPDATE ON "public"."stock_alerts"
FOR EACH ROW EXECUTE FUNCTION "public"."notify_stock_alert_transition"();

-- Adjustments and compensations are the relevant movements for this initial
-- feed. Inventory adjustments are grouped in their inventory notification.
CREATE FUNCTION "public"."notify_relevant_movement"() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
DECLARE product_name text; product_sku text;
BEGIN
  IF NEW.type NOT IN ('POSITIVE_ADJUSTMENT','NEGATIVE_ADJUSTMENT','COMPENSATION') OR NEW.idempotency_key LIKE 'inventory:%' THEN RETURN NEW; END IF;
  SELECT name,sku INTO product_name,product_sku FROM "public"."products" WHERE id=NEW.product_id;
  INSERT INTO "public"."notifications"(id,kind,title,message,event_key,entity_type,entity_id,required_permission,actor_id,created_at)
  VALUES(gen_random_uuid(),'STOCK_MOVEMENT',CASE WHEN NEW.type='COMPENSATION' THEN 'Movimentação compensada' ELSE 'Ajuste de estoque registrado' END,
    product_name || ' (SKU ' || product_sku || '). Variação: ' || NEW.quantity_delta::text || '; saldo resultante: ' || NEW.quantity_after::text || '.',
    'movement:' || NEW.id::text,'StockMovement',NEW.id,'stock.read',NEW.performed_by_id,clock_timestamp()) ON CONFLICT(event_key) DO NOTHING;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER stock_movements_create_notification AFTER INSERT ON "public"."stock_movements"
FOR EACH ROW EXECUTE FUNCTION "public"."notify_relevant_movement"();

CREATE FUNCTION "public"."notify_inventory_completed"() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
DECLARE divergent_count integer;
BEGIN
  IF OLD.status=NEW.status OR NEW.status<>'COMPLETED' THEN RETURN NEW; END IF;
  SELECT count(*)::int INTO divergent_count FROM "public"."inventory_items" WHERE inventory_id=NEW.id AND counted_quantity<>baseline_quantity;
  INSERT INTO "public"."notifications"(id,kind,title,message,event_key,entity_type,entity_id,required_permission,actor_id,created_at)
  VALUES(gen_random_uuid(),'INVENTORY_COMPLETED','Inventário concluído','A conferência “' || NEW.title || '” foi concluída.',
    'inventory-completed:' || NEW.id::text,'Inventory',NEW.id,'stock.read',NEW.completed_by_id,clock_timestamp()) ON CONFLICT(event_key) DO NOTHING;
  IF divergent_count>0 THEN
    INSERT INTO "public"."notifications"(id,kind,title,message,event_key,entity_type,entity_id,required_permission,actor_id,created_at)
    VALUES(gen_random_uuid(),'INVENTORY_DIVERGENCE','Divergências de inventário','A conferência “' || NEW.title || '” registrou ' || divergent_count::text || ' produto(s) com divergência e ajustes vinculados.',
      'inventory-divergence:' || NEW.id::text,'Inventory',NEW.id,'stock.read',NEW.completed_by_id,clock_timestamp()) ON CONFLICT(event_key) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER inventories_create_notification AFTER UPDATE OF status ON "public"."inventories"
FOR EACH ROW EXECUTE FUNCTION "public"."notify_inventory_completed"();

-- Seed only the current, real shortages. Older movement/inventory history is
-- left untouched and is not represented as newly occurring activity.
INSERT INTO "public"."notifications"(id,kind,title,message,event_key,entity_type,entity_id,required_permission)
SELECT gen_random_uuid(),CASE WHEN a.kind='EMPTY' THEN 'STOCK_EMPTY'::"public"."NotificationKind" ELSE 'STOCK_LOW'::"public"."NotificationKind" END,
  CASE WHEN a.kind='EMPTY' THEN 'Produto sem estoque' ELSE 'Estoque baixo' END,
  p.name || ' (SKU ' || p.sku || '). Condição existente ao habilitar a central. Saldo: ' || b.quantity::text || '; mínimo: ' || p.minimum_stock::text || '.',
  'stock-alert:' || a.product_id::text || ':' || a.kind::text || ':' || extract(epoch from a.changed_at)::text,'Product',p.id,'stock.read'
FROM "public"."stock_alerts" a JOIN "public"."products" p ON p.id=a.product_id JOIN "public"."stock_balances" b ON b.product_id=p.id
WHERE a.resolved_at IS NULL AND p.is_active ON CONFLICT(event_key) DO NOTHING;

DO $privileges$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='prevision_app') THEN
    GRANT SELECT,INSERT ON "public"."notifications","public"."notification_reads" TO prevision_app;
    GRANT SELECT,INSERT,UPDATE ON "public"."user_preferences" TO prevision_app;
  END IF;
END;
$privileges$;
COMMIT;
