import { auditItemRead } from "@/server/audit/http";
import { getAuditEvent } from "@/server/audit/service";
export const runtime = "nodejs";
export const GET = auditItemRead(getAuditEvent);
