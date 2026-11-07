"use client";
import Link from "next/link";
import { useCallback } from "react";
import { getNotificationSummary } from "./notifications-api.ts";
import { useNotifications } from "./use-notifications.ts";

export function NotificationBell({ ownerId }: { ownerId: string }) {
  const load = useCallback((signal: AbortSignal) => getNotificationSummary(signal), []);
  const { data, error } = useNotifications(`${ownerId}:summary`, load);
  const unread = data?.unreadCount;
  const label = unread === undefined ? "Abrir central de notificações" : `${unread} ${unread === 1 ? "notificação não lida" : "notificações não lidas"}. Abrir central de notificações.`;
  return <Link href="/notificacoes" className="notification-bell icon-button" aria-label={label} title={error ? "Não foi possível atualizar a contagem. Abra a central para consultar." : "Central de notificações"}>
    <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></svg>
    {unread !== undefined && unread > 0 && <span className="notification-bell-count" aria-hidden="true">{unread > 99 ? "99+" : unread}</span>}
    {error && <span className="notification-bell-error" aria-hidden="true">!</span>}
  </Link>;
}
