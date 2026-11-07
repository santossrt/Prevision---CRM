import { notificationKinds, type NotificationKind } from "../../lib/notifications/types.ts";

export const notificationLabels: Record<NotificationKind, string> = {
  STOCK_LOW: "Estoque baixo", STOCK_EMPTY: "Sem estoque", STOCK_MOVEMENT: "Movimentação relevante",
  INVENTORY_COMPLETED: "Inventário concluído", INVENTORY_DIVERGENCE: "Divergência de inventário", ADMIN_NOTICE: "Aviso administrativo"
};
export const initialNotificationFilters = { search: "", read: "all", kind: "", from: "", to: "" };
export type NotificationFilters = typeof initialNotificationFilters;
const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const target = new RegExp(`^(?:/estoque(?:\\?(?:productId|movementId)=${uuid})?|/inventarios(?:\\?id=${uuid})?)$`, "iu");

/** Server supplies targets, but a response can never turn into an external URL. */
export function notificationHref(value: unknown): string | null {
  return typeof value === "string" && target.test(value) ? value : null;
}
function validDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function notificationQuery(filters: NotificationFilters, page: number): string {
  if (!Number.isInteger(page) || page < 1) throw new Error("Escolha uma página válida.");
  if (!["all", "read", "unread"].includes(filters.read)) throw new Error("Escolha uma situação de leitura válida.");
  if (filters.kind && !notificationKinds.includes(filters.kind as NotificationKind)) throw new Error("Escolha um tipo de notificação válido.");
  for (const value of [filters.from, filters.to]) if (value && !validDay(value)) throw new Error("Informe datas válidas para a consulta.");
  if (filters.from && filters.to && filters.from > filters.to) throw new Error("A data inicial deve ser anterior ou igual à data final.");
  const query = new URLSearchParams({ page: String(page), pageSize: "20", read: filters.read });
  if (filters.search.trim()) query.set("search", filters.search.trim().slice(0, 100));
  if (filters.kind) query.set("kind", filters.kind);
  if (filters.from) query.set("from", new Date(`${filters.from}T00:00:00`).toISOString());
  if (filters.to) query.set("to", new Date(`${filters.to}T23:59:59.999`).toISOString());
  return query.toString();
}
