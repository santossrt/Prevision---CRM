import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImportPreviewDTO, ReportKind } from "../../src/lib/transfers/types.ts";
import { confirmImport, downloadTransfer, importStorageKey, maximumImportBytes, previewReport, recoverStoredImport, TransferRequestError, uploadImport, validateImportFile, type ImportPending } from "../../src/components/transfers/transfers-api.ts";
import { allowedReports, buildReportFilters, initialReportForm, periodFilters } from "../../src/components/transfers/transfers-meta.ts";

const importId = "00000000-0000-4000-8000-000000000001";
const requestId = "00000000-0000-4000-8000-000000000002";
const preview: ImportPreviewDTO = {
  id: importId, fileName: "produtos.csv", format: "csv", status: "PREVIEW", createdAt: "2026-11-01T10:00:00.000Z", expiresAt: "2026-11-01T10:30:00.000Z",
  rowCount: 1, validCount: 1, errorCount: 0, createdCount: 0, canConfirm: true,
  columns: [{ key: "sku", label: "SKU" }, { key: "barcode", label: "Código de barras" }],
  rows: [{ rowNumber: 2, data: { sku: "PROD-01", barcode: "000123" }, errors: [] }], operationId: "00000000-0000-4000-8000-000000000003"
};
const pending: ImportPending = { importId, idempotencyKey: requestId, fileName: preview.fileName, rowCount: 1 };
const completed = { ...preview, status: "COMPLETED", canConfirm: false, createdCount: 1 } as const;

beforeEach(() => {
  vi.stubGlobal("document", { cookie: "other=ignored; prevision.csrf=csrf%20de%20teste" });
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("arquivo e recuperação da importação", () => {
  it.each([["produtos.csv", "csv"], ["PRODUTOS.XLSX", "xlsx"]] as const)("aceita extensão %s", (name, format) => {
    expect(validateImportFile({ name, size: 1 })).toBe(format);
    expect(validateImportFile({ name, size: maximumImportBytes })).toBe(format);
  });
  it.each([{ name: "produtos.xls", size: 1 }, { name: "produtos.xlsm", size: 1 }, { name: "produtos.csv.exe", size: 1 }, { name: "produtos.csv", size: 0 }, { name: "produtos.xlsx", size: maximumImportBytes + 1 }])("recusa arquivo fora dos limites: $name/$size", (file) => {
    expect(() => validateImportFile(file)).toThrow();
  });
  it("recupera somente identificadores e intenção, sem bytes ou campos desconhecidos", () => {
    expect(recoverStoredImport(JSON.stringify({ previewId: importId, pending, fileBytes: "não guardar", password: "não guardar" })))
      .toEqual({ previewId: importId, pending });
    expect(importStorageKey(importId)).not.toBe(importStorageKey(requestId));
  });
  it.each([
    "{}", "null", "not-json",
    JSON.stringify({ previewId: "outro" }),
    JSON.stringify({ previewId: importId, pending: { ...pending, importId: requestId } }),
    JSON.stringify({ previewId: importId, pending: { ...pending, idempotencyKey: "outra-chave" } }),
    JSON.stringify({ previewId: importId, pending: { ...pending, rowCount: 201 } }),
    JSON.stringify({ previewId: importId, pending: { ...pending, fileName: "" } })
  ])("recusa recuperação inválida", (raw) => { expect(() => recoverStoredImport(raw)).toThrow(); });
});

describe("envio e confirmação no navegador", () => {
  it("envia o arquivo por FormData com CSRF, sem forçar o boundary", async () => {
    const file = new File(["sku;codigo_barras\nPROD-01;000123"], "produtos.csv", { type: "text/csv" });
    vi.mocked(fetch).mockResolvedValue(Response.json(preview, { status: 201 }));
    const result = await uploadImport(file);
    expect(result.rows[0].data.barcode).toBe("000123");
    const [url, options] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("/api/transfers/imports/preview");
    expect(options).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store", headers: { "X-Prevision-CSRF": "csrf de teste" } });
    expect(new Headers(options?.headers).has("content-type")).toBe(false);
    expect(options?.body).toBeInstanceOf(FormData);
    const sent = (options?.body as FormData).get("file") as File;
    expect(sent.name).toBe(file.name);
    expect(await sent.text()).toBe(await file.text());
  });
  it("não envia um arquivo inválido", async () => {
    await expect(uploadImport(new File([], "vazio.csv"))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("mantém o mesmo corpo e chave ao repetir rede → 503 → replay", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError("falha de teste"))
      .mockResolvedValueOnce(Response.json({ message: "Indisponível." }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ import: completed, replayed: true }));
    await expect(confirmImport(pending)).rejects.toMatchObject({ uncertain: true });
    await expect(confirmImport(pending)).rejects.toMatchObject({ uncertain: true });
    expect(await confirmImport(pending)).toMatchObject({ import: { status: "COMPLETED", createdCount: 1 }, replayed: true });
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls).toHaveLength(3);
    for (const [url, options] of calls) {
      expect(url).toBe(`/api/transfers/imports/${importId}/confirm`);
      expect(options).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store", body: JSON.stringify({ idempotencyKey: requestId }) });
    }
  });
  it("só reconhece expiração resolvida pelo código específico do POST", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ message: "Prévia expirada.", code: "IMPORT_PREVIEW_EXPIRED" }, { status: 409 }));
    await expect(confirmImport(pending)).rejects.toMatchObject({ status: 409, uncertain: false, code: "IMPORT_PREVIEW_EXPIRED" });
  });
  it.each([400, 401, 403, 409, 429])("classifica a rejeição HTTP %i", async (status) => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ message: "Pedido recusado." }, { status }));
    await expect(confirmImport(pending)).rejects.toMatchObject({ status, uncertain: false });
  });
  it.each([
    () => Response.json({}),
    () => Response.json({ import: preview, replayed: false }),
    () => Response.json({ import: { id: importId, rows: [] }, replayed: false }),
    () => new Response("sem JSON", { status: 200 })
  ])("trata sucesso incompleto como incerto, mantendo a intenção recuperável", async (response) => {
    vi.mocked(fetch).mockResolvedValue(response());
    await expect(confirmImport(pending)).rejects.toMatchObject({ uncertain: true });
  });
});

