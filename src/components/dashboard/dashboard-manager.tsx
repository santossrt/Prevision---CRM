"use client";
import { useEffect, useId, useState, type FormEvent } from "react";
import Link from "next/link";
import { Icon, type IconName } from "../ui/icon";
import { formatCatalogDecimal, formatCatalogMoney } from "../catalog/catalog-meta";
import { DashboardEvolutionChart, DashboardMovementChart, DashboardRankings } from "./dashboard-charts.tsx";
import { dashboardFullDay, dashboardPreset, dashboardQuery, dashboardTimestamp, dashboardToday, type DashboardFilter } from "./dashboard-meta.ts";
import { dashboardError } from "./dashboard-api.ts";
import { useDashboard } from "./use-dashboard.ts";

const count = (value: number) => new Intl.NumberFormat("pt-BR").format(value);
function Metric({ title, value, detail, icon, href, caution = false }: { title: string; value: string; detail: string; icon: IconName; href?: string; caution?: boolean }) {
  return <article className={`dashboard-metric${caution ? " dashboard-metric-attention" : ""}`}><div className="dashboard-metric-heading"><p>{title}</p><Icon name={icon} /></div><strong>{value}</strong><p>{detail}</p>{href && <Link href={href}>Consultar no estoque<Icon name="arrow-up-right" /></Link>}</article>;
}

