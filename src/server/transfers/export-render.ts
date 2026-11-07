import "server-only";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import ExcelJS from "exceljs";
import type { ReportPreviewDTO } from "../../lib/transfers/types.ts";
import { readableAuditReportValue } from "./export-audit.ts";

const require = createRequire(import.meta.url);
interface PdfMake {
  addFonts(fonts: Record<string, Record<string, string>>): void;
  setUrlAccessPolicy(policy: (url: string) => boolean): void;
  setLocalAccessPolicy(policy: (path: string) => boolean): void;
  createPdf(document: Record<string, unknown>): { getBuffer(): Promise<Buffer> };
}
let configured: PdfMake | undefined;
function pdfEngine(): PdfMake {
  if (!configured) {
    const engine = require("pdfmake") as PdfMake;
    const fonts = require("pdfmake/fonts/Roboto") as Record<string, Record<string, string>>;
    const allowed = new Set(Object.values(fonts).flatMap((styles) => Object.values(styles)).map((path) => resolve(path)));
    engine.setUrlAccessPolicy(() => false);
    engine.setLocalAccessPolicy((path) => allowed.has(resolve(path)));
    engine.addFonts(fonts);
    configured = engine;
  }
  return configured;
}

const auditSnapshotColumns = new Set(["previous", "next"]);
const auditLabels: Record<string, string> = { previous: "Valores anteriores", next: "Valores registrados", origin: "Origem" };
function readableReport(report: ReportPreviewDTO): ReportPreviewDTO {
  if (report.kind !== "audit") return report;
  return {
    ...report,
    columns: report.columns.map((column) => ({ ...column, label: auditLabels[column.key] ?? column.label })),
    rows: report.rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, auditSnapshotColumns.has(key) ? readableAuditReportValue(value) : value])))
  };
}

/** Explicit string cells preserve zeros/18-digit decimals and never become formulas. */
export async function renderReportXlsx(source: ReportPreviewDTO): Promise<Buffer> {
  const report = readableReport(source);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Prevision";
  workbook.created = new Date(report.generatedAt);
  workbook.modified = new Date(report.generatedAt);
  const information = workbook.addWorksheet("Informações");
  const metadata: [string, string][] = [
    ["Sistema", "Prevision"], ["Relatório", report.title], ["Gerado em (UTC)", report.generatedAt],
    ["Responsável", report.generatedBy.name || "Usuário cadastrado"], ["Linhas", String(report.rowCount)],
    ["Operação (ID)", report.operationId], ["Filtros", JSON.stringify(report.filters)],
    ["Precisão", "Quantidades, valores e códigos são texto para preservar todas as casas e zeros iniciais."],
    ...report.warnings.map((warning): [string, string] => ["Observação", warning])
  ];
  for (const values of metadata) { const row = information.addRow(values); row.eachCell((cell) => { cell.numFmt = "@"; cell.alignment = { vertical: "top", wrapText: true }; }); }
  information.getColumn(1).width = 25; information.getColumn(2).width = 95;
  const sheet = workbook.addWorksheet("Dados", { views: [{ state: "frozen", ySplit: 1 }] });
  sheet.columns = report.columns.map((column) => ({ header: column.label, key: column.key, width: Math.max(18, Math.min(38, column.label.length + 4)), style: { numFmt: "@", alignment: { vertical: "top", wrapText: true } } }));
  sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF326746" } };
  for (const data of report.rows) {
    const row = sheet.addRow(report.columns.map(({ key }) => data[key] ?? ""));
    row.eachCell({ includeEmpty: true }, (cell) => { cell.numFmt = "@"; });
  }
  if (report.columns.length) sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, report.rows.length + 1), column: report.columns.length } };
  sheet.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
  sheet.headerFooter.oddHeader = "&LPrevision&R" + report.title.replace(/&/g, "&&");
  sheet.headerFooter.oddFooter = "&LGerado: " + report.generatedAt + "&RPágina &P de &N";
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

const pdfText = (value: string | null, maximumLength = 180): string => {
  if (value === null || value === "") return "—";
  const bounded = value.length > maximumLength ? `${value.slice(0, maximumLength - 1)}…` : value;
  // Break very long codes visually without changing visible characters.
  return bounded.replace(/[^\s]{25,}/gu, (token) => Array.from(token).map((character, index) => index > 0 && index % 16 === 0 ? `\u200b${character}` : character).join(""));
};

