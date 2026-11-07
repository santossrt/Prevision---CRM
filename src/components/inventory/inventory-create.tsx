"use client";

import { useEffect, useId, useState, type FormEvent } from "react";
import Link from "next/link";
import type { CreateInventoryInput } from "@/lib/inventory/types";
import type { StockBalances, StockOptions, StockProductDTO } from "@/lib/stock/types";
import { CatalogModal } from "@/components/catalog/catalog-modal";
import { inventoryError, inventoryRequest, isCancelled, type InventoryIntent } from "./inventory-api";
import { decimal } from "./inventory-format";

function InventoryProductSelection({ selected, onChange }: { selected: Map<string, string>; onChange: (next: Map<string, string>) => void }) {
  const id = useId();
  const [search, setSearch] = useState("");
  const [term, setTerm] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<StockBalances | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => { const timer = setTimeout(() => { setTerm(search.trim()); setPage(1); }, 250); return () => clearTimeout(timer); }, [search]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
    const query = new URLSearchParams({ status: "active", page: String(page), pageSize: "10" });
    if (term) query.set("search", term);
    void inventoryRequest<StockBalances>(`/api/stock/balances?${query}`, { signal: controller.signal }).then(setData)
      .catch((failure) => { if (!isCancelled(failure)) setError(inventoryError(failure)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [term, page, revision]);
  function toggle(product: StockProductDTO) {
    const next = new Map(selected);
    if (next.has(product.id)) next.delete(product.id); else if (next.size < 200) next.set(product.id, `${product.name} · ${product.sku}`);
    onChange(next);
  }
  return <div className="inventory-selection"><label htmlFor={id}>Pesquisar produtos ativos</label><input id={id} type="search" maxLength={100} placeholder="Nome, SKU ou código de barras" value={search} onChange={(event) => setSearch(event.target.value)} />
    <div className="inventory-selection-count"><span>{selected.size} de até 200 produtos selecionados</span>{selected.size > 0 && <button type="button" className="text-link" onClick={() => onChange(new Map())}>Limpar seleção</button>}</div>
    {error && <div className="form-message form-error" role="alert"><p>{error}</p><button className="text-link" type="button" onClick={() => setRevision((value) => value + 1)}>Tentar novamente</button></div>}
    {loading ? <p className="inventory-state" role="status">Consultando produtos…</p> : data?.items.length ? <><div className="inventory-selection-list">{data.items.map((product) => <label key={product.id}><input type="checkbox" checked={selected.has(product.id)} disabled={!selected.has(product.id) && selected.size >= 200} onChange={() => toggle(product)} /><span><strong>{product.name}</strong><small>{product.sku}</small></span><span>{decimal(product.quantity)} {product.unitOfMeasure}</span></label>)}</div><div className="inventory-picker-pages"><span>{data.total} produtos encontrados</span><div><button className="text-link" type="button" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>Anterior</button><span>{page} / {Math.max(1, data.totalPages)}</span><button className="text-link" type="button" disabled={page >= data.totalPages} onClick={() => setPage((value) => value + 1)}>Próxima</button></div></div></> : !error && <p className="inventory-state">Nenhum produto ativo encontrado.</p>}
  </div>;
}

export function InventoryCreate({ initial, onClose, onReview }: { initial?: CreateInventoryInput; onClose: () => void; onReview: (intent: InventoryIntent) => void }) {
  const id = useId();
  const [title, setTitle] = useState(initial?.title ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [scope, setScope] = useState<"all" | "products" | "categories">(initial?.scope ?? "all");
  const [products, setProducts] = useState(() => new Map<string, string>(initial?.scope === "products" ? initial.productIds.map((id): [string, string] => [id, id]) : []));
  const [categories, setCategories] = useState<string[]>(initial?.scope === "categories" ? initial.categoryIds : []);
  const [options, setOptions] = useState<StockOptions | null>(null);
  const [optionsError, setOptionsError] = useState("");
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setOptionsError("");
    void inventoryRequest<StockOptions>("/api/stock/options", { signal: controller.signal }).then(setOptions)
      .catch((failure) => { if (!isCancelled(failure)) setOptionsError(inventoryError(failure)); });
    return () => controller.abort();
  }, [revision]);
  function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError("");
    if (!title.trim()) { setError("Informe um título para identificar a conferência."); return; }
    if (scope === "products" && !products.size) { setError("Selecione pelo menos um produto."); return; }
    if (scope === "categories" && !categories.length) { setError("Selecione pelo menos uma categoria."); return; }
    const common = { title: title.trim(), ...(notes.trim() ? { notes: notes.trim() } : {}), idempotencyKey: crypto.randomUUID() };
    const body: CreateInventoryInput = scope === "all" ? { ...common, scope } : scope === "products" ? { ...common, scope, productIds: [...products.keys()] } : { ...common, scope, categoryIds: categories };
    onReview({ kind: "CREATE", body, review: {
      title: "Abrir inventário", description: `Iniciar a conferência “${body.title}” com uma referência dos saldos atuais. A abertura não altera o estoque.`,
      lines: [scope === "all" ? "Todos os produtos ativos, até o limite de 200 por inventário." : scope === "products" ? `${products.size} produtos selecionados.` : `${categories.length} categorias selecionadas; somente seus produtos ativos.`, "As quantidades encontradas serão informadas depois da abertura.", "Escopos com mais de 200 produtos serão recusados; divida a conferência por categorias ou produtos."]
    } });
  }
  return <CatalogModal title="Abrir inventário físico" caption="CONFERÊNCIA DO ESTOQUE" wide onClose={onClose}>
    <form className="catalog-form inventory-create-form" onSubmit={review}><div className="form-field"><label htmlFor={`${id}-title`}>Título da conferência</label><input id={`${id}-title`} required maxLength={160} value={title} placeholder="Ex.: Conferência do setor de materiais" onChange={(event) => setTitle(event.target.value)} /></div>
      <fieldset className="inventory-scope"><legend>Quais produtos serão conferidos?</legend><label><input type="radio" name={`${id}-scope`} checked={scope === "all"} onChange={() => setScope("all")} /><span>Todos os produtos ativos</span></label><label><input type="radio" name={`${id}-scope`} checked={scope === "categories"} onChange={() => setScope("categories")} /><span>Produtos de categorias selecionadas</span></label><label><input type="radio" name={`${id}-scope`} checked={scope === "products"} onChange={() => setScope("products")} /><span>Escolher produtos individualmente</span></label></fieldset>
      {scope === "categories" && <div className="inventory-category-selection">{optionsError ? <div className="form-message form-error" role="alert"><p>{optionsError}</p><button className="text-link" type="button" onClick={() => setRevision((value) => value + 1)}>Tentar novamente</button></div> : !options ? <p role="status">Consultando categorias…</p> : options.categories.length ? options.categories.map((category) => <label key={category.id}><input type="checkbox" checked={categories.includes(category.id)} onChange={() => setCategories((current) => current.includes(category.id) ? current.filter((item) => item !== category.id) : [...current, category.id])} /><span>{category.name}</span></label>) : <p>Nenhuma categoria ativa. <Link href="/categorias" className="text-link">Consultar categorias</Link></p>}</div>}
      {scope === "products" && <InventoryProductSelection selected={products} onChange={setProducts} />}
      <div className="form-field"><label htmlFor={`${id}-notes`}>Observações (opcional)</label><textarea id={`${id}-notes`} maxLength={2000} rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} /></div>
      <p className="catalog-confirm-note">Cada inventário comporta até 200 produtos. Movimentações podem continuar durante a contagem; itens movimentados precisarão ter a referência atualizada e ser recontados antes da confirmação dos ajustes.</p>
      {error && <p className="form-message form-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button className="button-secondary" type="button" onClick={onClose}>Cancelar</button><button className="button-primary" type="submit">Revisar abertura</button></div>
    </form>
  </CatalogModal>;
}
