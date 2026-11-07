BEGIN;

-- Temporary payloads may be retired only after expiry. Identifiers and all
-- audit metadata remain immutable; completed import history is preserved.
CREATE OR REPLACE FUNCTION public.guard_product_import() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
BEGIN
  IF TG_OP='UPDATE' AND OLD.status='PREVIEW'
    AND OLD.expires_at<=clock_timestamp() AND OLD.payload<>'{}'::jsonb AND NEW.payload='{}'::jsonb
    AND (to_jsonb(NEW)-'payload')=(to_jsonb(OLD)-'payload') THEN
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' OR OLD.status='COMPLETED' THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='Import history cannot be changed or deleted';
  END IF;
  IF NEW.id<>OLD.id OR NEW.owner_id<>OLD.owner_id OR NEW.file_name<>OLD.file_name OR NEW.format<>OLD.format
    OR NEW.data_hash<>OLD.data_hash OR NEW.payload IS DISTINCT FROM OLD.payload OR NEW.row_count<>OLD.row_count
    OR NEW.error_count<>OLD.error_count OR NEW.created_at<>OLD.created_at OR NEW.expires_at<>OLD.expires_at
    OR NEW.operation_id<>OLD.operation_id OR NEW.status<>'COMPLETED' THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='Import preview is immutable';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION public.guard_report_export() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
BEGIN
  IF TG_OP='UPDATE' AND OLD.expires_at<=clock_timestamp()
    AND OLD.payload<>'{}'::jsonb AND NEW.payload='{}'::jsonb
    AND (to_jsonb(NEW)-'payload')=(to_jsonb(OLD)-'payload') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='Report metadata and live payload cannot be changed or deleted';
END;
$function$;
DROP TRIGGER report_exports_append_only ON public.report_exports;
CREATE TRIGGER report_exports_append_only BEFORE UPDATE OR DELETE ON public.report_exports
FOR EACH ROW EXECUTE FUNCTION public.guard_report_export();

CREATE INDEX report_exports_payload_expiry_idx ON public.report_exports(expires_at,id) WHERE payload<>'{}'::jsonb;
CREATE INDEX report_exports_payload_owner_idx ON public.report_exports(owner_id,expires_at) WHERE payload<>'{}'::jsonb;
CREATE INDEX product_imports_preview_expiry_idx ON public.product_imports(expires_at,id) WHERE status='PREVIEW' AND payload<>'{}'::jsonb;
CREATE INDEX product_imports_preview_owner_idx ON public.product_imports(owner_id,expires_at) WHERE status='PREVIEW' AND payload<>'{}'::jsonb;

DO $privileges$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='prevision_app') THEN
    GRANT UPDATE(payload) ON public.report_exports TO prevision_app;
  END IF;
END;
$privileges$;

COMMIT;
