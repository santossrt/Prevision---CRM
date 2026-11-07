"use client";
import Link from "next/link";
import type { NotificationDTO } from "@/lib/notifications/types";
import { formatCatalogDate } from "@/components/catalog/catalog-meta";
import { Icon } from "@/components/ui/icon";
import { notificationHref, notificationLabels } from "./notifications-meta.ts";

export function NotificationCard({ notification, busy, disabled, onRead }: { notification: NotificationDTO; busy: boolean; disabled: boolean; onRead: (id: string) => void }) {
  const href = notificationHref(notification.href);
  const stock = notification.kind.startsWith("STOCK_");
  const inventory = notification.kind.startsWith("INVENTORY_");
  return <li className={`notification-card${notification.readAt ? " notification-card-read" : " notification-card-unread"}`}>
    <span className={`notification-symbol notification-symbol-${stock ? "stock" : inventory ? "inventory" : "notice"}`} aria-hidden="true"><Icon name={stock ? "package" : inventory ? "inventory" : "shield"} /></span>
    <div className="notification-card-content">
      <div className="notification-card-meta"><span>{notificationLabels[notification.kind]}</span><span className="notification-read-status">{notification.readAt ? <><Icon name="check" />Lida</> : <><span className="notification-unread-dot" />Não lida</>}</span></div>
      <h3>{notification.title}</h3><p>{notification.message}</p>
      <div className="notification-card-footer"><time dateTime={notification.createdAt}>{formatCatalogDate(notification.createdAt)}</time>{notification.readAt && <span>Lida em {formatCatalogDate(notification.readAt)}</span>}</div>
      <div className="notification-card-actions">
        {href && <Link className="text-link" href={href}>{stock ? "Consultar estoque" : "Consultar inventário"}<Icon name="arrow-right" /></Link>}
        {!notification.readAt && <button type="button" className="text-link" onClick={() => onRead(notification.id)} disabled={disabled}>{busy ? "Marcando…" : "Marcar como lida"}</button>}
      </div>
    </div>
  </li>;
}
