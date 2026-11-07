"use client";

import { useCallback, useEffect, useState } from "react";
import type { CatalogList, ProductDTO, ProductValueDTO } from "@/lib/catalog/types";
import { CatalogModal } from "./catalog-modal";
import { catalogRequest, catalogError, isCancelled } from "./catalog-api";
import { formatCatalogDate, formatCatalogDecimal, formatCatalogMoney } from "./catalog-meta";

export function CatalogProductDetail({ initial, canWrite, onClose, onEdit }: { initial: ProductDTO; canWrite: boolean; onClose: () => void; onEdit: (item: ProductDTO) => void }) {
  const [product, setProduct] = useState(initial);
  const [history, setHistory] = useState<CatalogList<ProductValueDTO> | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const load = useCallback(async (signal: AbortSignal) => {
    setLoading(true); setError("");
    try {
      const [record, values] = await Promise.all([
        catalogRequest<{ item: ProductDTO }>(`/api/catalog/products/${encodeURIComponent(initial.id)}`, { signal }),
        catalogRequest<CatalogList<ProductValueDTO>>(`/api/catalog/products/${encodeURIComponent(initial.id)}/values?page=${page}&pageSize=10`, { signal })
      ]);
      setProduct(record.item); setHistory(values);
    } catch (failure) { if (!isCancelled(failure)) setError(catalogError(failure)); }
    finally { if (!signal.aborted) setLoading(false); }
  }, [initial.id, page]);
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [load, revision]);

  return <CatalogModal title={product.name} caption="DETALHES DO PRODUTO" onClose={onClose} wide>
    <div className="catalog-detail-heading"><span className="catalog-sku">{product.sku}</span><span className={`status-pill ${product.isActive ? "status-active" : "status-inactive"}`}><span />{product.isActive ? "Ativo" : "Inativo"}</span>{canWrite && <button type="button" className="text-link" onClick={() => onEdit(product)} disabled={loading}>Editar cadastro</button>}</div>
    <div className="catalog-value-grid"><div><span>Quantidade</span><strong>{formatCatalogDecimal(product.quantity)} <small>{product.unitOfMeasure}</small></strong></div><div><span>Estoque mínimo</span><strong>{formatCatalogDecimal(product.minimumStock)}</strong></div><div><span>Custo de aquisição</span><strong>{formatCatalogMoney(product.acquisitionCost)}</strong></div><div><span>Preço de venda</span><strong>{formatCatalogMoney(product.salePrice)}</strong></div></div>
    <dl className="catalog-details"><div><dt>Categoria</dt><dd>{product.category.name}{!product.category.isActive && " (inativa)"}</dd></div><div><dt>Fornecedor padrão</dt><dd>{product.defaultSupplier ? `${product.defaultSupplier.name}${product.defaultSupplier.isActive ? "" : " (inativo)"}` : "Não informado"}</dd></div><div><dt>Código de barras</dt><dd>{product.barcode ?? "Não informado"}</dd></div><div><dt>Estoque de segurança</dt><dd>{formatCatalogDecimal(product.safetyStock)} {product.unitOfMeasure}</dd></div><div><dt>Prazo de reposição</dt><dd>{product.replenishmentLeadTimeDays === null ? "Não informado" : `${product.replenishmentLeadTimeDays} dias`}</dd></div><div><dt>Última atualização</dt><dd>{formatCatalogDate(product.updatedAt)}</dd></div>{product.description && <div className="catalog-field-wide"><dt>Descrição</dt><dd className="catalog-preserve-lines">{product.description}</dd></div>}</dl>
    <section className="catalog-history" aria-labelledby="product-values-heading" aria-busy={loading}><div className="catalog-history-heading"><div><h3 id="product-values-heading">Histórico de custos e preços</h3><p>Valores anteriores e atuais, com data e responsável pela alteração.</p></div></div>
      {error && <div className="form-message form-error" role="alert"><p>{error}</p><button type="button" className="text-link" onClick={() => setRevision((value) => value + 1)} disabled={loading}>Tentar novamente</button></div>}
      {loading && <p className="catalog-loading" role="status">Consultando histórico…</p>}
      {!loading && !error && history && (history.items.length ? <><div className="table-scroll"><table className="catalog-table catalog-history-table"><thead><tr><th scope="col">Alteração</th><th scope="col">Anterior</th><th scope="col">Novo valor</th><th scope="col">Data</th><th scope="col">Responsável</th></tr></thead><tbody>{history.items.map((entry) => <tr key={entry.id}><td>{entry.type === "ACQUISITION_COST" ? "Custo de aquisição" : "Preço de venda"}</td><td>{entry.previousValue === null ? "Cadastro inicial" : formatCatalogMoney(entry.previousValue)}</td><td><strong>{formatCatalogMoney(entry.newValue)}</strong></td><td>{formatCatalogDate(entry.effectiveAt)}</td><td>{entry.changedBy.name ?? "Usuário responsável"}</td></tr>)}</tbody></table></div><div className="catalog-pagination"><span>Página {history.page} de {Math.max(1, history.totalPages)}</span><div><button type="button" className="button-secondary" disabled={page <= 1} onClick={() => setPage((current) => current - 1)}>Anterior</button><button type="button" className="button-secondary" disabled={page >= history.totalPages} onClick={() => setPage((current) => current + 1)}>Próxima</button></div></div></> : <p className="table-state">Ainda não há alterações de valores para este produto.</p>)}
    </section>
    <div className="dialog-actions"><button type="button" className="button-secondary" onClick={onClose}>Fechar detalhes</button></div>
  </CatalogModal>;
}
