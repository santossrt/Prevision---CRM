import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Prisma } from "../../generated/prisma/client.ts";
import type { ReportKind, ReportPreviewDTO } from "../../lib/transfers/types.ts";
import type { Principal } from "../auth/identity.ts";
import { assertActorInTransaction, assertPermission } from "../authorization/guard.ts";
import { getDatabase } from "../database/client.ts";
import { verifyDatabaseIdentity } from "../database/identity.ts";
import { ApplicationError } from "../errors/application-error.ts";
import { loadReportData } from "./export-data.ts";
import { parseReportPreview, reportId, reportKinds, sourcePermission } from "./export-validation.ts";
import { renderReportPdf, renderReportXlsx } from "./export-render.ts";
import { withTransferResource } from "./resource-limit.ts";
import { prepareTransferRetention, reserveTransferPayload } from "./retention.ts";

const storedSnapshot = z.object({
  id: z.string().uuid(), kind: z.enum(reportKinds), title: z.string().max(160), generatedAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
  generatedBy: z.object({ id: z.string().uuid(), name: z.string().max(1000).nullable() }).strict(),
  filters: z.record(z.string().max(80), z.string().max(160)), columns: z.array(z.object({ key: z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/), label: z.string().max(100) }).strict()).min(1).max(32),
  rows: z.array(z.record(z.string(), z.string().max(30000).nullable())).max(1000), rowCount: z.number().int().min(0).max(1000), operationId: z.string().uuid(), warnings: z.array(z.string().max(1000)).max(12)
}).strict();
const notFound = () => new ApplicationError("NOT_FOUND", "Prévia de relatório não encontrada.");
function permissions(actor: Principal, kind: ReportKind) {
  assertPermission(actor, "reports.read"); assertPermission(actor, sourcePermission(kind));
}
async function currentPermissions(tx: Prisma.TransactionClient, actor: Principal, kind: ReportKind) {
  await assertActorInTransaction(tx, actor, "reports.read");
  await assertActorInTransaction(tx, actor, sourcePermission(kind));
}
const displayText = (value: string) => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);

export async function createReportPreview(actor: Principal, body: unknown): Promise<ReportPreviewDTO> {
  const input = parseReportPreview(body);
  permissions(actor, input.kind);
  await verifyDatabaseIdentity();
  await prepareTransferRetention(actor, ["reports.read", sourcePermission(input.kind)]);
  return getDatabase().$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(2026103002)`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(2026103003)`;
    await currentPermissions(tx, actor, input.kind);
    const data = await loadReportData(tx, input.kind, input.filters);
    let controls = false;
    const rows = data.rows.map((record) => Object.fromEntries(data.columns.map(({ key }) => {
      const original = record[key]; const value = original === null ? null : displayText(original);
      if (original !== value) controls = true;
      return [key, value];
    })));
    const now = new Date(); const expires = new Date(now.getTime() + 30 * 60 * 1000);
    const snapshot: ReportPreviewDTO = {
      id: randomUUID(), kind: input.kind, title: data.title, generatedAt: now.toISOString(), expiresAt: expires.toISOString(),
      generatedBy: { id: actor.id, name: actor.name === null ? null : displayText(actor.name) }, filters: input.filters, columns: data.columns,
      rows, rowCount: rows.length, operationId: randomUUID(), warnings: [...data.warnings, ...(controls ? ["Caracteres de controle foram representados como códigos Unicode visíveis para preservar a legibilidade e a validade dos arquivos."] : [])]
    };
    // Validate the exact representation subsequently used for both file types.
    if (Buffer.byteLength(JSON.stringify(snapshot)) > 8 * 1024 * 1024) throw new ApplicationError("VALIDATION", "O conteúdo do relatório é muito grande. Refine os filtros ou divida o período.");
    storedSnapshot.parse(snapshot);
    await reserveTransferPayload(tx, actor.id, snapshot as unknown as Prisma.InputJsonObject);
    await tx.reportExport.create({ data: {
      id: snapshot.id, ownerId: actor.id, kind: input.kind, payload: snapshot as unknown as Prisma.InputJsonObject,
      rowCount: rows.length, createdAt: now, expiresAt: expires, operationId: snapshot.operationId
    } });
    await tx.auditEvent.create({ data: {
      actorId: actor.id, action: "EXPORT", module: "TRANSFERS", entityType: "ReportExport", entityId: snapshot.id,
      operationId: snapshot.operationId, origin: "transfers.export.preview", newValues: { reportKind: input.kind, rowCount: rows.length, exportId: snapshot.id }
    } });
    return snapshot;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5000, timeout: 30000 });
}

async function loadOwnedReport(tx: Prisma.TransactionClient, actor: Principal, id: string): Promise<ReportPreviewDTO> {
  const record = await tx.reportExport.findFirst({ where: { id, ownerId: actor.id } });
  if (!record) throw notFound();
  const kind = z.enum(reportKinds).safeParse(record.kind);
  if (!kind.success) throw new ApplicationError("UNAVAILABLE", "O formato desta prévia precisa ser verificado.");
  permissions(actor, kind.data);
  await currentPermissions(tx, actor, kind.data);
  if (record.expiresAt.getTime() <= Date.now()) throw new ApplicationError("CONFLICT", "A prévia do relatório expirou. Gere uma nova prévia antes de baixar.");
  const result = storedSnapshot.safeParse(record.payload);
  if (!result.success || result.data.id !== record.id || result.data.kind !== record.kind || result.data.generatedBy.id !== actor.id || result.data.rowCount !== result.data.rows.length) {
    throw new ApplicationError("UNAVAILABLE", "Os dados desta prévia precisam ser verificados.");
  }
  const keys = new Set(result.data.columns.map(({ key }) => key));
  if (keys.size !== result.data.columns.length || result.data.rows.some((row) => Object.keys(row).length !== keys.size || Object.keys(row).some((key) => !keys.has(key)))) {
    throw new ApplicationError("UNAVAILABLE", "Os dados desta prévia precisam ser verificados.");
  }
  return result.data;
}
export async function getReportPreview(actor: Principal, value: string): Promise<ReportPreviewDTO> {
  assertPermission(actor, "reports.read"); const id = reportId(value);
  await verifyDatabaseIdentity();
  return getDatabase().$transaction((tx) => loadOwnedReport(tx, actor, id), { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 5000, timeout: 15000 });
}
export async function downloadReport(actor: Principal, value: string, format: "xlsx" | "pdf"): Promise<{ buffer: Buffer; contentType: string; fileName: string }> {
  assertPermission(actor, "reports.read"); const id = reportId(value);
  await verifyDatabaseIdentity();
  const snapshot = await getDatabase().$transaction(async (tx) => {
    const report = await loadOwnedReport(tx, actor, id);
    await tx.auditEvent.create({ data: {
      actorId: actor.id, action: "EXPORT", module: "TRANSFERS", entityType: "ReportExport", entityId: report.id,
      operationId: report.operationId, origin: "transfers.export.download", newValues: { reportKind: report.kind, rowCount: report.rowCount, exportId: report.id, format }
    } });
    return report;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 5000, timeout: 15000 });
  const buffer = await withTransferResource(() => format === "xlsx" ? renderReportXlsx(snapshot) : renderReportPdf(snapshot));
  return { buffer, contentType: format === "xlsx" ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "application/pdf", fileName: `prevision-${snapshot.kind}-${snapshot.generatedAt.slice(0, 10)}.${format}` };
}
