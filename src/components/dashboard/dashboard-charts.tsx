"use client";
import { useId } from "react";
import Link from "next/link";
import type { DashboardDTO } from "../../lib/dashboard/types.ts";
import { formatCatalogDecimal, formatCatalogMoney } from "../catalog/catalog-meta";
import { chartInteger, chartPosition, dashboardDayLabel, dashboardFullDay, dashboardProductHref } from "./dashboard-meta.ts";

const integer = (value: number) => new Intl.NumberFormat("pt-BR").format(value);
function ProductLink({ id, name }: { id: string; name: string }) {
  const href = dashboardProductHref(id);
  return href ? <Link href={href} className="dashboard-product-link">{name}</Link> : <>{name}</>;
}
export function DashboardMovementChart({ data }: { data: DashboardDTO }) {
  const id = useId();
  const maximum = data.series.reduce((max, point) => {
    const entry = chartInteger(point.entriesCost); const exit = chartInteger(point.exitsCost);
    return entry > max ? entry > exit ? entry : exit : exit > max ? exit : max;
  }, 0n);
  const month = data.period.granularity === "month";
  return <section className="management-panel dashboard-chart-panel" aria-labelledby={`${id}-title`}>
    <div className="dashboard-panel-heading"><div><p className="dashboard-caption">MOVIMENTAÇÕES NO PERÍODO</p><h2 id={`${id}-title`}>Entradas e saídas</h2><p>Custo histórico bruto em reais, pela data da operação.</p></div></div>
    <div className="dashboard-chart-legend" aria-label="Legenda"><span><i className="dashboard-legend-entry" />E — Entradas</span><span><i className="dashboard-legend-exit" />S — Saídas</span></div>
    {maximum === 0n && <p className="dashboard-chart-empty">Sem custo de entradas ou saídas neste período. Consulte a tabela para conferir lançamentos com valor zero.</p>}
    <div className="dashboard-bars" tabIndex={0} role="img" aria-label="Comparação do custo histórico de entradas e saídas por intervalo. Os valores exatos estão na tabela de dados.">
      {data.series.map((point) => <div className="dashboard-bar-group" key={point.from}>
        <span className="dashboard-bar-label">{dashboardDayLabel(point.from, month)}</span>
        <div className="dashboard-bar-tracks"><div className="dashboard-bar-track"><span aria-hidden="true">E</span><i className="dashboard-bar-entry" style={{ width: `${chartPosition(chartInteger(point.entriesCost), maximum)}%` }} /></div><div className="dashboard-bar-track"><span aria-hidden="true">S</span><i className="dashboard-bar-exit" style={{ width: `${chartPosition(chartInteger(point.exitsCost), maximum)}%` }} /></div></div>
      </div>)}
    </div>
    <details className="dashboard-data-details"><summary>Ver dados de entradas e saídas</summary><div className="table-scroll"><table className="catalog-table dashboard-data-table"><caption>Custo e valor de venda históricos dos lançamentos originais, sem descontar compensações.</caption><thead><tr><th scope="col">Intervalo</th><th scope="col">Entradas</th><th scope="col">Custo das entradas</th><th scope="col">Saídas</th><th scope="col">Custo das saídas</th><th scope="col">Venda das saídas</th></tr></thead><tbody>{data.series.map((point) => <tr key={point.from}><th scope="row">{dashboardFullDay(point.from)} a {dashboardFullDay(point.to)}</th><td>{integer(point.entries)}</td><td>{formatCatalogMoney(point.entriesCost)}</td><td>{integer(point.exits)}</td><td>{formatCatalogMoney(point.exitsCost)}</td><td>{formatCatalogMoney(point.exitsSale)}</td></tr>)}</tbody></table></div></details>
  </section>;
}

