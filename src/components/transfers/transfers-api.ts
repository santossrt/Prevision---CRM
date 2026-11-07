"use client";

import type { ImportPreviewDTO, ImportResult, ReportPreviewDTO, ReportPreviewInput } from "@/lib/transfers/types";
export { catalogError as transferError, catalogRequest as transferRequest, isCancelled } from "@/components/catalog/catalog-api";

export const maximumImportBytes = 2 * 1024 * 1024;
export interface ImportPending { importId: string; idempotencyKey: string; fileName: string; rowCount: number }
export interface StoredImport { previewId: string; pending?: ImportPending }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function importStorageKey(ownerId: string) { return `prevision.transfers.import.v1.${ownerId}`; }
export function recoverStoredImport(raw: string): StoredImport {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || !("previewId" in value) || typeof value.previewId !== "string" || !uuid.test(value.previewId)) throw new Error("invalid-import-recovery");
  const result: StoredImport = { previewId: value.previewId };
  if ("pending" in value && value.pending !== undefined) {
    const pending = value.pending as ImportPending;
    if (!pending || pending.importId !== result.previewId || !uuid.test(pending.idempotencyKey) || typeof pending.fileName !== "string" || !pending.fileName || pending.fileName.length > 180
      || !Number.isInteger(pending.rowCount) || pending.rowCount < 1 || pending.rowCount > 200) throw new Error("invalid-import-recovery");
    result.pending = { importId: pending.importId, idempotencyKey: pending.idempotencyKey, fileName: pending.fileName, rowCount: pending.rowCount };
  }
  return result;
}
export function validateImportFile(file: Pick<File, "name" | "size">): "csv" | "xlsx" {
  if (!file.size) throw new Error("Selecione um arquivo com dados para conferir.");
  if (file.size > maximumImportBytes) throw new Error("O arquivo deve ter no máximo 2 MB.");
  if (/\.csv$/i.test(file.name)) return "csv";
  if (/\.xlsx$/i.test(file.name)) return "xlsx";
  throw new Error("Selecione um arquivo CSV ou Excel no formato .xlsx.");
}
function csrfToken() {
  const cookie = document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith("prevision.csrf="));
  try { return cookie ? decodeURIComponent(cookie.slice("prevision.csrf=".length)) : ""; } catch { return ""; }
}
export class TransferRequestError extends Error {
  constructor(message: string, readonly status: number, readonly uncertain = status >= 500, readonly code?: "IMPORT_PREVIEW_EXPIRED") { super(message); }
}
async function jsonResult(response: Response): Promise<unknown> {
  const result: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = result && typeof result === "object" && "message" in result && typeof result.message === "string" ? result.message : "Não foi possível concluir a solicitação. Tente novamente.";
    const code = result && typeof result === "object" && "code" in result && result.code === "IMPORT_PREVIEW_EXPIRED" ? "IMPORT_PREVIEW_EXPIRED" : undefined;
    throw new TransferRequestError(message, response.status, response.status >= 500, code);
  }
  return result;
}
function importPreview(result: unknown): ImportPreviewDTO {
  const preview = result as ImportPreviewDTO | null;
  if (!preview || typeof preview !== "object" || typeof preview.id !== "string" || !uuid.test(preview.id) || typeof preview.fileName !== "string" || !["csv", "xlsx"].includes(preview.format)
    || !["PREVIEW", "COMPLETED", "EXPIRED"].includes(preview.status) || !Array.isArray(preview.rows) || !Array.isArray(preview.columns)
    || !Number.isInteger(preview.rowCount) || preview.rowCount < 1 || preview.rowCount > 200 || preview.rows.length !== preview.rowCount
    || !Number.isInteger(preview.createdCount) || !Number.isInteger(preview.validCount) || !Number.isInteger(preview.errorCount)
    || preview.validCount < 0 || preview.errorCount < 0 || preview.createdCount < 0 || preview.createdCount > preview.rowCount
    || typeof preview.canConfirm !== "boolean" || typeof preview.createdAt !== "string" || typeof preview.expiresAt !== "string") {
    throw new TransferRequestError("O servidor respondeu sem a prévia completa do arquivo.", 0, true);
  }
  return result as ImportPreviewDTO;
}
export async function uploadImport(file: File, signal?: AbortSignal): Promise<ImportPreviewDTO> {
  validateImportFile(file);
  const body = new FormData(); body.append("file", file);
  let response: Response;
  try {
    response = await fetch("/api/transfers/imports/preview", { method: "POST", credentials: "same-origin", cache: "no-store", signal: signal ?? AbortSignal.timeout(30000), headers: { "X-Prevision-CSRF": csrfToken() }, body });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new TransferRequestError("Não foi possível enviar o arquivo. Confira sua conexão e tente novamente; nenhum produto é criado nesta etapa.", 0);
  }
  return importPreview(await jsonResult(response));
}
export async function confirmImport(pending: ImportPending): Promise<ImportResult> {
  let response: Response;
  try {
    response = await fetch(`/api/transfers/imports/${encodeURIComponent(pending.importId)}/confirm`, {
      method: "POST", credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(30000),
      headers: { "Content-Type": "application/json", "X-Prevision-CSRF": csrfToken() }, body: JSON.stringify({ idempotencyKey: pending.idempotencyKey })
    });
  } catch { throw new TransferRequestError("A conexão foi interrompida antes da confirmação. A importação pode ter sido registrada.", 0, true); }
  const result = await jsonResult(response);
  if (!result || typeof result !== "object" || !("import" in result) || !("replayed" in result) || typeof result.replayed !== "boolean") {
    throw new TransferRequestError("O servidor respondeu sem confirmar o resultado da importação.", 0, true);
  }
  const completed = importPreview(result.import);
  if (completed.status !== "COMPLETED" || completed.createdCount !== completed.rowCount) throw new TransferRequestError("O servidor respondeu sem confirmar a conclusão do cadastro. Verifique o mesmo pedido.", 0, true);
  return { import: completed, replayed: result.replayed };
}
export async function previewReport(body: ReportPreviewInput, signal?: AbortSignal): Promise<ReportPreviewDTO> {
  const response = await fetch("/api/transfers/exports/preview", {
    method: "POST", credentials: "same-origin", cache: "no-store", signal: signal ?? AbortSignal.timeout(30000),
    headers: { "Content-Type": "application/json", "X-Prevision-CSRF": csrfToken() }, body: JSON.stringify(body)
  });
  const result = await jsonResult(response);
  const preview = result as ReportPreviewDTO | null;
  if (!preview || typeof preview !== "object" || typeof preview.id !== "string" || !uuid.test(preview.id) || !Array.isArray(preview.rows) || !Array.isArray(preview.columns)
    || !Number.isInteger(preview.rowCount) || preview.rowCount < 0 || preview.rowCount > 1000 || preview.rows.length !== preview.rowCount || !Array.isArray(preview.warnings)
    || typeof preview.title !== "string" || typeof preview.generatedAt !== "string" || typeof preview.expiresAt !== "string" || !preview.generatedBy
    || typeof preview.generatedBy.id !== "string" || !uuid.test(preview.generatedBy.id) || !preview.filters || typeof preview.filters !== "object") throw new TransferRequestError("Não foi possível apresentar a prévia completa do relatório.", 0);
  return preview;
}
export async function downloadTransfer(path: string, format: "csv" | "xlsx" | "pdf"): Promise<void> {
  const response = await fetch(path, { credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(60000) });
  if (!response.ok) { await jsonResult(response); return; }
  const expected = { csv: "text/csv", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", pdf: "application/pdf" }[format];
  if (!response.headers.get("content-type")?.toLowerCase().startsWith(expected)) throw new TransferRequestError("O servidor não retornou o arquivo esperado. Gere a prévia novamente e tente baixar.", 0);
  const content = await response.blob();
  const disposition = response.headers.get("content-disposition") ?? "";
  const match = disposition.match(/filename\*=UTF-8''([^;]+)|filename="([^"]+)"|filename=([^;]+)/i);
  let name = `prevision.${format}`;
  try { if (match) name = decodeURIComponent(match[1] ?? match[2] ?? match[3]).replace(/[\\/\u0000-\u001f\u007f]/g, "_"); } catch { /* use default */ }
  const url = URL.createObjectURL(content);
  const link = document.createElement("a"); link.href = url; link.download = name; document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
