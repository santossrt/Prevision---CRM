BEGIN;

CREATE TABLE public.password_reset_jobs (
  id UUID NOT NULL PRIMARY KEY,
  payload TEXT,
  status VARCHAR(12) NOT NULL DEFAULT 'PENDING',
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ(6) NOT NULL,
  locked_by UUID,
  lease_until TIMESTAMPTZ(6),
  processed_at TIMESTAMPTZ(6),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT password_reset_jobs_shape_check CHECK (
    status IN ('PENDING','PROCESSING','COMPLETED','FAILED') AND attempts BETWEEN 0 AND 3
    AND isfinite(created_at) AND isfinite(available_at) AND isfinite(expires_at)
    AND expires_at>created_at AND expires_at<=created_at+interval '15 minutes'
    AND available_at>=created_at AND available_at<=expires_at
    -- PostgreSQL ARE repetition bounds cannot exceed 255. The fixed envelope
    -- consumes 43 characters; its total length bounds the final '+' to 1024.
    AND (payload IS NULL OR (length(payload) BETWEEN 44 AND 1067 AND payload ~ '^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$'))
    AND ((status='PENDING' AND payload IS NOT NULL AND locked_by IS NULL AND lease_until IS NULL AND processed_at IS NULL)
      OR (status='PROCESSING' AND payload IS NOT NULL AND attempts>0 AND locked_by IS NOT NULL AND lease_until IS NOT NULL AND isfinite(lease_until) AND lease_until>created_at AND processed_at IS NULL)
      OR (status IN ('COMPLETED','FAILED') AND payload IS NULL AND locked_by IS NULL AND lease_until IS NULL AND processed_at IS NOT NULL AND isfinite(processed_at) AND processed_at>=created_at))
  )
);
CREATE INDEX password_reset_jobs_pending_idx ON public.password_reset_jobs(available_at,created_at,id) WHERE status='PENDING';
CREATE INDEX password_reset_jobs_processing_idx ON public.password_reset_jobs(lease_until) WHERE status='PROCESSING';
CREATE INDEX password_reset_jobs_expiry_idx ON public.password_reset_jobs(expires_at) WHERE status IN ('PENDING','PROCESSING');
CREATE INDEX password_reset_jobs_terminal_idx ON public.password_reset_jobs(processed_at,id) WHERE status IN ('COMPLETED','FAILED');

CREATE FUNCTION public.guard_password_reset_job() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.status NOT IN ('COMPLETED','FAILED') OR OLD.payload IS NOT NULL OR OLD.processed_at>=clock_timestamp()-interval '1 day' THEN
      RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='Only old terminal reset jobs may be pruned';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status IN ('COMPLETED','FAILED') OR NEW.id<>OLD.id OR NEW.created_at<>OLD.created_at OR NEW.expires_at<>OLD.expires_at
    OR NEW.attempts<OLD.attempts OR NEW.attempts>OLD.attempts+1
    OR (NEW.payload IS DISTINCT FROM OLD.payload AND NOT (NEW.status IN ('COMPLETED','FAILED') AND NEW.payload IS NULL)) THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='Invalid reset job transition';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER password_reset_jobs_guard BEFORE UPDATE OR DELETE ON public.password_reset_jobs
FOR EACH ROW EXECUTE FUNCTION public.guard_password_reset_job();

DO $privileges$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='prevision_app') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON public.password_reset_jobs TO prevision_app;
  END IF;
END;
$privileges$;

COMMIT;
