import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Principal } from "../../src/server/auth/identity.ts";
import type { ReportPreviewDTO } from "../../src/lib/transfers/types.ts";
import { ApplicationError } from "../../src/server/errors/application-error.ts";
import { createReportPreview, downloadReport, getReportPreview } from "../../src/server/transfers/export-service.ts";
import { loadReportData } from "../../src/server/transfers/export-data.ts";
import { renderReportPdf, renderReportXlsx } from "../../src/server/transfers/export-render.ts";
import { prepareTransferRetention, reserveTransferPayload } from "../../src/server/transfers/retention.ts";

const state = vi.hoisted(() => ({ database: {} as Record<string, unknown>, validate: vi.fn() }));
vi.mock("../../src/server/database/client.ts", () => ({ getDatabase: () => state.database }));
vi.mock("../../src/server/database/identity.ts", () => ({ verifyDatabaseIdentity: vi.fn() }));
vi.mock("../../src/server/authorization/guard.ts", async (original) => ({ ...await original<typeof import("../../src/server/authorization/guard.ts")>(), assertActorInTransaction: state.validate }));
vi.mock("../../src/server/transfers/export-data.ts", () => ({ loadReportData: vi.fn() }));
vi.mock("../../src/server/transfers/export-render.ts", () => ({ renderReportPdf: vi.fn(), renderReportXlsx: vi.fn() }));
vi.mock("../../src/server/transfers/retention.ts", () => ({ prepareTransferRetention: vi.fn(), reserveTransferPayload: vi.fn() }));

const actorId = "00000000-0000-4000-8000-000000000001";
const reportId = "00000000-0000-4000-8000-000000000002";
const operationId = "00000000-0000-4000-8000-000000000003";
const actor: Principal = { id: actorId, name: "Responsável", email: "user@example.invalid", role: "ADMINISTRATOR", sessionId: operationId, sessionVersion: 0, permissions: ["reports.read", "stock.read", "catalog.read", "audit.read"], googleLinked: false, hasPassword: true, googleAccessAllowed: false };
function snapshot(): ReportPreviewDTO {
  return { id: reportId, kind: "products", title: "Produtos cadastrados", generatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 1800000).toISOString(), generatedBy: { id: actorId, name: actor.name }, filters: { status: "all", stock: "all" }, columns: [{ key: "name", label: "Produto" }], rows: [{ name: "Valor congelado" }], rowCount: 1, operationId, warnings: [] };
}
function fixture() {
  const payload = snapshot();
  const record = { id: reportId, ownerId: actorId, kind: payload.kind, payload, expiresAt: new Date(payload.expiresAt), operationId };
  const tx = { $executeRaw: vi.fn().mockResolvedValue(0), reportExport: { create: vi.fn().mockResolvedValue({ id: reportId }), findFirst: vi.fn().mockResolvedValue(record) }, auditEvent: { create: vi.fn().mockResolvedValue({}) } };
  const database = { ...tx, $transaction: vi.fn(async (work: (transaction: typeof tx) => unknown, _options?: unknown) => work(tx)) };
  state.database = database;
  return { tx, database, record, payload };
}
beforeEach(() => {
  state.validate.mockReset().mockResolvedValue(undefined);
  vi.mocked(loadReportData).mockReset().mockResolvedValue({ title: "Produtos cadastrados", columns: [{ key: "name", label: "Produto" }], rows: [{ name: "Produto real" }], warnings: [] });
  vi.mocked(renderReportXlsx).mockReset().mockResolvedValue(Buffer.from("xlsx-test"));
  vi.mocked(renderReportPdf).mockReset().mockResolvedValue(Buffer.from("pdf-test"));
  vi.mocked(prepareTransferRetention).mockReset().mockResolvedValue(undefined);
  vi.mocked(reserveTransferPayload).mockReset().mockResolvedValue(undefined);
});

