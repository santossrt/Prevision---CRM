"use client";
import { notificationKinds, type MarkAllResult, type NoticeInput, type NoticeResult, type NotificationDTO, type NotificationList, type NotificationSummary } from "../../lib/notifications/types.ts";
import { notificationHref } from "./notifications-meta.ts";

export class NotificationRequestError extends Error {
  constructor(message: string, readonly status: number, readonly uncertain = false) { super(message); }
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const instant = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/u.test(value) && Number.isFinite(new Date(value).getTime());
const invalid = () => new NotificationRequestError("Não foi possível conferir a resposta do servidor. Atualize a consulta e tente novamente.", 0);

function csrfToken(): string {
  const cookie = document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith("prevision.csrf="));
  try { return cookie ? decodeURIComponent(cookie.slice("prevision.csrf=".length)) : ""; } catch { return ""; }
}
async function request(path: string, options: { signal?: AbortSignal; body?: unknown } = {}): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, {
      credentials: "same-origin", cache: "no-store", signal: options.signal ?? AbortSignal.timeout(30000),
      ...(options.body !== undefined ? { method: "POST", headers: { "Content-Type": "application/json", "X-Prevision-CSRF": csrfToken() }, body: JSON.stringify(options.body) } : {})
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new NotificationRequestError("A conexão foi interrompida. Confira a consulta antes de tentar novamente.", 0, options.body !== undefined);
  }
  const result: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new NotificationRequestError(object(result) && typeof result.message === "string" ? result.message : "Não foi possível concluir a solicitação. Tente novamente.", response.status, options.body !== undefined && response.status >= 500);
  return result;
}
export function parseNotification(value: unknown): NotificationDTO {
  if (!object(value) || typeof value.id !== "string" || !uuid.test(value.id) || typeof value.kind !== "string" || !notificationKinds.includes(value.kind as NotificationDTO["kind"])
    || typeof value.title !== "string" || !value.title || value.title.length > 120 || typeof value.message !== "string" || value.message.length > 2000
    || !instant(value.createdAt) || !(value.readAt === null || instant(value.readAt)) || !(value.href === null || typeof value.href === "string")) throw invalid();
  return { id: value.id, kind: value.kind as NotificationDTO["kind"], title: value.title, message: value.message, createdAt: value.createdAt, readAt: value.readAt, href: notificationHref(value.href) };
}
export function parseNotificationSummary(value: unknown): NotificationSummary {
  if (!object(value) || !count(value.total) || !count(value.unreadCount) || value.unreadCount > value.total || !instant(value.asOf)) throw invalid();
  return { total: value.total, unreadCount: value.unreadCount, asOf: value.asOf };
}
export function parseNotificationList(value: unknown): NotificationList {
  if (!object(value) || !count(value.total) || !count(value.unreadCount) || !instant(value.asOf) || !count(value.page) || value.page < 1
    || !count(value.pageSize) || value.pageSize < 1 || value.pageSize > 50 || !count(value.totalPages) || value.totalPages !== Math.ceil(value.total / value.pageSize)
    || !Array.isArray(value.items) || value.items.length > value.pageSize) throw invalid();
  return { total: value.total, unreadCount: value.unreadCount, asOf: value.asOf, page: value.page, pageSize: value.pageSize, totalPages: value.totalPages, items: value.items.map(parseNotification) };
}
export async function getNotifications(path: string, signal?: AbortSignal): Promise<NotificationList> {
  return parseNotificationList(await request(path, { signal }));
}
export async function getNotificationSummary(signal?: AbortSignal): Promise<NotificationSummary> {
  return parseNotificationSummary(await request("/api/notifications/summary", { signal }));
}
export async function markNotificationRead(id: string): Promise<NotificationDTO> {
  if (!uuid.test(id)) throw invalid();
  const result = parseNotification(await request(`/api/notifications/${id}/read`, { body: {} }));
  if (result.id !== id || !result.readAt) throw invalid();
  return result;
}
export async function markAllNotificationsRead(through: string): Promise<MarkAllResult> {
  if (!instant(through)) throw invalid();
  const result = await request("/api/notifications/read-all", { body: { through } });
  if (!object(result) || !count(result.markedCount)) throw invalid();
  return { markedCount: result.markedCount };
}
export function noticeBody(input: NoticeInput): NoticeInput {
  const title = input.title.trim().replace(/\s+/gu, " "); const message = input.message.trim();
  if (!title || title.length > 120 || !message || message.length > 2000 || !uuid.test(input.idempotencyKey)
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(input.title + message)) throw new NotificationRequestError("Informe um título e uma mensagem dentro dos limites indicados.", 400);
  return { title, message, idempotencyKey: input.idempotencyKey };
}
export function noticeStorageKey(ownerId: string): string { return `prevision.notifications.notice.v1.${ownerId}`; }
export function recoverStoredNotice(value: string): { input: NoticeInput; uncertain: boolean } {
  const parsed: unknown = JSON.parse(value);
  if (!object(parsed) || !object(parsed.input) || typeof parsed.input.title !== "string" || typeof parsed.input.message !== "string" || typeof parsed.input.idempotencyKey !== "string" || typeof parsed.uncertain !== "boolean") throw invalid();
  return { input: noticeBody({ title: parsed.input.title, message: parsed.input.message, idempotencyKey: parsed.input.idempotencyKey }), uncertain: parsed.uncertain };
}
export async function publishNotice(input: NoticeInput): Promise<NoticeResult> {
  const body = noticeBody(input);
  const result = await request("/api/notifications/notices", { body });
  try {
    if (!object(result) || typeof result.replayed !== "boolean") throw invalid();
    const notification = parseNotification(result.notification);
    if (notification.kind !== "ADMIN_NOTICE" || notification.title !== body.title || notification.message !== body.message) throw invalid();
    return { notification, replayed: result.replayed };
  } catch { throw new NotificationRequestError("O servidor respondeu sem confirmar a publicação. Confira o mesmo pedido para evitar avisos duplicados.", 0, true); }
}
export function notificationError(error: unknown): string {
  return error instanceof Error ? error.message : "Não foi possível concluir a solicitação. Tente novamente.";
}
