import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import type { ReportPreviewDTO } from "../../src/lib/transfers/types.ts";
import { downloadFormat, parseReportPreview, sourcePermission } from "../../src/server/transfers/export-validation.ts";
import { buildReportPdfDefinition, renderReportPdf, renderReportXlsx } from "../../src/server/transfers/export-render.ts";

const report: ReportPreviewDTO = {
  id: "00000000-0000-4000-8000-000000000001", kind: "products", title: "Produtos cadastrados", generatedAt: "2026-11-01T12:00:00.000Z", expiresAt: "2026-11-01T12:30:00.000Z",
  generatedBy: { id: "00000000-0000-4000-8000-000000000002", name: "João — Conferência" }, filters: { status: "all" },
  columns: [{ key: "barcode", label: "Código de barras" }, { key: "quantity", label: "Quantidade" }, { key: "name", label: "Produto" }],
  rows: [{ barcode: "00001234567890", quantity: "99999999999999.9999", name: "=HYPERLINK(\"https://example.invalid\")" }, { barcode: "AbC001", quantity: "0.0001", name: "+SOMA(A1:A2)" }],
  rowCount: 2, operationId: "00000000-0000-4000-8000-000000000003", warnings: []
};
const auditReport: ReportPreviewDTO = {
  ...report, kind: "audit", title: "Auditoria de atividades", rowCount: 1,
  columns: [
    ...["createdAt", "actor", "action", "module", "entityType", "entityId", "origin", "operationId"].map((key) => ({ key, label: key })),
    { key: "previous", label: "Valores anteriores permitidos" }, { key: "next", label: "Valores registrados permitidos" }
  ],
  rows: [{ createdAt: report.generatedAt, actor: "Administrador", action: "Ativação", module: "Produtos", entityType: "Product", entityId: report.id, origin: "catalog", operationId: report.operationId,
    previous: JSON.stringify({ values: { name: "Coca-Cola 2L", description: "Descrição de conferência. ".repeat(15), isActive: false }, omitted: false, truncated: false }),
    next: JSON.stringify({ values: { name: "Coca-Cola 2L", isActive: true }, omitted: false, truncated: false }) }]
};
describe("contratos de relatórios", () => {
  it("normaliza filtros por relatório e mantém as datas com fuso", () => {
    expect(parseReportPreview({ kind: "movements", filters: { from: "2026-11-01T08:00:00-03:00", to: "2026-11-01T12:00:00Z", productId: "00000000-0000-4000-8000-000000000002" } }).filters.from).toBe("2026-11-01T11:00:00.000Z");
    expect(parseReportPreview({ kind: "stock", filters: {} }).filters).toEqual({ status: "all", stock: "all" });
  });
  it.each([
    { kind: "curva_abc", filters: {} }, { kind: "products", filters: { from: "2026-11-01" } }, { kind: "entries", filters: { type: "EXIT" } },
    { kind: "low_stock", filters: { stock: "normal" } }, { kind: "inventories", filters: { categoryId: "wrong" } }, { kind: "audit", filters: { module: "UNKNOWN" } },
    { kind: "movements", filters: { from: "2026-11-02T00:00:00Z", to: "2026-11-01T00:00:00Z" } }, { kind: "stock", filters: { categoryId: "bad" } }
  ])("recusa campos ou períodos incompatíveis", (body) => expect(() => parseReportPreview(body)).toThrow());
  it("exige permissão da fonte além de relatórios", () => { expect(sourcePermission("audit")).toBe("audit.read"); expect(sourcePermission("products")).toBe("catalog.read"); expect(sourcePermission("inventories")).toBe("stock.read"); });
  it.each(["format=csv", "format=xlsx&format=pdf", "format=&format=pdf", "format=pdf&file=other", ""])("não aceita parâmetros de download ambíguos: %s", (value) => expect(() => downloadFormat(new URLSearchParams(value))).toThrow());
});
describe("arquivos de relatório", () => {
  it("gera Excel com zeros e decimais exatos e fórmulas como texto", async () => {
    const bytes = await renderReportXlsx(report);
    expect(bytes.subarray(0, 2).toString()).toBe("PK");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(new Uint8Array(bytes).buffer);
    const sheet = workbook.getWorksheet("Dados")!;
    expect(sheet.getRow(2).values).toEqual([undefined, "00001234567890", "99999999999999.9999", report.rows[0].name]);
    expect(sheet.getCell("A2").type).toBe(ExcelJS.ValueType.String);
    expect(sheet.getCell("C2").type).toBe(ExcelJS.ValueType.String);
    expect(sheet.getCell("C3").value).toBe("+SOMA(A1:A2)");
    expect(sheet.getCell("B2").numFmt).toBe("@");
    expect(workbook.getWorksheet("Informações")?.getCell("B1").value).toBe("Prevision");
    expect(workbook.getWorksheet("Informações")?.getCell("B3").value).toBe(report.generatedAt);
  });
  it("PDF usa texto de relatório sem interpretar links ou nós fornecidos pelo usuário", () => {
    const definition = buildReportPdfDefinition(report);
    const printed = JSON.stringify(definition);
    expect(printed).toContain("PREVISION"); expect(printed).toContain("Código de barras"); expect(printed).toContain("99999999999999.9999");
    expect(printed).not.toContain('"link":'); expect(printed).not.toContain('"image":');
  });
  it("abreviação de textos no PDF é informada e a prévia não é alterada", () => {
    const source = { ...report, rows: [{ barcode: "0000", quantity: "1.0000", name: "á".repeat(250) }], rowCount: 1 };
    const printed = JSON.stringify(buildReportPdfDefinition(source));
    expect(printed).toContain("180 caracteres"); expect(printed).not.toContain("á".repeat(250)); expect(source.rows[0].name).toHaveLength(250);
  });
  it("gera PDF real com fonte Roboto e identificação", async () => {
    const bytes = await renderReportPdf({ ...report, rows: [{ barcode: "0000", quantity: "1.2356", name: "Café, Açúcar e Óleo" }], rowCount: 1 });
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect(bytes.toString("latin1")).toContain("Roboto");
    expect(bytes.length).toBeGreaterThan(5000);
  }, 15000);
  it("relatório largo mantém todas as colunas em layout por registro", () => {
    const wide = { ...report, columns: Array.from({ length: 12 }, (_, index) => ({ key: `column${index}`, label: `Campo ${index}` })), rows: [Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`column${index}`, `valor-${index}`]))], rowCount: 1 };
    const printed = JSON.stringify(buildReportPdfDefinition(wide));
    for (let index = 0; index < 12; index++) expect(printed).toContain(`valor-${index}`);
  });
  it("auditoria separa os valores em seções na largura inteira sem cortar os campos após 180 caracteres", () => {
    const definition = buildReportPdfDefinition(auditReport);
    const nodes = definition.content as { table?: { widths: unknown[]; body: { text: string }[][] } }[];
    const sections = nodes.filter((node) => node.table?.widths.length === 1);
    expect(sections.map((node) => node.table!.widths)).toEqual([["*"], ["*"]]);
    expect(sections.map((node) => node.table!.body[0][0].text)).toEqual(["Valores anteriores", "Valores registrados"]);
    expect(sections[0].table!.body[1][0].text).toContain("Ativo: Não");
    expect(sections[1].table!.body[1][0].text).toContain("Ativo: Sim");
    const printed = JSON.stringify(definition);
    expect(printed).not.toContain("Valores anteriores permitidos");
    expect(printed).not.toContain('\\"values\\":');
    expect(auditReport.rows[0].previous).toContain('"values":');
  });
  it("auditoria sem um estado mostra uma explicação e gera PDF válido com seções longas", async () => {
    const source = { ...auditReport, rows: [{ ...auditReport.rows[0], next: null }] };
    expect(JSON.stringify(buildReportPdfDefinition(source))).toContain("Esta atividade não registrou valores nesta seção.");
    expect((await renderReportPdf(source)).subarray(0, 5).toString()).toBe("%PDF-");
  }, 15000);
  it("Excel de auditoria também usa títulos e valores legíveis", async () => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(new Uint8Array(await renderReportXlsx(auditReport)).buffer);
    const sheet = workbook.getWorksheet("Dados")!;
    expect(sheet.getCell("I1").value).toBe("Valores anteriores");
    expect(sheet.getCell("J1").value).toBe("Valores registrados");
    expect(sheet.getCell("I2").value).toContain("Ativo: Não");
    expect(sheet.getCell("J2").value).toContain("Ativo: Sim");
  });
});
