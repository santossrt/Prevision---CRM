"use client";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import type { CreateMovementInput, NewMovementType, StockBalances, StockOptions, StockProductDTO } from "@/lib/stock/types";
import { CatalogModal } from "@/components/catalog/catalog-modal";
import { BarcodeLookup } from "@/components/barcode/barcode-lookup";
import { isCancelled, stockError, stockRequest } from "./stock-api";
import type { StockIntent } from "./stock-intent";
import { decimal, localDateTime, money, normalizeDecimal } from "./stock-format";

function ProductPicker({ onSelect }: { onSelect: (id: string) => void }) {
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
    const query = new URLSearchParams({ status: "active", page: String(page), pageSize: "8" });
    if (term) query.set("search", term);
    setLoading(true); setError("");
    void stockRequest<StockBalances>(`/api/stock/balances?${query}`, { signal: controller.signal }).then(setData)
      .catch((failure) => { if (!isCancelled(failure)) setError(stockError(failure)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [term, page, revision]);
  return <div className="stock-product-picker"><BarcodeLookup onSelectProduct={onSelect} /><label htmlFor={id}>Ou pesquisar produto ativo por nome ou SKU</label><input id={id} type="search" placeholder="Nome ou SKU" value={search} maxLength={100} onChange={(event) => setSearch(event.target.value)} />
    {error && <div className="form-message form-error" role="alert"><p>{error}</p><button type="button" className="text-link" onClick={() => setRevision((value) => value + 1)}>Tentar novamente</button></div>}
    {loading ? <p className="stock-picker-state" role="status">Consultando produtos…</p> : data?.items.length ? <><div className="stock-picker-results" role="group" aria-label="Produtos encontrados">{data.items.map((item) => <button type="button" key={item.id} onClick={() => onSelect(item.id)}><span><strong>{item.name}</strong><small>{item.sku}</small></span><span>{decimal(item.quantity)} {item.unitOfMeasure}</span></button>)}</div><div className="stock-picker-pagination"><span>{data.total} {data.total === 1 ? "produto encontrado" : "produtos encontrados"}</span><div><button className="text-link" type="button" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>Anterior</button><span>{page} / {Math.max(1, data.totalPages)}</span><button type="button" className="text-link" disabled={page >= data.totalPages} onClick={() => setPage((value) => value + 1)}>Próxima</button></div></div></> : !error && <p className="stock-picker-state">Nenhum produto ativo encontrado. <Link className="text-link" href="/produtos">Consultar cadastros</Link></p>}
  </div>;
}

export function StockEditor({ initialType = "ENTRY", initialProduct, initial, options, canWrite, canAdjust, onClose, onReview }: {
  initialType?: NewMovementType; initialProduct?: StockProductDTO; initial?: CreateMovementInput;
  options: StockOptions; canWrite: boolean; canAdjust: boolean; onClose: () => void; onReview: (intent: StockIntent) => void;
}) {
  const id = useId();
  const [type, setType] = useState<NewMovementType>(initial?.type ?? initialType);
  const [selectedId, setSelectedId] = useState(initial?.productId ?? initialProduct?.id ?? "");
  const [product, setProduct] = useState<StockProductDTO | null>(null);
  const [loadingProduct, setLoadingProduct] = useState(false);
  const [productError, setProductError] = useState("");
  const [revision, setRevision] = useState(0);
  const [quantity, setQuantity] = useState(initial?.quantity ?? "");
  const [unitCost, setUnitCost] = useState(initial?.unitCost ?? "");
  const [unitPrice, setUnitPrice] = useState(initial?.unitPrice ?? "");
  const [supplierId, setSupplierId] = useState(initial?.supplierId ?? "");
  const [customerId, setCustomerId] = useState(initial?.customerId ?? "");
  const [occurredAt, setOccurredAt] = useState(() => initial ? localDateTime(new Date(initial.occurredAt)) : localDateTime());
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [justification, setJustification] = useState(initial?.justification ?? "");
  const [error, setError] = useState("");
  const reviewLock = useRef(false);
  const adjustment = type === "POSITIVE_ADJUSTMENT" || type === "NEGATIVE_ADJUSTMENT";
  const positive = type === "ENTRY" || type === "POSITIVE_ADJUSTMENT";
  useEffect(() => {
    if (!selectedId) { setProduct(null); setProductError(""); return; }
    const controller = new AbortController();
    setLoadingProduct(true); setProduct(null); setProductError("");
    void stockRequest<StockProductDTO>(`/api/stock/products/${encodeURIComponent(selectedId)}`, { signal: controller.signal }).then((result) => {
      setProduct(result);
      if (selectedId !== initial?.productId) {
        setUnitCost(result.acquisitionCost); setUnitPrice(result.salePrice);
        setSupplierId(options.suppliers.some((item) => item.id === result.defaultSupplierId) ? result.defaultSupplierId! : "");
      }
    }).catch((failure) => { if (!isCancelled(failure)) setProductError(stockError(failure)); }).finally(() => { if (!controller.signal.aborted) setLoadingProduct(false); });
    return () => controller.abort();
  }, [selectedId, revision, initial?.productId, options.suppliers]);

  function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (reviewLock.current || !product) return;
    setError("");
    try {
      if (!product.isActive) throw new Error("Este produto está inativo. Escolha um produto ativo.");
      const normalizedQuantity = normalizeDecimal(quantity);
      if (/^0\.0+$/.test(normalizedQuantity)) throw new Error("A quantidade deve ser maior que zero.");
      const operationDate = new Date(occurredAt);
      if (Number.isNaN(operationDate.getTime())) throw new Error("Informe uma data de operação válida.");
      if (operationDate.getTime() > Date.now() + 5 * 60000) throw new Error("A data da operação não pode estar no futuro.");
      const cost = type === "ENTRY" ? normalizeDecimal(unitCost) : product.acquisitionCost;
      const price = type === "EXIT" ? normalizeDecimal(unitPrice) : null;
      const supplier = options.suppliers.find((item) => item.id === supplierId);
      const customer = options.customers.find((item) => item.id === customerId);
      if (type === "ENTRY" && !supplier) throw new Error("Selecione um fornecedor ativo para a entrada.");
      if (type === "EXIT" && customerId && !customer) throw new Error("Selecione um cliente ativo ou deixe o cliente sem informar.");
      if (adjustment && !justification.trim()) throw new Error("Informe a justificativa do ajuste.");
      const body: CreateMovementInput = {
        type, productId: product.id, quantity: normalizedQuantity, occurredAt: operationDate.toISOString(),
        idempotencyKey: crypto.randomUUID(), ...(notes.trim() ? { notes: notes.trim() } : {}),
        ...(type === "ENTRY" ? { unitCost: cost, supplierId: supplier!.id } : {}),
        ...(type === "EXIT" ? { unitPrice: price!, ...(customer ? { customerId: customer.id } : {}) } : {}),
        ...(adjustment ? { justification: justification.trim() } : {})
      };
      reviewLock.current = true;
      onReview({ kind: "movement", body, review: {
        productName: product.name, sku: product.sku, unit: product.unitOfMeasure, type,
        quantityDelta: positive ? normalizedQuantity : `-${normalizedQuantity}`, quantityBefore: product.quantity,
        unitCost: cost, unitPrice: price, supplier: type === "ENTRY" ? supplier!.name : null,
        customer: type === "EXIT" ? customer?.name ?? null : null, occurredAt: body.occurredAt,
        notes: body.notes ?? null, justification: body.justification ?? null
      } });
    } catch (failure) { reviewLock.current = false; setError(stockError(failure)); }
  }

  return <CatalogModal title="Nova movimentação" caption="ESTOQUE COMPARTILHADO" wide onClose={onClose}>
    <form className="catalog-form stock-form" onSubmit={review}>
      <div className="form-field"><label htmlFor={`${id}-type`}>Tipo de movimentação</label><select id={`${id}-type`} value={type} onChange={(event) => { setType(event.target.value as NewMovementType); setError(""); }}>{canWrite && <><option value="ENTRY">Entrada</option><option value="EXIT">Saída</option></>}{canAdjust && <><option value="POSITIVE_ADJUSTMENT">Ajuste positivo</option><option value="NEGATIVE_ADJUSTMENT">Ajuste negativo</option></>}</select></div>
      {!selectedId ? <ProductPicker onSelect={setSelectedId} /> : loadingProduct ? <p role="status">Conferindo o produto e seu saldo atual…</p> : productError ? <div className="form-message form-error" role="alert"><p>{productError}</p><button type="button" className="text-link" onClick={() => setRevision((value) => value + 1)}>Tentar novamente</button><button type="button" className="text-link" onClick={() => setSelectedId("")}>Escolher outro produto</button></div> : product && <div className="stock-selected-product"><div><strong>{product.name}</strong><span>{product.sku} · {product.category.name}</span><span>Saldo consultado: <strong>{decimal(product.quantity)} {product.unitOfMeasure}</strong></span></div><button type="button" className="text-link" onClick={() => { setSelectedId(""); setProduct(null); }}>Trocar produto</button></div>}
      <div className="catalog-form-grid">
        <div className="form-field"><label htmlFor={`${id}-quantity`}>Quantidade {product ? `(${product.unitOfMeasure})` : ""}</label><input id={`${id}-quantity`} inputMode="decimal" autoComplete="off" placeholder="0,0000" value={quantity} maxLength={19} required onChange={(event) => setQuantity(event.target.value)} /><small>Até quatro casas decimais, sem separador de milhar.</small></div>
        <div className="form-field"><label htmlFor={`${id}-date`}>Data da operação</label><input id={`${id}-date`} type="datetime-local" value={occurredAt} required onChange={(event) => setOccurredAt(event.target.value)} /><small>Horário local deste dispositivo.</small></div>
        {type === "ENTRY" && <><div className="form-field"><label htmlFor={`${id}-cost`}>Custo unitário (R$)</label><input id={`${id}-cost`} inputMode="decimal" value={unitCost} maxLength={19} required onChange={(event) => setUnitCost(event.target.value)} /><small>O valor ficará registrado nesta entrada.</small></div><div className="form-field"><label htmlFor={`${id}-supplier`}>Fornecedor</label><select id={`${id}-supplier`} required value={supplierId} onChange={(event) => setSupplierId(event.target.value)}><option value="">Selecione um fornecedor ativo</option>{options.suppliers.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select>{!options.suppliers.length && <small>Cadastre ou ative um fornecedor em <Link className="text-link" href="/fornecedores">Fornecedores</Link>.</small>}</div></>}
        {type === "EXIT" && <><div className="form-field"><label htmlFor={`${id}-price`}>Preço unitário de venda (R$)</label><input id={`${id}-price`} inputMode="decimal" value={unitPrice} maxLength={19} required onChange={(event) => setUnitPrice(event.target.value)} /><small>Custo de referência: {product ? money(product.acquisitionCost) : "selecione um produto"}.</small></div><div className="form-field"><label htmlFor={`${id}-customer`}>Cliente (opcional)</label><select id={`${id}-customer`} value={customerId} onChange={(event) => setCustomerId(event.target.value)}><option value="">Não informar cliente</option>{options.customers.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></div></>}
        {adjustment && <div className="form-field catalog-field-wide"><label htmlFor={`${id}-justification`}>Justificativa do ajuste</label><textarea id={`${id}-justification`} value={justification} required maxLength={2000} rows={3} onChange={(event) => setJustification(event.target.value)} /><small>Descreva por que a quantidade precisa ser {positive ? "aumentada" : "reduzida"}. Custo de referência: {product ? money(product.acquisitionCost) : "selecione um produto"}.</small></div>}
        <div className="form-field catalog-field-wide"><label htmlFor={`${id}-notes`}>Observações (opcional)</label><textarea id={`${id}-notes`} rows={3} maxLength={2000} value={notes} onChange={(event) => setNotes(event.target.value)} /></div>
      </div>
      <p className="catalog-confirm-note">{type === "ENTRY" ? "A entrada aumenta o saldo. O custo informado pertence a esta operação; os valores do cadastro do produto permanecem como referência para os próximos lançamentos." : type === "EXIT" ? "A saída reduz o saldo e não poderá ultrapassar a quantidade disponível. O custo e o preço praticados ficarão preservados no histórico." : "O ajuste altera o saldo pela quantidade informada. A justificativa e o usuário responsável ficarão no histórico."}</p>
      {error && <p className="form-message form-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button className="button-secondary" type="button" onClick={onClose}>Cancelar</button><button type="submit" className="button-primary" disabled={!product || loadingProduct || !product.isActive || (type === "ENTRY" && !options.suppliers.length)}>Revisar lançamento</button></div>
    </form>
  </CatalogModal>;
}
