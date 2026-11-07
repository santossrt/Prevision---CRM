import { z } from "zod";
import { notificationKinds } from "../../lib/notifications/types.ts";
import { ApplicationError } from "../errors/application-error.ts";

const text = (maximum: number) => z.string().trim().max(maximum).refine((value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value));
const instant = z.iso.datetime({ offset: true }).transform((value) => new Date(value).toISOString());
const querySchema = z.object({
  read: z.enum(["all", "unread", "read"]).default("all"), kind: z.enum(notificationKinds).optional(),
  search: text(100).default(""), from: instant.optional(), to: instant.optional(),
  page: z.coerce.number().int().min(1).max(100000).default(1), pageSize: z.coerce.number().int().min(1).max(50).default(20)
}).strict().refine((query) => !query.from || !query.to || query.from <= query.to);
const noticeSchema = z.object({
  title: text(120).transform((value) => value.replace(/\s+/gu, " ")).pipe(z.string().min(1)),
  message: text(2000).pipe(z.string().min(1)), idempotencyKey: z.string().uuid()
}).strict();
const markAllSchema = z.object({ through: instant }).strict();

export function parseNotificationQuery(search: URLSearchParams) {
  const value: Record<string, string> = {};
  for (const [key, entry] of search) {
    if (Object.hasOwn(value, key)) throw new ApplicationError("VALIDATION", "Filtros repetidos não são permitidos.");
    Object.defineProperty(value, key, { value: entry, enumerable: true });
  }
  const result = querySchema.safeParse(value);
  if (!result.success) throw new ApplicationError("VALIDATION", "Confira os filtros e o período das notificações.");
  return result.data;
}
export function parseNotice(body: unknown) {
  const result = noticeSchema.safeParse(body);
  if (!result.success) throw new ApplicationError("VALIDATION", "Informe título, mensagem e identificação válida do aviso.");
  return result.data;
}
export function notificationId(value: string): string {
  const result = z.string().uuid().safeParse(value);
  if (!result.success) throw new ApplicationError("VALIDATION", "Identificador de notificação inválido.");
  return result.data;
}
export function parseMarkRead(body: unknown) {
  if (!z.object({}).strict().safeParse(body).success) throw new ApplicationError("VALIDATION", "Envie uma confirmação de leitura válida.");
}
export function parseMarkAll(body: unknown, now = new Date()): Date {
  const result = markAllSchema.safeParse(body);
  if (!result.success) throw new ApplicationError("VALIDATION", "Atualize as notificações antes de marcar todas como lidas.");
  return new Date(Math.min(new Date(result.data.through).getTime(), now.getTime()));
}
