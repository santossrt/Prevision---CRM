import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { parseCsv, parseImportFile, importTemplate } from "../../src/server/transfers/import-parser.ts";
import { headerKey } from "../../src/server/transfers/import-columns.ts";
import { validatedWorkbookZip } from "../../src/server/transfers/import-zip.ts";

describe("CSV de produtos", () => {
  it("preserva zeros, delimitador, aspas escapadas e linhas físicas", async () => {
    const rows = await parseImportFile(Buffer.from('\uFEFFNome;SKU;Categoria;Código de barras;Descrição\r\n"Pote; vidro";000001;Casa;000123;"Linha 1\nLinha ""2"""\r\nOutro;AB-2;Casa;;Fim'), "csv");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ rowNumber: 2, values: { nome: "Pote; vidro", sku: "000001", codigo_barras: "000123", descricao: 'Linha 1\nLinha "2"' }, issues: [] });
    expect(rows[1].rowNumber).toBe(4);
  });
  it("aceita vírgula como separador e vírgula decimal entre aspas", async () => {
    const rows = await parseImportFile(Buffer.from('Nome,SKU,Categoria,Custo de aquisição\nProduto,AB,Casa,"1,2500"'), "csv");
    expect(rows[0].values.custo_aquisicao).toBe("1,2500");
  });
  it.each(['Nome;SKU;Categoria\n"ab;A;C', 'Nome;SKU;Categoria\na"b;A;C', 'Nome;SKU;Categoria\n"ab"x;A;C', 'Nome;SKU;Categoria\na\0b;A;C'])("recusa estrutura inválida", async (source) => {
    await expect(parseImportFile(Buffer.from(source), "csv")).rejects.toMatchObject({ code: "VALIDATION" });
  });
  it.each(["Quantidade", "Saldo", "Saldo inicial", "Estoque atual"])("recusa coluna %s para impedir saldo implícito", async (column) => {
    await expect(parseImportFile(Buffer.from(`Nome;SKU;Categoria;${column}\nP;A;C;8`), "csv")).rejects.toThrow("saldo zero");
  });
  it.each(["Nome;SKU", "Nome;SKU;Categoria;Nome", "Nome;SKU;Categoria;Senha", "Nome;;Categoria"])("recusa cabeçalhos ausentes ou ambíguos", async (header) => {
    await expect(parseImportFile(Buffer.from(header + "\nP;A;C;B"), "csv")).rejects.toMatchObject({ code: "VALIDATION" });
  });
  it("normaliza os aliases do modelo em português", () => {
    expect(headerKey(" Código de barras ")).toBe("codigo_barras");
    expect(headerKey("Prazo de reposição (dias)")).toBe("prazo_reposicao_dias");
  });
  it("marca fórmula e colunas excedentes na linha sem interpretar valores", async () => {
    const rows = await parseImportFile(Buffer.from('Nome;SKU;Categoria\n=HYPERLINK(1);A;Casa;excedente'), "csv");
    expect(rows[0].issues).toHaveLength(2);
  });
  it("recusa vazio, UTF-8 inválido, arquivo grande e mais de 200 produtos", async () => {
    for (const buffer of [Buffer.alloc(0), Buffer.from([0xff, 0xfe, 0x80]), Buffer.alloc(2 * 1024 * 1024 + 1)]) await expect(parseImportFile(buffer, "csv")).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(parseImportFile(Buffer.from("Nome;SKU;Categoria\n" + Array.from({ length: 201 }, (_, index) => `P${index};A${index};Casa`).join("\n")), "csv")).rejects.toThrow("200");
  });
  it("ignora linhas vazias sem perder a referência do erro", async () => {
    const rows = await parseImportFile(Buffer.from('Nome;SKU;Categoria\n\nP;A;Casa\n;;\nQ;B;Casa\n'), "csv");
    expect(rows.map((row) => row.rowNumber)).toEqual([3, 5]);
  });
  it("limita células e linhas físicas antes de validar domínio", () => {
    expect(() => parseCsv("a;" + "x".repeat(8193))).toThrow();
    expect(() => parseCsv("a\n".repeat(5002))).toThrow();
  });
});

async function workbook(rows: ExcelJS.CellValue[][], sheetName = "Produtos") {
  const book = new ExcelJS.Workbook(); const sheet = book.addWorksheet(sheetName);
  for (const row of rows) sheet.addRow(row);
  return Buffer.from(await book.xlsx.writeBuffer());
}
describe("Excel de produtos", () => {
  it("lê XLSX validado e preserva códigos armazenados como texto", async () => {
    const rows = await parseImportFile(await workbook([["Nome", "SKU", "Categoria", "Código de barras", "Ativo"], ["Produto", "00001", "Casa", "000123", true]]), "xlsx");
    expect(rows[0]).toMatchObject({ values: { sku: "00001", codigo_barras: "000123", ativo: "true" }, issues: [] });
  });
  it("recusa identidade numérica e fórmulas por linha", async () => {
    const rows = await parseImportFile(await workbook([["Nome", "SKU", "Categoria", "Código de barras"], ["Produto", 123, "Casa", { formula: "1+1", result: 2 }]]), "xlsx");
    expect(rows[0].issues).toHaveLength(2);
  });
  it("recusa ZIP inválido, links externos e áreas esparsas enormes", async () => {
    await expect(validatedWorkbookZip(Buffer.from("invalid"))).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(parseImportFile(await workbook([["Nome", "SKU", "Categoria"], [{ text: "P", hyperlink: "https://example.invalid/private" }, "A", "Casa"]]), "xlsx")).rejects.toMatchObject({ code: "VALIDATION" });
    const book = new ExcelJS.Workbook(); book.addWorksheet("Produtos").getCell("A5001").value = "Muito longe";
    await expect(parseImportFile(Buffer.from(await book.xlsx.writeBuffer()), "xlsx")).rejects.toMatchObject({ code: "VALIDATION" });
  });
  it("gera modelos sem produtos fictícios e usa formato texto nas identidades", async () => {
    expect((await importTemplate("csv")).toString("utf8")).toContain("Nome;SKU;Código de barras");
    const book = new ExcelJS.Workbook(); await book.xlsx.load(await importTemplate("xlsx") as unknown as ExcelJS.Buffer);
    expect(book.getWorksheet("Produtos")?.rowCount).toBe(1);
    expect(book.getWorksheet("Produtos")?.getColumn(2).numFmt).toBe("@");
  });
});
