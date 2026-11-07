import ExcelJS from "exceljs";
import { ApplicationError } from "../errors/application-error.ts";
import { headerKey, importColumns, type ImportColumn } from "./import-columns.ts";
import { validatedWorkbookZip } from "./import-zip.ts";
import { withTransferResource } from "./resource-limit.ts";

export interface ParsedImportRow { rowNumber: number; values: Partial<Record<ImportColumn, string>>; issues: { column?: string; message: string }[] }
export type ImportFormat = "csv" | "xlsx";
function fail(message: string): never { throw new ApplicationError("VALIDATION", message); }
const allowed = new Set<string>(importColumns.map(([key]) => key));

/** Strict bounded CSV, including quoted delimiters and embedded newlines. */
export function parseCsv(source: string): { rowNumber: number; cells: string[] }[] {
  source = source.replace(/^\uFEFF/u, "");
  let quoted = false; let commas = 0; let semicolons = 0;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (character === '"') { if (quoted && source[index + 1] === '"') index++; else quoted = !quoted; }
    if (!quoted && /[\r\n]/u.test(character)) break;
    if (!quoted && character === ",") commas++;
    if (!quoted && character === ";") semicolons++;
  }
  const delimiter = semicolons >= commas ? ";" : ",";
  const rows: { rowNumber: number; cells: string[] }[] = [];
  let cells: string[] = []; let field = ""; let mode: "plain" | "quoted" | "closed" = "plain"; let line = 1; let rowNumber = 1;
  const cell = () => { cells.push(field); field = ""; mode = "plain"; if (cells.length > 32) fail("A planilha admite no máximo 32 colunas."); };
  const row = () => { cell(); rows.push({ rowNumber, cells }); cells = []; if (rows.length > 5000) fail("Remova linhas vazias excedentes; o arquivo admite até 5.000 linhas físicas e 200 produtos."); };
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (character === "\0") fail("O arquivo contém caracteres de controle inválidos.");
    if (mode === "quoted") {
      if (character === '"') {
        if (source[index + 1] === '"') { field += '"'; index++; } else mode = "closed";
      } else if (character === "\r" || character === "\n") {
        if (character === "\r" && source[index + 1] === "\n") index++;
        field += "\n"; line++;
      } else field += character;
    } else if (character === delimiter) cell();
    else if (character === "\r" || character === "\n") {
      if (character === "\r" && source[index + 1] === "\n") index++;
      row(); line++; rowNumber = line;
    } else if (character === '"') {
      if (mode !== "plain" || field !== "") fail("O CSV contém aspas fora de uma célula entre aspas.");
      mode = "quoted";
    } else {
      if (mode === "closed") fail("O CSV contém conteúdo após o fechamento de uma célula entre aspas.");
      field += character;
    }
    if (field.length > 8192 || line > 5000) fail("O arquivo contém uma célula ou quantidade de linhas acima do limite permitido.");
  }
  if (mode === "quoted") fail("O CSV contém uma célula entre aspas sem fechamento.");
  if (field || cells.length || mode === "closed") row();
  return rows;
}

type Cell = { value: string; issue?: string };
function excelCell(value: ExcelJS.CellValue, identity: boolean): Cell {
  if (value === null || value === undefined) return { value: "" };
  if (typeof value === "string") return { value };
  if (typeof value === "number") return identity ? { value: String(value), issue: "Formate SKU e código de barras como Texto para preservar zeros e todos os dígitos." } : { value: String(value) };
  if (typeof value === "boolean") return { value: String(value) };
  if (typeof value === "object" && "richText" in value) return { value: value.richText.map((part) => part.text).join("") };
  return { value: "", issue: "Utilize texto ou número simples; fórmulas, datas, links e erros de célula não são aceitos." };
}
function headers(cells: string[]): ImportColumn[] {
  while (cells.length && !cells.at(-1)?.trim()) cells.pop();
  if (!cells.length || cells.length > 32) fail("A primeira linha precisa conter os cabeçalhos do modelo de produtos.");
  const keys = cells.map(headerKey);
  if (keys.some((key) => /^(?:quantidade|saldo|saldo_inicial|estoque_atual)$/u.test(key))) fail("A importação cadastra produtos com saldo zero. Não informe quantidade ou saldo; registre uma entrada no Controle de estoque.");
  if (keys.some((key) => !allowed.has(key))) fail("Há cabeçalhos desconhecidos ou vazios. Utilize as colunas do modelo de produtos.");
  if (new Set(keys).size !== keys.length) fail("Não repita o mesmo cabeçalho na planilha.");
  if (!["nome", "sku", "categoria"].every((key) => keys.includes(key))) fail("As colunas Nome, SKU e Categoria são obrigatórias.");
  return keys as ImportColumn[];
}