export function DashboardEvolutionChart({ data }: { data: DashboardDTO }) {
  const id = useId();
  const values = data.series.map((point) => chartInteger(point.estimatedStockCost));
  const minimum = values.reduce((min, value) => value < min ? value : min, 0n);
  const maximum = values.reduce((max, value) => value > max ? value : max, 0n);
  const extent = maximum - minimum;
  const width = 760; const height = 190; const left = 20; const top = 18;
  const x = (index: number) => left + (values.length <= 1 ? width / 2 : index * width / (values.length - 1));
  const y = (value: bigint) => top + height - chartPosition(value - minimum, extent, height);
  const points = values.map((value, index) => `${x(index)},${y(value)}`).join(" ");
  const month = data.period.granularity === "month";
  const maximumIndex = values.findIndex((value) => value === maximum);
  const maximumLabel = maximumIndex < 0 ? "0.00" : data.series[maximumIndex].estimatedStockCost;
  const first = data.series[0]; const last = data.series.at(-1);
  return <section className="management-panel dashboard-chart-panel" aria-labelledby={`${id}-title`}>
    <div className="dashboard-panel-heading"><div><p className="dashboard-caption">HISTÓRICO DO ESTOQUE</p><h2 id={`${id}-title`}>Evolução do valor estimado</h2><p>Saldo e custo de aquisição registrados até o fim de cada intervalo.</p></div></div>
    <div className="dashboard-line-axis"><span>Escala do gráfico</span><strong>{formatCatalogMoney(maximumLabel)}</strong></div>
    <div className="dashboard-line-wrap"><svg className="dashboard-line-chart" viewBox="0 0 800 240" role="img" aria-labelledby={`${id}-chart-title ${id}-chart-description`}>
      <title id={`${id}-chart-title`}>Evolução do custo estimado do estoque</title><desc id={`${id}-chart-description`}>O eixo horizontal segue os intervalos do período. A linha mostra valores em reais pela data de registro, com custos históricos. Consulte os valores exatos na tabela abaixo.</desc>
      {[0, 1, 2, 3].map((line) => <line key={line} x1={left} x2={left + width} y1={top + line * height / 3} y2={top + line * height / 3} className="dashboard-line-grid" />)}
      {points && <polyline points={points} fill="none" className="dashboard-line-path" />}
      {values.map((value, index) => <circle key={data.series[index].from} cx={x(index)} cy={y(value)} r={values.length > 20 ? 2.5 : 4} className="dashboard-line-point"><title>{dashboardFullDay(data.series[index].to)}: {formatCatalogMoney(data.series[index].estimatedStockCost)}</title></circle>)}
    </svg></div>
    {first && last && <div className="dashboard-line-labels"><span>{dashboardDayLabel(first.from, month)}</span><span>{dashboardDayLabel(last.to, month)}</span></div>}
    <p className="dashboard-chart-note">A data de registro representa o que já estava registrado no sistema. Lançamentos retroativos entram nesta evolução quando são registrados.</p>
    <details className="dashboard-data-details"><summary>Ver dados da evolução do estoque</summary><div className="table-scroll"><table className="catalog-table dashboard-data-table"><caption>Custo estimado do estoque ao final de cada intervalo, pela data de registro. O intervalo atual considera o momento da consulta.</caption><thead><tr><th scope="col">Intervalo</th><th scope="col">Custo estimado do estoque</th><th scope="col">Ajustes registrados pela data da operação</th><th scope="col">Compensações pela data da operação</th></tr></thead><tbody>{data.series.map((point) => <tr key={point.from}><th scope="row">{dashboardFullDay(point.from)} a {dashboardFullDay(point.to)}</th><td>{formatCatalogMoney(point.estimatedStockCost)}</td><td>{integer(point.adjustments)}</td><td>{integer(point.compensations)}</td></tr>)}</tbody></table></div></details>
  </section>;
}

