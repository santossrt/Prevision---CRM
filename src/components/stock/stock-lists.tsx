"use client";
import { useEffect, useId, useState } from "react";
import type { MovementType, StockBalances, StockList, StockMovementDTO, StockOptions, StockProductDTO } from "@/lib/stock/types";
import { Icon } from "@/components/ui/icon";
import { isCancelled, stockError, stockRequest } from "./stock-api";
import { date, decimal, money, movementLabels } from "./stock-format";

function Pagination({ data, loading, setPage }: { data: StockList<unknown>; loading: boolean; setPage: (page: number) => void }) {
  if (!data.total) return null;
  return <div className="catalog-pagination"><span>{(data.page - 1) * data.pageSize + 1}–{Math.min(data.page * data.pageSize, data.total)} de {data.total} registros</span><div><button type="button" className="button-secondary" disabled={loading || data.page <= 1} onClick={() => setPage(data.page - 1)}>Anterior</button><span>Página {data.page} de {Math.max(1, data.totalPages)}</span><button type="button" className="button-secondary" disabled={loading || data.page >= data.totalPages} onClick={() => setPage(data.page + 1)}>Próxima</button></div></div>;
}

export function StockBalancesList({ options, revision, canMove, onCreate, onHistory, initialSearch = "", initialStock = "all" }: {
  options: StockOptions | null; revision: number; canMove: boolean; onCreate: (product: StockProductDTO) => void; onHistory: (product: StockProductDTO) => void;
  initialSearch?: string; initialStock?: "all" | "normal" | "low" | "empty";
}) {
  const id = useId();
  const [search, setSearch] = useState(initialSearch);
  const [term, setTerm] = useState(initialSearch);
  const [status, setStatus] = useState("all");
  const [categoryId, setCategoryId] = useState("");
  const [stock, setStock] = useState<string>(initialStock);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<StockBalances | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => { const timer = setTimeout(() => { setTerm(search.trim()); setPage(1); }, 300); return () => clearTimeout(timer); }, [search]);
  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ status, stock, page: String(page), pageSize: "20" });
    if (term) query.set("search", term);
    if (categoryId) query.set("categoryId", categoryId);
    setLoading(true); setData(null); setError("");
    void stockRequest<StockBalances>(`/api/stock/balances?${query}`, { signal: controller.signal }).then((result) => { setData(result); if (result.totalPages && page > result.totalPages) setPage(result.totalPages); })
      .catch((failure) => { if (!isCancelled(failure)) setError(stockError(failure)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [term, status, categoryId, stock, page, revision, retry]);
  const filtered = !!term || status !== "all" || categoryId !== "" || stock !== "all";
  function clear() { setSearch(""); setTerm(""); setStatus("all"); setCategoryId(""); setStock("all"); setPage(1); }
  return <>
    <div className="stock-summary" aria-label="Valores estimados do estoque consultado"><div><span>Produtos na consulta</span><strong>{data ? data.summary.products : "—"}</strong><small>Todos os resultados dos filtros</small></div><div><span>Custo estimado do estoque</span><strong>{data ? money(data.summary.estimatedCost) : "—"}</strong><small>Saldo × custo atual do cadastro</small></div><div><span>Venda potencial</span><strong>{data ? money(data.summary.potentialSale) : "—"}</strong><small>Saldo × preço atual do cadastro</small></div><div><span>Margem potencial estimada</span><strong>{data ? money(data.summary.estimatedMargin) : "—"}</strong><small>Venda potencial − custo estimado</small></div></div>
    <p className="stock-summary-note">As estimativas abrangem todos os produtos dos filtros, além desta página. Não incluem despesas, impostos ou garantias de venda. Os valores praticados em cada operação ficam no histórico.</p>
    <div className="catalog-toolbar"><div className="catalog-search"><label className="sr-only" htmlFor={`${id}-search`}>Pesquisar produtos no estoque</label><input id={`${id}-search`} type="search" placeholder="Nome, SKU ou código de barras" value={search} maxLength={100} onChange={(event) => setSearch(event.target.value)} /></div></div>
    <div className="catalog-filters"><div><label htmlFor={`${id}-status`}>Situação do produto</label><select id={`${id}-status`} value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }}><option value="all">Todos os produtos</option><option value="active">Ativos</option><option value="inactive">Inativos</option></select></div><div><label htmlFor={`${id}-category`}>Categoria</label><select id={`${id}-category`} value={categoryId} disabled={!options} onChange={(event) => { setCategoryId(event.target.value); setPage(1); }}><option value="">Todas as categorias</option>{options?.categories.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></div><div><label htmlFor={`${id}-stock`}>Quantidade disponível</label><select id={`${id}-stock`} value={stock} onChange={(event) => { setStock(event.target.value); setPage(1); }}><option value="all">Todas as situações</option><option value="normal">Acima do mínimo</option><option value="low">Estoque baixo</option><option value="empty">Sem estoque</option></select></div>{filtered && <button className="text-link catalog-clear" type="button" onClick={clear}>Limpar filtros</button>}</div>
    {error && <div className="form-message form-error catalog-notice" role="alert"><p>{error}</p><button type="button" className="text-link" onClick={() => setRetry((value) => value + 1)}>Consultar novamente</button></div>}
    <section className="management-panel catalog-panel" aria-labelledby={`${id}-title`} aria-busy={loading}><div className="panel-heading"><div><h2 id={`${id}-title`}>Saldo atual</h2><p>Um único estoque compartilhado pela equipe.</p></div>{data && <span className="count-badge">{data.total} produtos</span>}</div>
      {loading ? <div className="table-state" role="status"><span className="catalog-loader" /><p>Consultando o estoque…</p></div> : data?.items.length ? <div className="table-scroll"><table className="catalog-table stock-balance-table"><thead><tr><th scope="col">Produto / SKU</th><th scope="col">Categoria</th><th scope="col">Saldo atual</th><th scope="col">Custo / Venda unitários</th><th scope="col">Custo / Venda do saldo</th><th scope="col"><span className="sr-only">Ações</span></th></tr></thead><tbody>{data.items.map((item) => <tr key={item.id}><td><div className="catalog-name-cell"><strong>{item.name}</strong><span className="catalog-sku">{item.sku}</span>{!item.isActive && <span className="stock-inactive-label">Produto inativo</span>}</div></td><td>{item.category.name}{!item.category.isActive && <span className="stock-muted-block">Categoria inativa</span>}</td><td><div className="catalog-quantity"><strong>{decimal(item.quantity)} <small>{item.unitOfMeasure}</small></strong><span className={`catalog-stock-status stock-${item.stockStatus}`}>{item.stockStatus === "empty" ? "Sem estoque" : item.stockStatus === "low" ? "Estoque baixo" : "Acima do mínimo"}</span><small>Mínimo: {decimal(item.minimumStock)}</small></div></td><td><div className="catalog-contact-cell"><span>{money(item.acquisitionCost)}</span><small>Venda: {money(item.salePrice)}</small></div></td><td><div className="catalog-contact-cell"><span>{money(item.estimatedCost)}</span><small>Venda: {money(item.potentialSale)}</small></div></td><td><div className="row-actions stock-row-actions"><button type="button" className="text-link" onClick={() => onHistory(item)}>Histórico</button>{canMove && item.isActive && <button type="button" className="text-link" onClick={() => onCreate(item)}>Movimentar</button>}</div></td></tr>)}</tbody></table></div> : !error && <div className="table-state"><Icon name="package" /><strong>{filtered ? "Nenhum produto encontrado" : "Seu estoque ainda não tem produtos"}</strong><p>{filtered ? "Ajuste os filtros para ampliar a consulta." : "Cadastre um produto para começar a registrar suas movimentações."}</p>{filtered && <button className="text-link" type="button" onClick={clear}>Limpar filtros</button>}</div>}
      {data && <Pagination data={data} loading={loading} setPage={setPage} />}
    </section>
  </>;
}

