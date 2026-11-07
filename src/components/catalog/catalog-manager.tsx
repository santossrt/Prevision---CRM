"use client";

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import Link from "next/link";
import type { CatalogKind, CatalogList, CatalogOptions, CatalogStatus, ProductDTO } from "@/lib/catalog/types";
import { Icon } from "@/components/ui/icon";
import { CatalogEditor } from "./catalog-editor";
import { CatalogModal } from "./catalog-modal";
import { CatalogProductDetail } from "./catalog-product-detail";
import { CatalogRequestError, catalogError, catalogRequest, isCancelled } from "./catalog-api";
import { catalogMeta, formatCatalogDecimal, formatCatalogMoney, type CatalogItem } from "./catalog-meta";

type Dialog = { mode: "create"; barcode?: string } | { mode: "edit" | "status"; item: CatalogItem } | { mode: "detail"; item: ProductDTO };

function StatusConfirmation({ kind, item, onClose, onSaved, onReload }: { kind: CatalogKind; item: CatalogItem; onClose: () => void; onSaved: (message: string) => void; onReload: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  async function confirm() {
    setBusy(true); setError("");
    try {
      const result = await catalogRequest<{ item: CatalogItem; message: string }>(`/api/catalog/${kind}/${encodeURIComponent(item.id)}`, { method: "PATCH", body: { isActive: !item.isActive, expectedVersion: item.version } });
      onSaved(result.message || "Situação atualizada.");
    } catch (failure) { setError(catalogError(failure)); setConflict(failure instanceof CatalogRequestError && failure.status === 409); }
    finally { setBusy(false); }
  }
  return <CatalogModal title={`${item.isActive ? "Inativar" : "Reativar"} ${catalogMeta[kind].singular}`} caption="SITUAÇÃO DO CADASTRO" onClose={onClose} busy={busy}><p className="dialog-description">{item.isActive ? <>Deseja inativar <strong>{item.name}</strong>? O cadastro e suas referências serão preservados.</> : <>Deseja reativar <strong>{item.name}</strong> para voltar a utilizá-lo nos cadastros?</>}</p>{kind === "categories" || kind === "suppliers" ? <p className="catalog-confirm-note">Os produtos já associados permanecem vinculados a este cadastro.</p> : null}{error && <div className="form-message form-error" role="alert"><p>{error}</p>{conflict && <button type="button" className="text-link" disabled={busy} onClick={onReload}>Consultar versão atual</button>}</div>}<div className="dialog-actions"><button type="button" className="button-secondary" disabled={busy} onClick={onClose}>Cancelar</button><button type="button" className="button-primary" disabled={busy} onClick={() => void confirm()}>{busy ? "Salvando…" : item.isActive ? "Confirmar inativação" : "Confirmar reativação"}</button></div></CatalogModal>;
}

export function CatalogManager({ kind, canWrite, initialBarcode }: { kind: CatalogKind; canWrite: boolean; initialBarcode?: string }) {
  const meta = catalogMeta[kind];
  const prefix = useId();
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [status, setStatus] = useState<CatalogStatus>("active");
  const [categoryId, setCategoryId] = useState("");
  const [supplierId, setSupplierId] = useState("");
  const [stock, setStock] = useState("all");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<CatalogList<CatalogItem> | null>(null);
  const [options, setOptions] = useState<CatalogOptions | null>(null);
  const [optionsError, setOptionsError] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [dialog, setDialog] = useState<Dialog | null>(() => kind === "products" && canWrite && initialBarcode ? { mode: "create", barcode: initialBarcode } : null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!initialBarcode) return;
    const url = new URL(window.location.href);
    url.searchParams.delete("barcode");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }, [initialBarcode]);

  useEffect(() => { const timeout = setTimeout(() => { setDebouncedSearch(search.trim()); setPage(1); }, 300); return () => clearTimeout(timeout); }, [search]);
  const query = useMemo(() => {
    const values = new URLSearchParams({ status, page: String(page), pageSize: "20" });
    if (debouncedSearch) values.set("search", debouncedSearch);
    if (kind === "products") {
      if (categoryId) values.set("categoryId", categoryId);
      if (supplierId) values.set("supplierId", supplierId);
      values.set("stock", stock);
    }
    return values.toString();
  }, [status, page, debouncedSearch, kind, categoryId, supplierId, stock]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
    void catalogRequest<CatalogList<CatalogItem>>(`/api/catalog/${kind}?${query}`, { signal: controller.signal }).then((result) => {
      setData(result);
      if (result.totalPages > 0 && page > result.totalPages) setPage(result.totalPages);
    }).catch((failure: unknown) => { if (!isCancelled(failure)) setError(catalogError(failure)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [kind, query, page, revision]);

  useEffect(() => {
    if (kind !== "products") return;
    const controller = new AbortController();
    setOptionsError("");
    void catalogRequest<CatalogOptions>("/api/catalog/options", { signal: controller.signal }).then(setOptions)
      .catch((failure: unknown) => { if (!isCancelled(failure)) setOptionsError(catalogError(failure)); });
    return () => controller.abort();
  }, [kind, revision]);

  const reload = useCallback(() => setRevision((current) => current + 1), []);
  async function openRecord(item: CatalogItem, mode: "edit" | "status") {
    setOpeningId(item.id); setError(""); setNotice("");
    try {
      const result = await catalogRequest<{ item: CatalogItem }>(`/api/catalog/${kind}/${encodeURIComponent(item.id)}`);
      setDialog({ mode, item: result.item });
    } catch (failure) { setError(catalogError(failure)); }
    finally { setOpeningId(null); }
  }
  function saved(message: string) {
    setDialog(null); setNotice(message); setError(""); reload();
    if (kind === "products") window.dispatchEvent(new Event("prevision:stock-changed"));
  }
  function clearFilters() { setSearch(""); setDebouncedSearch(""); setStatus("active"); setCategoryId(""); setSupplierId(""); setStock("all"); setPage(1); }
  const hasFilters = Boolean(debouncedSearch || status !== "active" || categoryId || supplierId || stock !== "all");
  const showProduct = kind === "products";
  const hasActiveCategory = options?.categories.some((entry) => entry.isActive) ?? false;
  const addingDisabled = loading || !!openingId || (showProduct && (!options || !hasActiveCategory));

  return <>
    <div className="catalog-toolbar"><div className="catalog-search"><label htmlFor={`${prefix}-search`} className="sr-only">{meta.search}</label><input id={`${prefix}-search`} type="search" value={search} maxLength={100} placeholder={meta.search} onChange={(event) => setSearch(event.target.value)} /></div>{canWrite && <button type="button" className="button-primary" disabled={addingDisabled} onClick={() => { setNotice(""); setDialog({ mode: "create" }); }}>Adicionar {meta.singular}<Icon name={meta.icon} /></button>}</div>
    <div className="catalog-filters"><div><label htmlFor={`${prefix}-status`}>Situação</label><select id={`${prefix}-status`} value={status} onChange={(event) => { setStatus(event.target.value as CatalogStatus); setPage(1); }}><option value="active">Ativos</option><option value="inactive">Inativos</option><option value="all">Todos</option></select></div>{showProduct && <><div><label htmlFor={`${prefix}-category`}>Categoria</label><select id={`${prefix}-category`} value={categoryId} disabled={!options} onChange={(event) => { setCategoryId(event.target.value); setPage(1); }}><option value="">Todas as categorias</option>{options?.categories.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}{entry.isActive ? "" : " (inativa)"}</option>)}</select></div><div><label htmlFor={`${prefix}-supplier`}>Fornecedor</label><select id={`${prefix}-supplier`} value={supplierId} disabled={!options} onChange={(event) => { setSupplierId(event.target.value); setPage(1); }}><option value="">Todos os fornecedores</option>{options?.suppliers.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}{entry.isActive ? "" : " (inativo)"}</option>)}</select></div><div><label htmlFor={`${prefix}-stock`}>Estoque</label><select id={`${prefix}-stock`} value={stock} onChange={(event) => { setStock(event.target.value); setPage(1); }}><option value="all">Todas as situações</option><option value="normal">Acima do mínimo</option><option value="low">Estoque baixo</option><option value="empty">Sem estoque</option></select></div></>}{hasFilters && <button className="text-link catalog-clear" type="button" onClick={clearFilters}>Limpar filtros</button>}</div>
    {notice && <p className="form-message form-success catalog-notice" role="status">{notice}</p>}
    {error && <div className="form-message form-error catalog-notice" role="alert"><p>{error}</p><button type="button" className="text-link" onClick={reload} disabled={loading}>Consultar novamente</button></div>}
    {optionsError && <div className="form-message form-error catalog-notice" role="alert"><p>Não foi possível carregar as categorias e os fornecedores. {optionsError}</p><button type="button" className="text-link" onClick={reload} disabled={loading}>Tentar novamente</button></div>}
    {showProduct && options && !hasActiveCategory && canWrite && <div className="catalog-prerequisite"><Icon name="layers" /><p>Ative ou cadastre uma categoria para começar a organizar seus produtos.</p><Link href="/categorias" className="text-link">Gerenciar categorias<Icon name="arrow-right" /></Link></div>}
    <section className="management-panel catalog-panel" aria-labelledby={`${prefix}-list-title`} aria-busy={loading}><div className="panel-heading"><div><h2 id={`${prefix}-list-title`}>{meta.title} do seu ambiente</h2><p>{loading ? "Consultando os cadastros…" : "Informações compartilhadas com a equipe autorizada."}</p></div>{data && <span className="count-badge">{data.total} {data.total === 1 ? meta.singular : meta.title.toLocaleLowerCase("pt-BR")}</span>}</div>
      {loading && !data ? <div className="table-state" role="status"><span className="catalog-loader" /><p>Carregando {meta.title.toLocaleLowerCase("pt-BR")}…</p></div> : data?.items.length ? <div className={`table-scroll${loading ? " catalog-table-refreshing" : ""}`}><table className={`catalog-table${showProduct ? " catalog-products-table" : ""}`}><thead><tr>{showProduct ? <><th scope="col">Produto / SKU</th><th scope="col">Categoria</th><th scope="col">Quantidade</th><th scope="col">Custo / Venda</th></> : <><th scope="col">{kind === "categories" ? "Categoria" : "Nome / Documento"}</th><th scope="col">{kind === "categories" ? "Descrição" : "Contato"}</th>{kind === "suppliers" && <th scope="col">Reposição</th>}</>}<th scope="col">Situação</th><th scope="col"><span className="sr-only">Ações</span></th></tr></thead><tbody>{data.items.map((item) => {
        const product = "sku" in item ? item : null;
        const party = "taxId" in item ? item : null;
        return <tr key={item.id}>{product ? <><td><div className="catalog-name-cell"><button className="catalog-record-link" type="button" onClick={() => setDialog({ mode: "detail", item: product })} disabled={loading}>{product.name}</button><span className="catalog-sku">{product.sku}</span>{product.barcode && <span>Cód. {product.barcode}</span>}</div></td><td><div className="catalog-contact-cell"><span>{product.category.name}</span>{!product.category.isActive && <small>Categoria inativa</small>}</div></td><td><div className="catalog-quantity"><strong>{formatCatalogDecimal(product.quantity)} <small>{product.unitOfMeasure}</small></strong><span className={`catalog-stock-status stock-${product.stockStatus}`}>{product.stockStatus === "empty" ? "Sem estoque" : product.stockStatus === "low" ? "Estoque baixo" : "Acima do mínimo"}</span></div></td><td><div className="catalog-contact-cell"><span>{formatCatalogMoney(product.acquisitionCost)}</span><small>Venda: {formatCatalogMoney(product.salePrice)}</small></div></td></> : <><td><div className="catalog-name-cell"><strong>{item.name}</strong>{party?.taxId && <span>{party.taxId}</span>}</div></td><td>{party ? <div className="catalog-contact-cell"><span>{party.email || "E-mail não informado"}</span><small>{party.phone || "Telefone não informado"}</small></div> : <span className="catalog-description-cell">{"description" in item ? item.description || "Sem descrição" : ""}</span>}</td>{kind === "suppliers" && <td>{"replenishmentLeadTimeDays" in item && item.replenishmentLeadTimeDays !== null ? `${item.replenishmentLeadTimeDays} dias` : "Não informado"}</td>}</>}<td><span className={`status-pill ${item.isActive ? "status-active" : "status-inactive"}`}><span />{item.isActive ? "Ativo" : "Inativo"}</span></td><td><div className="row-actions">{canWrite ? <><button type="button" className="text-link" disabled={loading || !!openingId} onClick={() => void openRecord(item, "edit")} aria-label={`Editar ${item.name}`}>{openingId === item.id ? "Consultando…" : "Editar"}</button><button type="button" className="text-link" disabled={loading || !!openingId} onClick={() => void openRecord(item, "status")} aria-label={`${item.isActive ? "Inativar" : "Reativar"} ${item.name}`}>{item.isActive ? "Inativar" : "Reativar"}</button></> : product ? <button type="button" className="text-link" disabled={loading} onClick={() => setDialog({ mode: "detail", item: product })}>Consultar</button> : <span className="catalog-readonly-label">Consulta</span>}</div></td></tr>;
      })}</tbody></table></div> : !loading && !error ? <div className="table-state"><Icon name={meta.icon} /><strong>{hasFilters ? "Nenhum cadastro encontrado" : `Ainda não há ${meta.title.toLocaleLowerCase("pt-BR")} para exibir`}</strong><p>{hasFilters ? "Tente outros termos ou ajuste os filtros da consulta." : `Adicione ${kind === "categories" ? "uma categoria" : `um ${meta.singular}`} para começar.`}</p>{hasFilters && <button type="button" className="text-link" onClick={clearFilters}>Limpar filtros</button>}</div> : !loading && !data ? <p className="table-state">A consulta não está disponível no momento.</p> : null}
      {data && data.total > 0 && <div className="catalog-pagination"><span>{(data.page - 1) * data.pageSize + 1}–{Math.min(data.page * data.pageSize, data.total)} de {data.total} registros</span><div><button type="button" className="button-secondary" disabled={loading || page <= 1} onClick={() => setPage((current) => current - 1)}>Anterior</button><span>Página {data.page} de {Math.max(1, data.totalPages)}</span><button type="button" className="button-secondary" disabled={loading || page >= data.totalPages} onClick={() => setPage((current) => current + 1)}>Próxima</button></div></div>}
    </section>
    <p className="management-footnote"><Icon name="shield" />{canWrite ? "As alterações são registradas com o usuário responsável. Inativar preserva o cadastro e suas referências." : "Você pode consultar estes cadastros. Alterações exigem permissão de edição."}</p>
    {dialog?.mode === "create" && <CatalogEditor kind={kind} initialBarcode={dialog.barcode} options={options} onClose={() => setDialog(null)} onSaved={saved} onReload={reload} />}
    {dialog?.mode === "edit" && <CatalogEditor key={`${dialog.item.id}:${dialog.item.version}`} kind={kind} item={dialog.item} options={options} onClose={() => setDialog(null)} onSaved={saved} onReload={() => void openRecord(dialog.item, "edit")} />}
    {dialog?.mode === "status" && <StatusConfirmation key={`${dialog.item.id}:${dialog.item.version}`} kind={kind} item={dialog.item} onClose={() => setDialog(null)} onSaved={saved} onReload={() => void openRecord(dialog.item, "status")} />}
    {dialog?.mode === "detail" && <CatalogProductDetail initial={dialog.item} canWrite={canWrite} onClose={() => setDialog(null)} onEdit={(item) => void openRecord(item, "edit")} />}
  </>;
}
