import { notificationRead } from "@/server/notifications/http";
import { listNotifications } from "@/server/notifications/service";
export const runtime = "nodejs";
export const GET = notificationRead(listNotifications);