export function DashboardRankings({ data }: { data: DashboardDTO }) {
  const id = useId();
  const movedMaximum = BigInt(data.mostMoved[0]?.movements ?? 0);
  const valueMaximum = data.highestValue.reduce((max, product) => { const value = chartInteger(product.estimatedCost); return value > max ? value : max; }, 0n);
  const categoryMaximum = data.categories.reduce((max, category) => category.products > max ? category.products : max, 0);
  return <>
    <div className="dashboard-ranking-grid">
      <section className="management-panel dashboard-ranking-panel" aria-labelledby={`${id}-moved-title`}><div className="dashboard-panel-heading"><div><p className="dashboard-caption">PRODUTOS NO PERÍODO</p><h2 id={`${id}-moved-title`}>Mais movimentados</h2><p>Até dez produtos pelo número de entradas e saídas originais.</p></div></div>
        {data.mostMoved.length ? <ol className="dashboard-ranking-list">{data.mostMoved.map((product) => <li key={product.id}><div className="dashboard-ranking-heading"><div><ProductLink id={product.id} name={product.name} /><span>SKU {product.sku}</span></div><strong>{integer(product.movements)} <small>lançamentos</small></strong></div><div className="dashboard-ranking-track" aria-hidden="true"><span style={{ width: `${chartPosition(BigInt(product.movements), movedMaximum)}%` }} /></div><p>{integer(product.entries)} entradas · {integer(product.exits)} saídas · Custo das saídas: {formatCatalogMoney(product.exitCost)}</p></li>)}</ol> : <p className="dashboard-section-empty">Nenhuma entrada ou saída encontrada no período selecionado.</p>}
      </section>
      <section className="management-panel dashboard-ranking-panel" aria-labelledby={`${id}-value-title`}><div className="dashboard-panel-heading"><div><p className="dashboard-caption">VALOR DO SALDO ATUAL</p><h2 id={`${id}-value-title`}>Maior valor em estoque</h2><p>Até dez produtos pelo custo estimado do saldo atual, incluindo inativos.</p></div></div>
        {data.highestValue.length ? <ol className="dashboard-ranking-list">{data.highestValue.map((product) => <li key={product.id}><div className="dashboard-ranking-heading"><div><ProductLink id={product.id} name={product.name} /><span>SKU {product.sku}{!product.isActive && " · Inativo"}</span></div><strong>{formatCatalogMoney(product.estimatedCost)}</strong></div><div className="dashboard-ranking-track dashboard-ranking-track-value" aria-hidden="true"><span style={{ width: `${chartPosition(chartInteger(product.estimatedCost), valueMaximum)}%` }} /></div><p>{formatCatalogDecimal(product.quantity)} {product.unit} · Venda potencial: {formatCatalogMoney(product.potentialSale)}</p></li>)}</ol> : <p className="dashboard-section-empty">Não há produtos com saldo para comparar o valor atual.</p>}
      </section>
    </div>
    <section className="management-panel dashboard-category-panel" aria-labelledby={`${id}-category-title`}><div className="dashboard-panel-heading"><div><p className="dashboard-caption">CADASTRO E SALDO ATUAIS</p><h2 id={`${id}-category-title`}>Distribuição por categoria</h2><p>Quantidade de produtos cadastrados e custo estimado do saldo, incluindo inativos.</p></div></div>
      {data.categories.length ? <div className="table-scroll"><table className="catalog-table dashboard-category-table"><caption>Produtos cadastrados por categoria e valor atual do estoque.</caption><thead><tr><th scope="col">Categoria</th><th scope="col">Produtos</th><th scope="col">Distribuição por número de produtos</th><th scope="col">Custo estimado</th></tr></thead><tbody>{data.categories.map((category) => <tr key={category.id}><th scope="row">{category.name}</th><td>{integer(category.products)}</td><td><div className="dashboard-category-track" aria-hidden="true"><span style={{ width: `${chartPosition(BigInt(category.products), BigInt(categoryMaximum))}%` }} /></div></td><td>{formatCatalogMoney(category.estimatedCost)}</td></tr>)}</tbody></table></div> : <p className="dashboard-section-empty">Nenhum produto cadastrado para distribuir por categoria.</p>}
    </section>
  </>;
}
