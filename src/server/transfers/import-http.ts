import "server-only";
import { requireApiIdentity } from "../auth/identity.ts";
import { assertPermission } from "../authorization/guard.ts";
import { ApplicationError } from "../errors/application-error.ts";
import { assertCsrf, assertTrustedHost, errorResponse, limitRequest } from "../security/http.ts";
import type { ImportFormat } from "./import-parser.ts";

export const importHeaders = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
export async function importActor(request: Request, mutation = false) {
  if (mutation) assertCsrf(request); else assertTrustedHost(request);
  const actor = await requireApiIdentity(request);
  assertPermission(actor, "catalog.read"); assertPermission(actor, "catalog.write");
  await limitRequest(request, mutation ? "product-import-write" : "product-import-read", mutation ? 20 : 120, mutation ? 900 : 60, actor.id);
  return actor;
}
export async function readImportUpload(request: Request): Promise<{ fileName: string; buffer: Buffer; format: ImportFormat }> {
  const invalid = () => new ApplicationError("VALIDATION", "Envie somente um arquivo CSV ou XLSX de até 2 MiB, utilizando o modelo de produtos.");
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("multipart/form-data;")) throw invalid();
  if (Number(request.headers.get("content-length") ?? 0) > 3 * 1024 * 1024 || !request.body) throw invalid();
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 3 * 1024 * 1024) { void reader.cancel().catch(() => {}); throw invalid(); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  let form: FormData;
  try { form = await new Response(new Uint8Array(Buffer.concat(chunks)), { headers: { "Content-Type": request.headers.get("content-type")! } }).formData(); }
  catch { throw invalid(); }
  const entries = [...form.entries()];
  if (entries.length !== 1 || entries[0][0] !== "file" || typeof entries[0][1] === "string") throw invalid();
  const file = entries[0][1];
  if (!file.size || file.size > 2 * 1024 * 1024) throw invalid();
  const cleanName = file.name.split(/[\\/]/u).at(-1)!.replace(/[\u0000-\u001f\u007f]/gu, "_");
  const suffix = cleanName.toLowerCase().split(".").at(-1);
  if (!cleanName || suffix !== "csv" && suffix !== "xlsx") throw invalid();
  const fileName = cleanName.length <= 180 ? cleanName : `${cleanName.slice(0, 179 - suffix.length)}.${suffix}`;
  return { fileName, format: suffix, buffer: Buffer.from(await file.arrayBuffer()) };
}
export { errorResponse };
