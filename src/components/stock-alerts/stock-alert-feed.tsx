"use client";

import { useEffect, useId, useState } from "react";
import { Icon } from "@/components/ui/icon";
import { decimal, date } from "@/components/stock/stock-format";
import type { StockAlertDTO, StockAlertKind, StockAlertsList } from "@/lib/stock/alerts-types";
import { useStockAlerts } from "./use-stock-alerts";

function stockLink(alert: StockAlertDTO) {
  const query = new URLSearchParams({ stock: alert.kind === "EMPTY" ? "empty" : "low", search: alert.sku });
  return `/estoque?${query}`;
}

export function StockAlertFeed({ compact = false, onNavigate }: { compact?: boolean; onNavigate?: () => void }) {
  const id = useId();
  const [kind, setKind] = useState<StockAlertKind | "">("");
  const [page, setPage] = useState(1);
  const query = new URLSearchParams({ page: String(page), pageSize: compact ? "5" : "10" });
  if (kind) query.set("kind", kind);
  const { data, loading, error, refresh } = useStockAlerts<StockAlertsList>(`/api/stock/alerts?${query}`);
  useEffect(() => {
    if (data && page > Math.max(1, data.totalPages)) setPage(Math.max(1, data.totalPages));
  }, [data, page]);
  function filter(value: StockAlertKind | "") { setKind(value); setPage(1); }

  return <div className={compact ? "stock-alert-feed stock-alert-feed-compact" : "stock-alert-feed"}>
    {!compact && <div className="stock-alert-counters" aria-label="Produtos que precisam de atenção">
      <button type="button" className={`stock-alert-counter${kind === "" ? " stock-alert-counter-selected" : ""}`} aria-pressed={kind === ""} onClick={() => filter("")}><span>Precisam de atenção</span><strong>{data ? data.summary.total : "—"}</strong><small>Produtos ativos no estoque</small></button>
      <button type="button" className={`stock-alert-counter stock-alert-counter-empty${kind === "EMPTY" ? " stock-alert-counter-selected" : ""}`} aria-pressed={kind === "EMPTY"} onClick={() => filter("EMPTY")}><span>Sem estoque</span><strong>{data ? data.summary.empty : "—"}</strong><small>Quantidade disponível igual a zero</small></button>
      <button type="button" className={`stock-alert-counter stock-alert-counter-low${kind === "LOW" ? " stock-alert-counter-selected" : ""}`} aria-pressed={kind === "LOW"} onClick={() => filter("LOW")}><span>Estoque baixo</span><strong>{data ? data.summary.low : "—"}</strong><small>Saldo positivo até o mínimo definido</small></button>
    </div>}
    <div className="stock-alert-toolbar"><label htmlFor={`${id}-kind`}>Situação</label><select id={`${id}-kind`} value={kind} onChange={(event) => filter(event.target.value as StockAlertKind | "")}><option value="">Todos os alertas</option><option value="EMPTY">Sem estoque</option><option value="LOW">Estoque baixo</option></select><button type="button" className="text-link" disabled={loading} onClick={refresh}>{loading && data ? "Atualizando…" : "Atualizar"}</button></div>
    {error && <div className="form-message form-error stock-alert-error" role="alert"><p>{error}{data ? " Os dados abaixo correspondem à última consulta concluída." : ""}</p><button type="button" className="text-link" onClick={refresh}>Tentar novamente</button></div>}
    {!data && loading ? <p className="stock-alert-state" role="status">Consultando os alertas do estoque…</p> : data?.items.length ? <>
      <ul className="stock-alert-list" aria-label="Alertas ativos" aria-busy={loading}>{data.items.map((alert) => <li key={alert.productId}>
        <span className={`stock-alert-level stock-alert-level-${alert.kind.toLowerCase()}`}><span aria-hidden="true">{alert.kind === "EMPTY" ? "!" : "↓"}</span>{alert.kind === "EMPTY" ? "Sem estoque" : "Estoque baixo"}</span>
        <div className="stock-alert-product"><strong>{alert.name}</strong><span>{alert.sku}</span><small>Saldo: {decimal(alert.quantity)} {alert.unitOfMeasure} · Mínimo: {decimal(alert.minimumStock)} {alert.unitOfMeasure}</small>{!compact && <small>Condição atualizada em {date(alert.changedAt)}</small>}</div>
        <a className="stock-alert-open" href={stockLink(alert)} onClick={onNavigate} aria-label={`Consultar estoque de ${alert.name}`}>Ver estoque<Icon name="arrow-right" /></a>
      </li>)}</ul>
      <div className="stock-alert-pagination"><span>{data.total} {data.total === 1 ? "produto" : "produtos"} · Página {data.page} de {Math.max(1, data.totalPages)}</span><div><button type="button" className="text-link" disabled={loading || page <= 1} onClick={() => setPage((value) => value - 1)}>Anterior</button><button type="button" className="text-link" disabled={loading || page >= data.totalPages} onClick={() => setPage((value) => value + 1)}>Próxima</button></div></div>
    </> : data && !error && <div className="stock-alert-state stock-alert-clear"><Icon name="check" /><strong>{kind ? "Nenhum produto nesta condição" : "Nenhum alerta ativo"}</strong><p>{kind ? "Escolha outra situação para ampliar a consulta." : "Os produtos ativos estão acima do mínimo definido."}</p>{kind && <button type="button" className="text-link" onClick={() => filter("")}>Ver todas as situações</button>}</div>}
    <p className="stock-alert-footnote">Os alertas refletem o saldo atual e o mínimo de cada produto. A consulta é atualizada enquanto esta página está visível.</p>
  </div>;
}