/** Plain text only: no user-provided URL, SVG, font path, image or rich document node. */
export function buildReportPdfDefinition(source: ReportPreviewDTO): Record<string, unknown> {
  const report = readableReport(source);
  const anyLong = report.rows.some((row) => report.columns.some(({ key }) => !(report.kind === "audit" && auditSnapshotColumns.has(key)) && (row[key]?.length ?? 0) > 180));
  const notes = [...report.warnings, ...(anyLong ? ["No PDF, textos com mais de 180 caracteres são apresentados de forma abreviada. O Excel preserva todo o conteúdo desta prévia."] : [])];
  const content: unknown[] = [
    { text: "PREVISION", color: "#326746", bold: true, fontSize: 17, margin: [0, 0, 0, 6] },
    { text: report.title, style: "title" },
    { text: `Gerado em (UTC): ${report.generatedAt} · Responsável: ${report.generatedBy.name || "Usuário cadastrado"} · ${report.rowCount} linhas`, style: "meta" },
    { text: `Filtros: ${JSON.stringify(report.filters)}`, style: "meta" },
    ...notes.map((text) => ({ text, style: "note" }))
  ];
  if (!report.rows.length) content.push({ text: "Nenhum registro encontrado para os filtros selecionados.", margin: [0, 18, 0, 0] });
  else if (report.kind !== "audit" && report.columns.length <= 8) content.push({
    table: { headerRows: 1, widths: report.columns.map(() => "*"), body: [report.columns.map(({ label }) => ({ text: label, bold: true, color: "#FFFFFF", fillColor: "#326746" })), ...report.rows.map((row) => report.columns.map(({ key }) => ({ text: pdfText(row[key] ?? null) })))] },
    layout: "lightHorizontalLines", fontSize: 8
  });
  else {
    for (const [index, row] of report.rows.entries()) {
      const body: unknown[][] = [];
      const metadata = report.kind === "audit" ? report.columns.filter(({ key }) => !auditSnapshotColumns.has(key)) : report.columns;
      for (let offset = 0; offset < metadata.length; offset += 2) {
        const left = metadata[offset]; const right = metadata[offset + 1];
        body.push([{ text: left.label, bold: true, color: "#46643D" }, { text: pdfText(row[left.key] ?? null) }, right ? { text: right.label, bold: true, color: "#46643D" } : "", right ? { text: pdfText(row[right.key] ?? null) } : ""]);
      }
      content.push({ text: `Registro ${index + 1}`, bold: true, fontSize: 10, margin: [0, 12, 0, 4] });
      if (body.length) content.push({ table: { widths: report.kind === "audit" ? [75, "*", 75, "*"] : ["auto", "*", "auto", "*"], body, dontBreakRows: true }, layout: "lightHorizontalLines", fontSize: 8 });
      if (report.kind === "audit") {
        for (const column of report.columns.filter(({ key }) => auditSnapshotColumns.has(key))) {
          content.push({
            table: { headerRows: 1, widths: ["*"], body: [
              [{ text: column.label, bold: true, color: "#46643D", fillColor: "#EFF4EA" }],
              [{ text: pdfText(row[column.key] || "Esta atividade não registrou valores nesta seção.", 4000) }]
            ] },
            layout: "noBorders", fontSize: 8, margin: [0, 8, 0, 2]
          });
        }
      }
    }
  }
  return {
    pageSize: "A4", pageOrientation: report.kind !== "audit" && report.columns.length <= 8 ? "landscape" : "portrait", pageMargins: [34, 36, 34, 40],
    info: { title: report.title, author: "Prevision", subject: "Relatório de gestão de estoque", creator: "Prevision", creationDate: new Date(report.generatedAt) },
    defaultStyle: { font: "Roboto", fontSize: 9 }, styles: { title: { fontSize: 14, bold: true, margin: [0, 0, 0, 8] }, meta: { fontSize: 8, color: "#52624B", margin: [0, 0, 0, 5] }, note: { fontSize: 8, color: "#6E7056", margin: [0, 2, 0, 5] } },
    footer: (page: number, total: number) => ({ text: `Prevision · Página ${page} de ${total}`, alignment: "right", fontSize: 8, margin: [34, 12, 34, 0], color: "#66775B" }),
    content
  };
}

export async function renderReportPdf(report: ReportPreviewDTO): Promise<Buffer> {
  return pdfEngine().createPdf(buildReportPdfDefinition(report)).getBuffer();
}
