import { beforeEach, describe, expect, it, vi } from "vitest";
import { previewProductImport, confirmProductImport, getProductImport, ImportPreviewExpiredError } from "../../src/server/transfers/import-service.ts";
import { parseImportFile } from "../../src/server/transfers/import-parser.ts";
import { createProductInTransaction } from "../../src/server/catalog/service.ts";
import { assertActorInTransaction } from "../../src/server/authorization/guard.ts";
import type { Principal } from "../../src/server/auth/identity.ts";
import { prepareTransferRetention, reserveTransferPayload } from "../../src/server/transfers/retention.ts";
import { ApplicationError } from "../../src/server/errors/application-error.ts";

const state = vi.hoisted(() => ({ database: {} as Record<string, unknown> }));
vi.mock("../../src/server/database/client.ts", () => ({ getDatabase: () => state.database }));
vi.mock("../../src/server/database/identity.ts", () => ({ verifyDatabaseIdentity: vi.fn() }));
vi.mock("../../src/server/transfers/import-parser.ts", () => ({ parseImportFile: vi.fn() }));
vi.mock("../../src/server/transfers/retention.ts", () => ({ prepareTransferRetention: vi.fn(), reserveTransferPayload: vi.fn() }));
vi.mock("../../src/server/catalog/service.ts", () => ({ createProductInTransaction: vi.fn() }));
vi.mock("../../src/server/authorization/guard.ts", async (original) => ({ ...await original<typeof import("../../src/server/authorization/guard.ts")>(), assertActorInTransaction: vi.fn() }));
const ownerId = "00000000-0000-4000-8000-000000000001";
const categoryId = "00000000-0000-4000-8000-000000000002";
const importId = "00000000-0000-4000-8000-000000000003";
const key = "00000000-0000-4000-8000-000000000004";
function fixture() {
  const actor: Principal = { id: ownerId, sessionId: key, sessionVersion: 1, name: "Responsável", email: "owner@example.invalid", role: "ADMINISTRATOR", permissions: ["catalog.read", "catalog.write"], hasPassword: true, googleLinked: false, googleAccessAllowed: false };
  let record: Record<string, unknown> | null = null;
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(1), $queryRaw: vi.fn().mockResolvedValue([{ id: importId }]),
    category: { findMany: vi.fn().mockResolvedValue([{ id: categoryId, name: "Casa", version: 0, isActive: true }]), findUnique: vi.fn().mockResolvedValue({ version: 0, isActive: true }) },
    supplier: { findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn() },
    product: { findMany: vi.fn().mockResolvedValue([]) },
    productImport: {
      findFirst: vi.fn().mockResolvedValue(null), findUnique: vi.fn(async () => record),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => record = { id: importId, status: "PREVIEW", createdCount: 0, completedAt: null, confirmationKey: null, ...data }),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => record = { ...record!, ...data })
    }, auditEvent: { create: vi.fn().mockResolvedValue({}) }
  };
  const db = { ...tx, $transaction: vi.fn(async (work: (transaction: typeof tx) => unknown) => work(tx)) };
  state.database = db;
  return { actor, tx, db, record: () => record! };
}
beforeEach(() => {
  vi.mocked(assertActorInTransaction).mockReset().mockResolvedValue(undefined);
  vi.mocked(createProductInTransaction).mockReset().mockResolvedValue({} as never);
  vi.mocked(parseImportFile).mockReset().mockResolvedValue([{ rowNumber: 2, values: { nome: " Produto ", sku: " ab-1 ", categoria: "Casa", codigo_barras: "000123", custo_aquisicao: "1,2500" }, issues: [] }]);
  vi.mocked(prepareTransferRetention).mockReset().mockResolvedValue(undefined);
  vi.mocked(reserveTransferPayload).mockReset().mockResolvedValue(undefined);
});
describe("prévia e confirmação de produtos", () => {
  it.each(["catalog.read", "catalog.write"])("exige %s antes de ler o arquivo", async (permission) => {
    const { actor, db } = fixture(); actor.permissions = actor.permissions.filter((item) => item !== permission);
    await expect(previewProductImport(actor, "teste.csv", Buffer.from("private-file"), "csv")).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(parseImportFile).not.toHaveBeenCalled(); expect(db.$transaction).not.toHaveBeenCalled();
  });
  it("mostra dados canônicos, mantém zeros e guarda somente produto sem quantidade", async () => {
    const { actor, tx } = fixture();
    const preview = await previewProductImport(actor, "teste.csv", Buffer.from("private-file"), "csv");
    expect(preview).toMatchObject({ rowCount: 1, errorCount: 0, validCount: 1, canConfirm: true, status: "PREVIEW" });
    expect(preview.rows[0].data).toMatchObject({ sku: "AB-1", barcode: "000123", acquisitionCost: "1.2500", minimumStock: "0.0000" });
    const stored = tx.productImport.create.mock.calls[0][0].data;
    expect(JSON.stringify(stored)).not.toContain("private-file");
    expect(preview).not.toHaveProperty("payload"); expect(preview.rows[0]).not.toHaveProperty("input");
    expect(createProductInTransaction).not.toHaveBeenCalled();
  });
  it("expõe erros por linha sem criar referências ou produtos", async () => {
    const { actor, tx } = fixture(); tx.category.findMany.mockResolvedValue([]);
    const preview = await previewProductImport(actor, "teste.csv", Buffer.from("x"), "csv");
    expect(preview).toMatchObject({ errorCount: 1, validCount: 0, canConfirm: false });
    expect(preview.rows[0].errors.some((issue) => issue.column === "category")).toBe(true);
    expect(createProductInTransaction).not.toHaveBeenCalled();
  });
  it("marca todas as linhas duplicadas e também códigos existentes", async () => {
    const { actor, tx } = fixture();
    const row = { rowNumber: 2, values: { nome: "P", sku: "AA", categoria: "Casa", codigo_barras: "0001" }, issues: [] };
    vi.mocked(parseImportFile).mockResolvedValue([row, { ...row, rowNumber: 3 }]);
    tx.product.findMany.mockResolvedValue([{ sku: "AA", barcode: "0001" }] as never);
    const preview = await previewProductImport(actor, "teste.csv", Buffer.from("x"), "csv");
    expect(preview.errorCount).toBe(2);
    expect(preview.rows.every((item) => item.errors.filter((issue) => issue.column === "sku").length === 2)).toBe(true);
  });
  it("revalida autorização depois de aguardar os locks", async () => {
    const { actor, tx } = fixture(); vi.mocked(assertActorInTransaction).mockRejectedValueOnce(new Error("revoked"));
    await expect(previewProductImport(actor, "teste.csv", Buffer.from("x"), "csv")).rejects.toThrow("revoked");
    expect(tx.productImport.create).not.toHaveBeenCalled();
  });
  it("recusa quota sem criar importação e preserva a limpeza já preparada", async () => {
    const { actor, tx } = fixture();
    vi.mocked(reserveTransferPayload).mockRejectedValueOnce(new ApplicationError("VALIDATION", "Limite de prévias."));
    await expect(previewProductImport(actor, "teste.csv", Buffer.from("x"), "csv")).rejects.toMatchObject({ code: "VALIDATION" });
    expect(prepareTransferRetention).toHaveBeenCalledWith(actor, ["catalog.read", "catalog.write"]);
    expect(tx.productImport.create).not.toHaveBeenCalled(); expect(tx.auditEvent.create).not.toHaveBeenCalled();
  });
  it("usa a criação transacional compartilhada e retorna replay sem repetir efeito", async () => {
    const { actor, tx } = fixture(); await previewProductImport(actor, "teste.csv", Buffer.from("x"), "csv");
    const result = await confirmProductImport(actor, importId, { idempotencyKey: key });
    expect(result).toMatchObject({ replayed: false, import: { status: "COMPLETED", createdCount: 1, canConfirm: false } });
    expect(createProductInTransaction).toHaveBeenCalledOnce();
    expect(vi.mocked(createProductInTransaction).mock.calls[0][2]).not.toHaveProperty("quantity");
    expect((await confirmProductImport(actor, importId, { idempotencyKey: key })).replayed).toBe(true);
    expect(createProductInTransaction).toHaveBeenCalledOnce();
    expect(tx.productImport.update).toHaveBeenCalledOnce();
  });
  it("recusa confirmação expirada antes de criar qualquer produto", async () => {
    const fixtureState = fixture(); await previewProductImport(fixtureState.actor, "teste.csv", Buffer.from("x"), "csv");
    fixtureState.record().expiresAt = new Date(0);
    await expect(confirmProductImport(fixtureState.actor, importId, { idempotencyKey: key })).rejects.toBeInstanceOf(ImportPreviewExpiredError);
    expect(createProductInTransaction).not.toHaveBeenCalled();
  });
  it("consulta de prévia expirada não tenta expor o payload já removido", async () => {
    const state = fixture(); await previewProductImport(state.actor, "teste.csv", Buffer.from("x"), "csv");
    state.record().expiresAt = new Date(0); state.record().payload = {};
    state.tx.productImport.findFirst.mockResolvedValueOnce(state.record());
    await expect(getProductImport(state.actor, importId)).rejects.toBeInstanceOf(ImportPreviewExpiredError);
  });
  it("histórico concluído continua legível após o prazo da prévia", async () => {
    const state = fixture(); await previewProductImport(state.actor, "teste.csv", Buffer.from("x"), "csv");
    await confirmProductImport(state.actor, importId, { idempotencyKey: key });
    state.record().expiresAt = new Date(0); state.tx.productImport.findFirst.mockResolvedValueOnce(state.record());
    expect(await getProductImport(state.actor, importId)).toMatchObject({ status: "COMPLETED", createdCount: 1 });
  });
  it("recusa referência alterada e bloqueia lote inválido", async () => {
    const state = fixture(); await previewProductImport(state.actor, "teste.csv", Buffer.from("x"), "csv");
    state.tx.category.findUnique.mockResolvedValue({ version: 1, isActive: true });
    await expect(confirmProductImport(state.actor, importId, { idempotencyKey: key })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(createProductInTransaction).not.toHaveBeenCalled();
    state.record().errorCount = 1;
    await expect(confirmProductImport(state.actor, importId, { idempotencyKey: key })).rejects.toMatchObject({ code: "VALIDATION" });
  });
});
