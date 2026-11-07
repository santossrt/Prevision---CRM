import { notificationWrite } from "@/server/notifications/http";
import { createAdministrativeNotice } from "@/server/notifications/service";
export const runtime = "nodejs";
export const POST = notificationWrite(createAdministrativeNotice, "notifications-notice", 20);