export function StockHistoryList({ revision, product, onClearProduct, onOpen }: {
  revision: number; product: { id: string; name: string } | null; onClearProduct: () => void; onOpen: (id: string) => void;
}) {
  const id = useId();
  const [search, setSearch] = useState("");
  const [term, setTerm] = useState("");
  const [type, setType] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<StockList<StockMovementDTO> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => { const timer = setTimeout(() => { setTerm(search.trim()); setPage(1); }, 300); return () => clearTimeout(timer); }, [search]);
  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ page: String(page), pageSize: "20" });
    setData(null); setError("");
    if (from && to && from > to) { setError("A data inicial deve ser anterior ou igual à data final."); setLoading(false); return () => controller.abort(); }
    if (term) query.set("search", term);
    if (product) query.set("productId", product.id);
    if (type) query.set("type", type);
    if (from) query.set("from", new Date(`${from}T00:00:00`).toISOString());
    if (to) query.set("to", new Date(`${to}T23:59:59.999`).toISOString());
    setLoading(true);
    void stockRequest<StockList<StockMovementDTO>>(`/api/stock/movements?${query}`, { signal: controller.signal }).then((result) => { setData(result); if (result.totalPages && page > result.totalPages) setPage(result.totalPages); })
      .catch((failure) => { if (!isCancelled(failure)) setError(stockError(failure)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [term, product, type, from, to, page, revision, retry]);
  const filtered = !!term || !!product || !!type || !!from || !!to;
  function clear() { setSearch(""); setTerm(""); setType(""); setFrom(""); setTo(""); setPage(1); onClearProduct(); }
  return <>
    <div className="catalog-toolbar"><div className="catalog-search"><label htmlFor={`${id}-search`} className="sr-only">Pesquisar produto no histórico</label><input id={`${id}-search`} type="search" placeholder="Pesquisar por produto ou SKU" maxLength={100} value={search} onChange={(event) => setSearch(event.target.value)} /></div></div>
    {product && <div className="stock-filter-chip"><span>Produto: <strong>{product.name}</strong></span><button type="button" className="text-link" onClick={onClearProduct}>Remover filtro</button></div>}
    <div className="catalog-filters"><div><label htmlFor={`${id}-type`}>Tipo</label><select id={`${id}-type`} value={type} onChange={(event) => { setType(event.target.value); setPage(1); }}><option value="">Todas as movimentações</option>{(Object.keys(movementLabels) as MovementType[]).map((key) => <option key={key} value={key}>{movementLabels[key]}</option>)}</select></div><div><label htmlFor={`${id}-from`}>De</label><input id={`${id}-from`} type="date" value={from} onChange={(event) => { setFrom(event.target.value); setPage(1); }} /></div><div><label htmlFor={`${id}-to`}>Até</label><input id={`${id}-to`} type="date" value={to} onChange={(event) => { setTo(event.target.value); setPage(1); }} /></div>{filtered && <button type="button" className="text-link catalog-clear" onClick={clear}>Limpar filtros</button>}</div>
    <p className="stock-summary-note">O período considera a data da operação, no horário local deste dispositivo. As movimentações permanecem registradas; correções geram uma compensação vinculada.</p>
    {error && <div className="form-message form-error catalog-notice" role="alert"><p>{error}</p><button type="button" className="text-link" onClick={() => setRetry((value) => value + 1)}>Consultar novamente</button></div>}
    <section className="management-panel catalog-panel" aria-labelledby={`${id}-title`} aria-busy={loading}><div className="panel-heading"><div><h2 id={`${id}-title`}>Histórico de movimentações</h2><p>Quantidades, valores e responsáveis preservados por operação.</p></div>{data && <span className="count-badge">{data.total} registros</span>}</div>
      {loading ? <div className="table-state" role="status"><span className="catalog-loader" /><p>Consultando o histórico…</p></div> : data?.items.length ? <div className="table-scroll"><table className="catalog-table stock-history-table"><thead><tr><th scope="col">Data / Responsável</th><th scope="col">Produto / Tipo</th><th scope="col">Variação / Saldo</th><th scope="col">Valores históricos</th><th scope="col"><span className="sr-only">Ações</span></th></tr></thead><tbody>{data.items.map((item) => <tr key={item.id}><td><div className="catalog-contact-cell"><span>{date(item.occurredAt)}</span><small>{item.performedBy.name || "Usuário cadastrado"}</small></div></td><td><div className="catalog-name-cell"><button type="button" className="catalog-record-link" onClick={() => onOpen(item.id)}>{item.product.name}</button><span>{item.product.sku} · {movementLabels[item.type]}</span>{item.compensationId && <span className="stock-muted-block">Possui compensação</span>}</div></td><td><div className="catalog-quantity"><strong className={item.quantityDelta.startsWith("-") ? "stock-decrease" : "stock-increase"}>{item.quantityDelta.startsWith("-") ? "" : "+"}{decimal(item.quantityDelta)} <small>{item.product.unitOfMeasure}</small></strong><small>{decimal(item.quantityBefore)} → {decimal(item.quantityAfter)}</small></div></td><td><div className="catalog-contact-cell"><span>Custo: {money(item.historicalTotalCost)}</span>{item.historicalTotalPrice !== null && <small>Venda: {money(item.historicalTotalPrice)}</small>}</div></td><td><button type="button" className="text-link" onClick={() => onOpen(item.id)} aria-label={`Consultar ${movementLabels[item.type].toLocaleLowerCase("pt-BR")} de ${item.product.name}`}>Detalhes</button></td></tr>)}</tbody></table></div> : !error && <div className="table-state"><Icon name="movement" /><strong>{filtered ? "Nenhuma movimentação encontrada" : "O histórico começa no primeiro lançamento"}</strong><p>{filtered ? "Ajuste o período, o produto ou o tipo da consulta." : "As entradas, saídas e correções confirmadas aparecerão aqui."}</p></div>}
      {data && <Pagination data={data} loading={loading} setPage={setPage} />}
    </section>
  </>;
}