export function DashboardManager({ ownerId }: { ownerId: string }) {
  const id = useId();
  const [draft, setDraft] = useState<DashboardFilter>({ from: "", to: "" });
  const [applied, setApplied] = useState<DashboardFilter>({ from: "", to: "" });
  const [query, setQuery] = useState("");
  const [ready, setReady] = useState(false);
  const [filterError, setFilterError] = useState("");
  const { data, loading, error, refresh } = useDashboard(ownerId, query, ready);
  useEffect(() => {
    const period = dashboardPreset(30);
    setDraft(period); setApplied(period); setQuery(dashboardQuery(period)); setReady(true);
  }, []);
  function selectPeriod(period: DashboardFilter) {
    try {
      const next = dashboardQuery(period);
      setDraft(period); setApplied(period); setFilterError("");
      if (query === next) refresh(); else setQuery(next);
    } catch (failure) { setFilterError(dashboardError(failure)); }
  }
  function apply(event: FormEvent<HTMLFormElement>) { event.preventDefault(); selectPeriod(draft); }
  const draftChanged = draft.from !== applied.from || draft.to !== applied.to;
  return <section className="dashboard-manager" aria-label="Indicadores de estoque">
    <form className="dashboard-filter management-panel" onSubmit={apply} aria-label="Período dos indicadores"><div className="dashboard-filter-intro"><span className="dashboard-filter-icon"><Icon name="chart" /></span><div><h2>Seu período de análise</h2><p>Datas em Brasília · America/Sao_Paulo</p></div></div><div className="dashboard-date-field"><label htmlFor={`${id}-from`}>De</label><input id={`${id}-from`} type="date" required max={ready ? dashboardToday() : undefined} value={draft.from} onChange={(event) => setDraft((current) => ({ ...current, from: event.target.value }))} /></div><div className="dashboard-date-field"><label htmlFor={`${id}-to`}>Até</label><input id={`${id}-to`} type="date" required max={ready ? dashboardToday() : undefined} value={draft.to} onChange={(event) => setDraft((current) => ({ ...current, to: event.target.value }))} /></div><button className="button-primary" type="submit" disabled={!ready}>Consultar<Icon name="arrow-right" /></button><div className="dashboard-filter-presets" aria-label="Períodos rápidos">{([30, 90, 365] as const).map((days) => <button type="button" key={days} className="button-secondary" disabled={!ready} onClick={() => selectPeriod(dashboardPreset(days))}>Últimos {days} dias</button>)}<button className="text-link" type="button" disabled={!ready || loading} onClick={refresh}>Atualizar consulta</button></div><p className="dashboard-filter-hint">Até 366 dias. {draftChanged ? "Consulte para aplicar o período alterado." : "O período altera os movimentos e a evolução; o saldo atual continua representando o momento da consulta."}</p></form>
    {filterError && <p className="form-message form-error" role="alert">{filterError}</p>}
    {error && <div className="form-message form-error dashboard-error" role="alert"><p>{error}</p>{data && <p>Os números abaixo pertencem à última consulta concluída; ainda não foram atualizados.</p>}<button className="text-link" type="button" onClick={refresh}>Tentar novamente</button></div>}
    {loading && <p className="dashboard-loading" role="status"><span className="catalog-loader" />{data ? "Atualizando os indicadores…" : "Consultando o estoque e seu histórico…"}</p>}
    {data && <div className="dashboard-results" aria-busy={loading}>
      <div className="dashboard-section-heading"><div><p className="eyebrow">SALDO ATUAL</p><h2>O estoque de agora<span>.</span></h2><p>Todos os produtos, inclusive inativos. Alertas consideram somente produtos ativos.</p></div><p className="dashboard-generated">Consulta em {dashboardTimestamp(data.generatedAt)}<span>Horário de Brasília</span></p></div>
      {data.current.products === 0 && <div className="dashboard-first-state"><Icon name="package" /><div><strong>Seu painel começa com os produtos</strong><p>Os indicadores ainda estão zerados. Cadastre produtos e registre as primeiras operações para acompanhar a evolução real do estoque.</p></div><Link href="/estoque" className="text-link">Consultar estoque<Icon name="arrow-right" /></Link></div>}
      <div className="dashboard-metric-grid">
        <Metric title="Produtos cadastrados" value={count(data.current.products)} detail={`${count(data.current.activeProducts)} ativos · ${count(data.current.inactiveProducts)} inativos`} icon="package" />
        <Metric title="Custo estimado do saldo" value={formatCatalogMoney(data.current.estimatedCost)} detail="Saldo atual × custo de aquisição atual, por produto." icon="layers" />
        <Metric title="Venda potencial" value={formatCatalogMoney(data.current.potentialSale)} detail="Estimativa pelo preço de venda atual dos produtos." icon="chart" />
        <Metric title="Margem estimada do saldo" value={formatCatalogMoney(data.current.estimatedMargin)} detail="Venda potencial menos custo estimado. Não representa lucro realizado." icon="forecast" />
        <Metric title="Estoque baixo" value={count(data.current.lowStock)} detail="Produtos ativos com saldo positivo até o mínimo." icon="package" href="/estoque?stock=low" caution={data.current.lowStock > 0} />
        <Metric title="Produtos sem estoque" value={count(data.current.emptyStock)} detail="Produtos ativos com saldo igual a zero." icon="package" href="/estoque?stock=empty" caution={data.current.emptyStock > 0} />
      </div>
      <div className="dashboard-section-heading dashboard-period-heading"><div><p className="eyebrow">MOVIMENTAÇÕES DO PERÍODO</p><h2>O que entrou e saiu<span>.</span></h2><p>{dashboardFullDay(data.period.from)} a {dashboardFullDay(data.period.to)} · pela data da operação</p></div><span className="dashboard-aggregation">Agrupamento {data.period.granularity === "day" ? "diário" : "mensal"}</span></div>
      <div className="dashboard-movement-metrics"><article><span>Entradas originais</span><strong>{count(data.movements.entries)} <small>lançamentos</small></strong><p>Custo histórico: {formatCatalogMoney(data.movements.entriesCost)}</p></article><article><span>Saídas originais</span><strong>{count(data.movements.exits)} <small>lançamentos</small></strong><p>Custo histórico: {formatCatalogMoney(data.movements.exitsCost)}<br />Venda histórica: {formatCatalogMoney(data.movements.exitsSale)}</p></article><article><span>Ajustes</span><strong>{count(data.movements.adjustments)} <small>lançamentos</small></strong><p>Ajustes positivos e negativos registrados no período.</p></article><article><span>Compensações</span><strong>{count(data.movements.compensations)} <small>lançamentos</small></strong><p>Apresentadas separadamente, sem apagar os lançamentos originais.</p></article></div>
      <div className="dashboard-chart-grid"><DashboardMovementChart data={data} /><DashboardEvolutionChart data={data} /></div>
      <section className="management-panel dashboard-units-panel" aria-labelledby={`${id}-units-title`}><div className="dashboard-panel-heading"><div><p className="dashboard-caption">QUANTIDADES DO PERÍODO</p><h2 id={`${id}-units-title`}>Cada unidade, separadamente</h2><p>Quantidades agrupadas pela unidade atual do cadastro. Quilos, litros e unidades não são somados entre si.</p></div></div>{data.units.length ? <div className="table-scroll"><table className="catalog-table dashboard-units-table"><caption>Quantidades de entradas, saídas, ajustes e compensações pela data da operação e unidade atual do produto.</caption><thead><tr><th scope="col">Unidade atual</th><th scope="col">Entradas brutas</th><th scope="col">Saídas brutas</th><th scope="col">Variação dos ajustes</th><th scope="col">Variação das compensações</th></tr></thead><tbody>{data.units.map((unit) => <tr key={unit.unit}><th scope="row">{unit.unit}</th><td>{formatCatalogDecimal(unit.entryQuantity)}</td><td>{formatCatalogDecimal(unit.exitQuantity)}</td><td>{formatCatalogDecimal(unit.adjustmentDelta)}</td><td>{formatCatalogDecimal(unit.compensationDelta)}</td></tr>)}</tbody></table></div> : <p className="dashboard-section-empty">Nenhuma movimentação no período para agrupar por unidade.</p>}</section>
      <DashboardRankings data={data} />
      <section className="dashboard-method-note" aria-labelledby={`${id}-method-title`}><Icon name="shield" /><div><h2 id={`${id}-method-title`}>Como ler os números</h2><ul>{data.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div></section>
    </div>}
  </section>;
}