describe("relatórios autorizados e filtros", () => {
  it("oferece somente fontes permitidas junto de reports.read", () => {
    expect(allowedReports(["audit.read"])).toEqual([]);
    expect(allowedReports(["reports.read", "audit.read"])).toEqual(["audit"]);
    expect(allowedReports(["reports.read", "catalog.read"])).toEqual(["products"]);
    const stock = allowedReports(["reports.read", "stock.read"]);
    expect(stock).toHaveLength(11); expect(stock).toEqual(expect.arrayContaining(["abc", "replenishment", "indicators"])); expect(stock).not.toContain("audit"); expect(stock).not.toContain("products");
  });
  const filled = { ...initialReportForm, search: " PROD ", productStatus: "active", categoryId: importId, supplierId: requestId, stock: "low", productId: requestId,
    type: "EXIT", inventoryStatus: "COMPLETED", inventoryId: importId, from: "2026-11-01", to: "2026-11-02", actorId: importId, module: "STOCK", action: "UPDATE", entityType: "Product", entityId: requestId, operationId: importId };
  it.each(["low_stock", "empty_stock"] as ReportKind[])("não envia stock irrelevante ao relatório fixo %s", (kind) => {
    expect(buildReportFilters(kind, filled)).toEqual({ search: "PROD", status: "active", categoryId: importId, supplierId: requestId });
  });
  it("não envia filtros de outro módulo", () => {
    expect(buildReportFilters("products", filled)).toEqual({ search: "PROD", status: "active", categoryId: importId, supplierId: requestId, stock: "low" });
    const inventories = buildReportFilters("inventories", filled);
    expect(inventories).toMatchObject({ search: "PROD", status: "COMPLETED", inventoryId: importId });
    expect(inventories).not.toHaveProperty("type"); expect(inventories).not.toHaveProperty("categoryId");
    const audit = buildReportFilters("audit", filled);
    expect(audit).toHaveProperty("actorId", importId); expect(audit).not.toHaveProperty("status"); expect(audit).not.toHaveProperty("stock");
  });
  it("exporta análises com dias civis e critérios sem misturar filtros de cadastro ou auditoria", () => {
    expect(buildReportFilters("abc", filled)).toEqual({ from: "2026-11-01", to: "2026-11-02", search: "PROD", status: "active", thresholdA: "80.00", thresholdB: "95.00", horizonDays: "30" });
    expect(buildReportFilters("replenishment", filled)).toEqual(buildReportFilters("abc", filled));
    expect(buildReportFilters("indicators", filled)).toEqual({ from: "2026-11-01", to: "2026-11-02" });
    expect(() => buildReportFilters("abc", { ...filled, to: "" })).toThrow("duas datas");
  });
  it("aceita vírgula decimal nos limites ABC do formulário geral", () => {
    expect(buildReportFilters("abc", { ...filled, thresholdA: " 75,5 ", thresholdB: " 92,25 " })).toMatchObject({ thresholdA: "75.5", thresholdB: "92.25" });
    expect(buildReportFilters("replenishment", { ...filled, thresholdA: "75,5" })).toHaveProperty("thresholdA", "75.5");
  });
  it("preserva tipo apenas no histórico completo e valida o período", () => {
    expect(buildReportFilters("movements", filled)).toHaveProperty("type", "EXIT");
    expect(buildReportFilters("entries", filled)).not.toHaveProperty("type");
    expect(() => periodFilters("2026-11-02", "2026-11-01")).toThrow("data inicial");
    expect(() => periodFilters("data inválida", "")).toThrow("período válido");
    const period = periodFilters("2026-11-01", "2026-11-01");
    expect(new Date(period.from).getHours()).toBe(0); expect(new Date(period.to).getHours()).toBe(23); expect(new Date(period.to).getMilliseconds()).toBe(999);
  });
  it("envia a prévia de relatório com os filtros fornecidos e proteção CSRF", async () => {
    const result = { id: importId, kind: "stock", title: "Estoque atual", rows: [], columns: [], rowCount: 0, warnings: [], filters: {}, generatedAt: preview.createdAt, expiresAt: preview.expiresAt, generatedBy: { id: requestId, name: "Responsável" }, operationId: preview.operationId };
    vi.mocked(fetch).mockResolvedValue(Response.json(result));
    expect(await previewReport({ kind: "stock", filters: { search: "000123" } })).toEqual(result);
    expect(vi.mocked(fetch).mock.calls[0]).toMatchObject(["/api/transfers/exports/preview", { method: "POST", body: JSON.stringify({ kind: "stock", filters: { search: "000123" } }), credentials: "same-origin" }]);
  });
});

