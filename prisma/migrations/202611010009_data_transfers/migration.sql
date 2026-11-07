BEGIN;
ALTER TYPE "public"."AuditModule" ADD VALUE 'TRANSFERS';
ALTER TYPE "public"."AuditAction" ADD VALUE 'IMPORT';
ALTER TYPE "public"."AuditAction" ADD VALUE 'EXPORT';
CREATE TYPE "public"."ProductImportStatus" AS ENUM ('PREVIEW', 'COMPLETED');

CREATE TABLE "public"."product_imports" (
  id UUID NOT NULL PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES "public"."users"(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  file_name VARCHAR(180) NOT NULL,
  format VARCHAR(8) NOT NULL,
  data_hash VARCHAR(64) NOT NULL,
  status "public"."ProductImportStatus" NOT NULL DEFAULT 'PREVIEW',
  payload JSONB NOT NULL,
  row_count INTEGER NOT NULL,
  error_count INTEGER NOT NULL,
  created_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMPTZ(6) NOT NULL,
  completed_at TIMESTAMPTZ(6),
  confirmation_key UUID,
  operation_id UUID NOT NULL,
  CONSTRAINT product_imports_shape_check CHECK (
    length(btrim(file_name)) > 0 AND format IN ('csv','xlsx') AND data_hash ~ '^[0-9a-f]{64}$'
    AND row_count BETWEEN 1 AND 200 AND error_count BETWEEN 0 AND row_count
    AND created_count BETWEEN 0 AND row_count AND expires_at > created_at
    AND ((status='PREVIEW' AND completed_at IS NULL AND confirmation_key IS NULL AND created_count=0)
      OR (status='COMPLETED' AND completed_at IS NOT NULL AND completed_at>=created_at AND confirmation_key IS NOT NULL AND error_count=0 AND created_count=row_count))
  )
);
CREATE UNIQUE INDEX product_imports_confirmation_key_key ON "public"."product_imports"(confirmation_key);
CREATE UNIQUE INDEX product_imports_completed_digest_key ON "public"."product_imports"(owner_id,data_hash) WHERE status='COMPLETED';
CREATE INDEX product_imports_owner_id_created_at_idx ON "public"."product_imports"(owner_id,created_at);
CREATE INDEX product_imports_owner_id_data_hash_status_idx ON "public"."product_imports"(owner_id,data_hash,status);

CREATE TABLE "public"."report_exports" (
  id UUID NOT NULL PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES "public"."users"(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  kind VARCHAR(30) NOT NULL,
  payload JSONB NOT NULL,
  row_count INTEGER NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMPTZ(6) NOT NULL,
  operation_id UUID NOT NULL,
  CONSTRAINT report_exports_shape_check CHECK (length(btrim(kind))>0 AND row_count BETWEEN 0 AND 1000 AND expires_at>created_at)
);
CREATE INDEX report_exports_owner_id_created_at_idx ON "public"."report_exports"(owner_id,created_at);

CREATE FUNCTION "public"."guard_product_import"() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
BEGIN
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
CREATE TRIGGER product_imports_preserve_history BEFORE UPDATE OR DELETE ON "public"."product_imports"
FOR EACH ROW EXECUTE FUNCTION "public"."guard_product_import"();
CREATE TRIGGER report_exports_append_only BEFORE UPDATE OR DELETE ON "public"."report_exports"
FOR EACH ROW EXECUTE FUNCTION "public"."reject_history_mutation"();
DO $privileges$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='prevision_app') THEN
    GRANT SELECT,INSERT,UPDATE ON "public"."product_imports" TO prevision_app;
    GRANT SELECT,INSERT ON "public"."report_exports" TO prevision_app;
  END IF;
END;
$privileges$;
COMMIT;
