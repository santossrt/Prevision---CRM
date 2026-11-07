import "server-only";
import { auditFieldLabels } from "../../lib/audit/labels.ts";
import type { AuditSnapshotDTO, AuditValue } from "../../lib/audit/types.ts";
import { sanitizeAuditSnapshot } from "../audit/sanitize.ts";

const maximumLength = 4000;
const limitation = "Exibição limitada; consulte os detalhes da atividade na auditoria.";

/** Receives only the public snapshot, never the original database values. */
export function formatAuditReportSnapshot(snapshot: AuditSnapshotDTO | null): { text: string | null; limited: boolean } {
  if (!snapshot) return { text: null, limited: false };
  const lines: string[] = [];
  function visit(value: AuditValue, path = "") {
    const append = (text: string) => lines.push(path ? `${path}: ${text}` : text);
    if (value === null || value === "") append("Não informado");
    else if (typeof value === "boolean") append(value ? "Sim" : "Não");
    else if (typeof value !== "object") append(String(value));
    else if (Array.isArray(value)) {
      if (!value.length) append("Lista vazia");
      value.forEach((entry, index) => visit(entry, `${path ? `${path} ` : "Item "}[${index + 1}]`));
    } else {
      const entries = Object.entries(value);
      if (!entries.length) append("Nenhum campo disponível");
      for (const [key, entry] of entries) visit(entry, [path, auditFieldLabels[key] ?? key].filter(Boolean).join(" · "));
    }
  }
  visit(snapshot.values);
  if (snapshot.omitted) lines.push("Campos fora da lista permitida foram omitidos.");
  const text = lines.join("\n");
  const limited = snapshot.truncated || text.length > maximumLength;
  return { text: limited ? `${text.slice(0, maximumLength - limitation.length - 2)}\n${limitation}` : text, limited };
}

/** Existing previews may still contain the previous JSON representation. */
export function readableAuditReportValue(value: string | null): string | null {
  if (!value?.startsWith('{"values":')) return value;
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === "object" && "values" in parsed && "omitted" in parsed && "truncated" in parsed
      && typeof parsed.omitted === "boolean" && typeof parsed.truncated === "boolean") {
      const safe = sanitizeAuditSnapshot(parsed.values) ?? { values: null, omitted: false, truncated: false };
      safe.omitted ||= parsed.omitted;
      safe.truncated ||= parsed.truncated;
      return formatAuditReportSnapshot(safe).text;
    }
  } catch { /* Old previews could cut the JSON before its closing brace. */ }
  return "Esta prévia contém valores em um formato antigo e incompleto. Gere uma nova prévia para consultar os campos da atividade.";
}