describe("prévia privada e congelada de relatório", () => {
  it.each([
    { kind: "products", permissions: ["reports.read"] }, { kind: "audit", permissions: ["reports.read", "stock.read"] },
    { kind: "stock", permissions: ["stock.read"] }
  ])("exige permissão de relatórios e da fonte", async ({ kind, permissions }) => {
    const { database } = fixture();
    await expect(createReportPreview({ ...actor, permissions }, { kind, filters: {} })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(database.$transaction).not.toHaveBeenCalled();
  });
  it("revalida ambas permissões e sessão dentro da transação", async () => {
    const { tx } = fixture();
    state.validate.mockRejectedValue(new ApplicationError("UNAUTHORIZED", "Entre novamente."));
    await expect(createReportPreview(actor, { kind: "products", filters: {} })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(loadReportData).not.toHaveBeenCalled(); expect(tx.reportExport.create).not.toHaveBeenCalled();
  });
  it("armazena a representação da prévia e audita apenas metadados", async () => {
    const { tx, database } = fixture();
    const preview = await createReportPreview(actor, { kind: "products", filters: {} });
    expect(preview.rows).toEqual([{ name: "Produto real" }]);
    expect(state.validate.mock.calls.map((call) => call[2])).toEqual(["reports.read", "catalog.read"]);
    expect(tx.reportExport.create.mock.calls[0][0].data.payload).toEqual(preview);
    expect(database.$transaction.mock.calls[0][1]).toMatchObject({ isolationLevel: "ReadCommitted" });
    expect(prepareTransferRetention).toHaveBeenCalledWith(actor, ["reports.read", "catalog.read"]);
    expect(reserveTransferPayload).toHaveBeenCalledWith(tx, actor.id, preview);
    const audit = tx.auditEvent.create.mock.calls[0][0].data;
    expect(audit.action).toBe("EXPORT"); expect(audit.operationId).toBe(preview.operationId);
    expect(JSON.stringify(audit)).not.toContain("Produto real"); expect(JSON.stringify(audit)).not.toContain("user@example.invalid");
    expect(new Date(preview.expiresAt).getTime() - new Date(preview.generatedAt).getTime()).toBe(1800000);
  });
  it("representa controles de texto de forma visível antes de congelar", async () => {
    fixture(); vi.mocked(loadReportData).mockResolvedValueOnce({ title: "Produtos", columns: [{ key: "name", label: "Produto" }], rows: [{ name: "A\u0001B" }], warnings: [] });
    const preview = await createReportPreview(actor, { kind: "products", filters: {} });
    expect(preview.rows[0].name).toBe("A\\u0001B"); expect(preview.warnings.join(" ")).toContain("controle");
  });
  it("recusa quota antes de persistir o snapshot ou a auditoria", async () => {
    const { tx } = fixture();
    vi.mocked(reserveTransferPayload).mockRejectedValueOnce(new ApplicationError("VALIDATION", "Limite de prévias."));
    await expect(createReportPreview(actor, { kind: "products", filters: {} })).rejects.toMatchObject({ code: "VALIDATION" });
    expect(prepareTransferRetention).toHaveBeenCalledOnce();
    expect(tx.reportExport.create).not.toHaveBeenCalled();
    expect(tx.auditEvent.create).not.toHaveBeenCalled();
  });
  it("prévias analíticas revalidam acesso depois dos locks, sem snapshot anterior à espera", async () => {
    const { tx, database } = fixture();
    const result = await createReportPreview(actor, { kind: "abc", filters: { from: "2026-10-01", to: "2026-10-30" } });
    expect(result.kind).toBe("abc"); expect(result.filters.thresholdA).toBe("80.00");
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
    expect(database.$transaction.mock.calls[0][1]).toMatchObject({ isolationLevel: "ReadCommitted" });
    expect(state.validate.mock.calls.map((call) => call[2])).toEqual(["reports.read", "stock.read"]);
    expect(tx.$executeRaw.mock.invocationCallOrder[1]).toBeLessThan(state.validate.mock.invocationCallOrder[0]);
  });
  it("não lê a fonte novamente após congelar", async () => {
    const { tx, payload } = fixture();
    expect(await getReportPreview(actor, reportId)).toEqual(payload);
    expect(loadReportData).not.toHaveBeenCalled();
    expect(tx.reportExport.findFirst).toHaveBeenCalledWith({ where: { id: reportId, ownerId: actorId } });
  });
  it("não revela prévia de outro usuário", async () => {
    const { tx } = fixture(); tx.reportExport.findFirst.mockResolvedValueOnce(null);
    await expect(getReportPreview(actor, reportId)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("rejeita expiração e não inicia geração", async () => {
    const { record, tx } = fixture(); record.expiresAt = new Date(0);
    await expect(downloadReport(actor, reportId, "pdf")).rejects.toMatchObject({ code: "CONFLICT" });
    expect(tx.auditEvent.create).not.toHaveBeenCalled(); expect(renderReportPdf).not.toHaveBeenCalled();
  });
  it("recusa dados incoerentes, inclusive campos extras não declarados", async () => {
    const { payload } = fixture(); payload.rows[0].secret = "private";
    await expect(getReportPreview(actor, reportId)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });
  it("downloads verificam as permissões atuais antes de gerar ou auditar", async () => {
    const { tx } = fixture();
    state.validate.mockImplementation(async (_tx, _actor, permission) => { if (permission === "catalog.read") throw new ApplicationError("FORBIDDEN", "Sem acesso."); });
    await expect(downloadReport(actor, reportId, "xlsx")).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(renderReportXlsx).not.toHaveBeenCalled(); expect(tx.auditEvent.create).not.toHaveBeenCalled();
  });
  it("falha na auditoria impede entrega do arquivo", async () => {
    const { tx } = fixture(); tx.auditEvent.create.mockRejectedValueOnce(new Error("private database detail"));
    await expect(downloadReport(actor, reportId, "pdf")).rejects.toThrow();
    expect(renderReportPdf).not.toHaveBeenCalled();
  });
  it.each(["xlsx", "pdf"] as const)("download %s usa o snapshot original e nomes de arquivo fixos", async (format) => {
    const { payload } = fixture();
    const result = await downloadReport(actor, reportId, format);
    expect(format === "xlsx" ? renderReportXlsx : renderReportPdf).toHaveBeenCalledWith(payload);
    expect(result.fileName).toMatch(/^prevision-products-\d{4}-\d{2}-\d{2}\.(xlsx|pdf)$/);
    expect(loadReportData).not.toHaveBeenCalled();
  });
});
