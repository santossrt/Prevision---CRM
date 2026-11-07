import { notificationWrite } from "@/server/notifications/http";
import { markAllNotificationsRead } from "@/server/notifications/service";
export const runtime = "nodejs";
export const POST = notificationWrite(markAllNotificationsRead);
