import { auditRead } from "@/server/audit/http";
import { getAuditOptions } from "@/server/audit/service";
export const runtime = "nodejs";
export const GET = auditRead(getAuditOptions);
