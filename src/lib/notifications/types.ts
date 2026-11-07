export const notificationKinds = ["STOCK_LOW", "STOCK_EMPTY", "STOCK_MOVEMENT", "INVENTORY_COMPLETED", "INVENTORY_DIVERGENCE", "ADMIN_NOTICE"] as const;
export type NotificationKind = typeof notificationKinds[number];
export interface NotificationDTO {
  id: string; kind: NotificationKind; title: string; message: string;
  createdAt: string; readAt: string | null; href: string | null;
}
export interface NotificationSummary { total: number; unreadCount: number; asOf: string }
export interface NotificationList extends NotificationSummary {
  items: NotificationDTO[]; page: number; pageSize: number; totalPages: number;
}
export interface NoticeInput { title: string; message: string; idempotencyKey: string }
export interface NoticeResult { notification: NotificationDTO; replayed: boolean }
export interface MarkAllResult { markedCount: number }