describe("download autenticado", () => {
  it("mostra o erro da API antes de tentar salvar um arquivo", async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ message: "Seu acesso mudou." }, { status: 403 }));
    await expect(downloadTransfer("/api/transfers/exports/exemplo/download?format=pdf", "pdf")).rejects.toBeInstanceOf(TransferRequestError);
  });
  it("não salva uma página HTML como PDF", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("<html>login</html>", { headers: { "content-type": "text/html" } }));
    await expect(downloadTransfer("/api/transfers/exports/exemplo/download?format=pdf", "pdf")).rejects.toThrow("arquivo esperado");
  });
  it("salva o arquivo retornado e libera a URL temporária", async () => {
    vi.useFakeTimers();
    const click = vi.fn(); const remove = vi.fn();
    const link = { href: "", download: "", click, remove };
    vi.stubGlobal("document", { createElement: vi.fn(() => link), body: { appendChild: vi.fn() } });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:prevision-test");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    vi.mocked(fetch).mockResolvedValue(new Response("%PDF-test", { headers: { "content-type": "application/pdf", "content-disposition": "attachment; filename*=UTF-8''prevision-estoque.pdf" } }));
    await downloadTransfer("/api/transfers/exports/exemplo/download?format=pdf", "pdf");
    expect(click).toHaveBeenCalledOnce(); expect(remove).toHaveBeenCalledOnce(); expect(link.download).toBe("prevision-estoque.pdf");
    expect(vi.mocked(fetch).mock.calls[0][1]).toMatchObject({ credentials: "same-origin", cache: "no-store" });
    vi.runAllTimers(); expect(revoke).toHaveBeenCalledWith("blob:prevision-test");
  });
});
