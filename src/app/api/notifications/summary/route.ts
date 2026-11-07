import { notificationRead } from "@/server/notifications/http";
import { getNotificationSummary } from "@/server/notifications/service";
import { ApplicationError } from "@/server/errors/application-error";
export const runtime = "nodejs";
export const GET = notificationRead((actor, query) => {
  if (query.size) throw new ApplicationError("VALIDATION", "O resumo não aceita filtros.");
  return getNotificationSummary(actor);
});
