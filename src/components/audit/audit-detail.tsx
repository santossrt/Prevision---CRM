"use client";
import { useEffect, useState } from "react";
import type { AuditEventDTO, AuditSnapshotDTO, AuditValue } from "@/lib/audit/types";
import { actionLabel, auditFieldLabels, moduleLabel } from "@/lib/audit/labels";
import { CatalogModal } from "@/components/catalog/catalog-modal";
import { catalogError, catalogRequest, isCancelled } from "@/components/catalog/catalog-api";
import { formatCatalogDate, formatCatalogDecimal, formatCatalogMoney } from "@/components/catalog/catalog-meta";

const amounts = new Set(["acquisitionCost", "salePrice", "historicalUnitCost", "historicalTotalCost", "historicalUnitPrice", "historicalTotalPrice", "previousValue", "newValue"]);
const quantities = new Set(["quantity", "quantityDelta", "quantityBefore", "quantityAfter", "minimumStock", "safetyStock", "baselineQuantity", "countedQuantity", "difference"]);
function Value({ value, field = "" }: { value: AuditValue; field?: string }) {
  if (value === null) return <span className="audit-value-empty">Não informado</span>;
  if (typeof value === "boolean") return <>{value ? "Sim" : "Não"}</>;
  if (typeof value === "number") return <>{value}</>;
  if (typeof value === "string") {
    if ((amounts.has(field) || quantities.has(field)) && /^-?\d+(?:\.\d+)?$/u.test(value)) return <>{amounts.has(field) ? formatCatalogMoney(value) : formatCatalogDecimal(value)}</>;
    if (field.endsWith("At") && /^\d{4}-\d{2}-\d{2}T/u.test(value)) return <>{formatCatalogDate(value)}</>;
    return <span className={field.endsWith("Id") || field === "id" ? "audit-identifier" : undefined}>{value || "Não informado"}</span>;
  }
  if (Array.isArray(value)) return value.length ? <ol className="audit-value-list">{value.map((item, index) => <li key={index}><Value value={item} field={field} /></li>)}</ol> : <span className="audit-value-empty">Lista vazia</span>;
  const entries = Object.entries(value);
  return entries.length ? <dl className="audit-values">{entries.map(([key, entry]) => <div key={key}><dt>{auditFieldLabels[key] ?? key}</dt><dd><Value value={entry} field={key} /></dd></div>)}</dl> : <span className="audit-value-empty">Nenhum campo público para exibir</span>;
}
function Snapshot({ title, snapshot }: { title: string; snapshot: AuditSnapshotDTO | null }) {
  return <section className="audit-snapshot"><h3>{title}</h3>{snapshot ? <><Value value={snapshot.values} />{snapshot.omitted && <p className="audit-snapshot-note">Campos fora da lista permitida foram omitidos.</p>}{snapshot.truncated && <p className="audit-snapshot-note">A exibição foi limitada ao tamanho permitido para esta consulta.</p>}</> : <p className="audit-value-empty">Esta operação não registrou valores nesta seção.</p>}</section>;
}

export function AuditDetail({ eventId, onClose, onOperation }: { eventId: string; onClose: () => void; onOperation: (id: string) => void }) {
  const [event, setEvent] = useState<AuditEventDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setEvent(null); setLoading(true); setError("");
    void catalogRequest<AuditEventDTO>(`/api/audit/${encodeURIComponent(eventId)}`, { signal: controller.signal }).then(setEvent)
      .catch((failure) => { if (!isCancelled(failure)) setError(catalogError(failure)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [eventId, revision]);
  return <CatalogModal title="Detalhes da atividade" caption="AUDITORIA" wide onClose={onClose}>
    {loading && <p className="audit-state" role="status">Consultando o registro…</p>}
    {error && <div className="form-message form-error" role="alert"><p>{error}</p><button type="button" className="text-link" onClick={() => setRevision((value) => value + 1)}>Tentar novamente</button></div>}
    {event && <><dl className="audit-event-meta"><div><dt>Ação</dt><dd>{actionLabel(event.action)}</dd></div><div><dt>Módulo</dt><dd>{moduleLabel(event.module)}</dd></div><div><dt>Responsável</dt><dd>{event.actor ? <>{event.actor.name || "Usuário sem nome"}<small className="audit-identifier">{event.actor.id}</small></> : "Não identificado"}</dd></div><div><dt>Data e horário</dt><dd>{formatCatalogDate(event.createdAt)}</dd></div><div><dt>Entidade</dt><dd>{event.entityType}<small className="audit-identifier">{event.entityId || "Registro não identificado"}</small></dd></div><div><dt>Origem</dt><dd>{event.origin || "Não informada"}</dd></div><div className="audit-meta-wide"><dt>Identificação da operação</dt><dd className="audit-identifier">{event.operationId}</dd></div><div className="audit-meta-wide"><dt>Identificação do evento</dt><dd className="audit-identifier">{event.id}</dd></div></dl>
      <div className="audit-snapshots"><Snapshot title="Valores anteriores" snapshot={event.previousValues} /><Snapshot title="Valores registrados" snapshot={event.newValues} /></div>
      <p className="catalog-confirm-note">O registro preserva o que foi auditado no momento da operação. Consultar esta atividade não altera o cadastro ou o estoque.</p>
    </>}
    <div className="dialog-actions"><button type="button" className="button-secondary" onClick={onClose}>Fechar</button>{event && <button type="button" className="button-primary" onClick={() => onOperation(event.operationId)}>Ver eventos desta operação</button>}</div>
  </CatalogModal>;
}