async function parseFile(buffer: Buffer, format: ImportFormat): Promise<ParsedImportRow[]> {
  if (!buffer.length || buffer.length > 2 * 1024 * 1024) fail("Selecione um arquivo CSV ou XLSX com até 2 MiB.");
  let rows: { rowNumber: number; cells: Cell[] }[];
  if (format === "csv") {
    let source: string;
    try { source = new TextDecoder("utf-8", { fatal: true }).decode(buffer); } catch { return fail("Salve o CSV com codificação UTF-8 antes de enviar."); }
    rows = parseCsv(source).map((row) => ({ rowNumber: row.rowNumber, cells: row.cells.map((value) => ({ value })) }));
  } else {
    const safeZip = await validatedWorkbookZip(buffer);
    const workbook = new ExcelJS.Workbook();
    try { await workbook.xlsx.load(safeZip as unknown as ExcelJS.Buffer); } catch { return fail("Não foi possível ler o arquivo XLSX. Utilize o modelo de produtos."); }
    const sheet = workbook.getWorksheet("Produtos") ?? (workbook.worksheets.length === 1 ? workbook.worksheets[0] : undefined);
    if (!sheet || sheet.rowCount > 5000 || sheet.columnCount > 32) fail("Utilize uma aba Produtos ou uma única aba, com no máximo 32 colunas e 5.000 linhas físicas.");
    const headerCells = Array.from({ length: sheet.getRow(1).cellCount }, (_, index) => excelCell(sheet.getRow(1).getCell(index + 1).value, false));
    if (headerCells.some((cell) => cell.issue)) fail("Os cabeçalhos precisam ser texto simples.");
    const keys = headers(headerCells.map((cell) => cell.value));
    rows = [{ rowNumber: 1, cells: headerCells }];
    for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber++) {
      const row = sheet.getRow(rowNumber);
      rows.push({ rowNumber, cells: Array.from({ length: Math.max(keys.length, row.cellCount) }, (_, index) => excelCell(row.getCell(index + 1).value, keys[index] === "sku" || keys[index] === "codigo_barras")) });
    }
  }
  const first = rows.shift(); if (!first || first.rowNumber !== 1) fail("O arquivo precisa começar pela linha de cabeçalhos.");
  const keys = headers(first.cells.map((cell) => cell.value));
  const parsed: ParsedImportRow[] = [];
  for (const row of rows) {
    if (!row.cells.some((cell) => cell.value.trim() || cell.issue)) continue;
    const values: Partial<Record<ImportColumn, string>> = {}; const issues: ParsedImportRow["issues"] = [];
    for (let index = 0; index < keys.length; index++) {
      const cell = row.cells[index] ?? { value: "" }; values[keys[index]] = cell.value.trim();
      if (cell.issue) issues.push({ column: keys[index], message: cell.issue });
      if (cell.value.length > 8192 || /^\s*=/u.test(cell.value)) issues.push({ column: keys[index], message: "Não utilize fórmulas ou células acima do limite permitido." });
    }
    if (row.cells.slice(keys.length).some((cell) => cell.value.trim() || cell.issue)) issues.push({ message: "Há dados em colunas sem cabeçalho no modelo." });
    parsed.push({ rowNumber: row.rowNumber, values, issues });
    if (parsed.length > 200) fail("A importação admite no máximo 200 produtos. Divida o arquivo em lotes menores.");
  }
  if (!parsed.length) fail("O arquivo não contém produtos para importar.");
  return parsed;
}

export async function parseImportFile(buffer: Buffer, format: ImportFormat): Promise<ParsedImportRow[]> {
  return format === "xlsx" ? withTransferResource(() => parseFile(buffer, format)) : parseFile(buffer, format);
}

export async function importTemplate(format: ImportFormat): Promise<Buffer> {
  if (format === "csv") return Buffer.from(`\uFEFF${importColumns.map(([, label]) => label).join(";")}\r\n`, "utf8");
  const workbook = new ExcelJS.Workbook(); workbook.creator = "Prevision";
  const sheet = workbook.addWorksheet("Produtos"); sheet.addRow(importColumns.map(([, label]) => label));
  sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } }; sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF326544" } };
  sheet.columns.forEach((column) => { column.width = 25; column.numFmt = "@"; });
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
