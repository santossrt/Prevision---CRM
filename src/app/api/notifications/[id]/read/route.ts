import { notificationItemWrite } from "@/server/notifications/http";
import { markNotificationRead } from "@/server/notifications/service";
export const runtime = "nodejs";
export const POST = notificationItemWrite(markNotificationRead);
