"use client";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { StockMovementDTO } from "@/lib/stock/types";
import { CatalogModal } from "@/components/catalog/catalog-modal";
import { isCancelled, stockError, stockRequest } from "./stock-api";
import { date, decimal, inverse, money, movementLabels } from "./stock-format";
import type { StockIntent } from "./stock-intent";

export function StockMovementDetail({ movementId, canAdjust, onClose, onCompensate, onOpen }: {
  movementId: string; canAdjust: boolean; onClose: () => void; onCompensate: (movement: StockMovementDTO) => void; onOpen: (id: string) => void;
}) {
  const [movement, setMovement] = useState<StockMovementDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(""); setMovement(null);
    void stockRequest<StockMovementDTO>(`/api/stock/movements/${encodeURIComponent(movementId)}`, { signal: controller.signal }).then(setMovement)
      .catch((failure) => { if (!isCancelled(failure)) setError(stockError(failure)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [movementId, revision]);
  return <CatalogModal title="Detalhes da movimentação" caption="HISTÓRICO DO ESTOQUE" wide onClose={onClose}>
    {loading && <p className="stock-detail-state" role="status">Consultando a movimentação…</p>}
    {error && <div className="form-message form-error" role="alert"><p>{error}</p><button type="button" className="text-link" onClick={() => setRevision((value) => value + 1)}>Tentar novamente</button></div>}
    {movement && <><div className="stock-review-product"><strong>{movement.product.name}</strong><span>{movement.product.sku} · {movementLabels[movement.type]}</span></div><dl className="stock-detail-grid">
      <div><dt>Data da operação</dt><dd>{date(movement.occurredAt)}</dd></div><div><dt>Registrada em</dt><dd>{date(movement.createdAt)}</dd></div>
      <div><dt>Quantidade</dt><dd className={movement.quantityDelta.startsWith("-") ? "stock-decrease" : "stock-increase"}>{movement.quantityDelta.startsWith("-") ? "" : "+"}{decimal(movement.quantityDelta)} {movement.product.unitOfMeasure}</dd></div>
      <div><dt>Responsável</dt><dd>{movement.performedBy.name || "Usuário cadastrado"}</dd></div>
      <div><dt>Saldo anterior</dt><dd>{decimal(movement.quantityBefore)} {movement.product.unitOfMeasure}</dd></div><div><dt>Saldo resultante</dt><dd>{decimal(movement.quantityAfter)} {movement.product.unitOfMeasure}</dd></div>
      <div><dt>Custo unitário histórico</dt><dd>{money(movement.historicalUnitCost)}</dd></div><div><dt>Custo total histórico</dt><dd>{money(movement.historicalTotalCost)}</dd></div>
      {movement.historicalUnitPrice !== null && <><div><dt>Preço unitário histórico</dt><dd>{money(movement.historicalUnitPrice)}</dd></div><div><dt>Valor total de venda histórico</dt><dd>{money(movement.historicalTotalPrice!)}</dd></div></>}
      <div><dt>Fornecedor</dt><dd>{movement.supplier?.name || "Não informado"}</dd></div><div><dt>Cliente</dt><dd>{movement.customer?.name || "Não informado"}</dd></div>
      {movement.justification && <div className="stock-detail-full"><dt>Justificativa</dt><dd>{movement.justification}</dd></div>}{movement.notes && <div className="stock-detail-full"><dt>Observações</dt><dd>{movement.notes}</dd></div>}
      <div className="stock-detail-full stock-operation-reference"><dt>Identificação da operação</dt><dd>{movement.operationId}</dd></div>
    </dl>
      {movement.compensationId && <div className="stock-history-relation"><p>Esta movimentação possui uma compensação. Os dois registros permanecem no histórico.</p><button type="button" className="text-link" onClick={() => onOpen(movement.compensationId!)}>Consultar compensação</button></div>}
      {movement.compensatesMovementId && <div className="stock-history-relation"><p>Esta movimentação corrige uma operação anterior, sem apagar seu registro.</p><button type="button" className="text-link" onClick={() => onOpen(movement.compensatesMovementId!)}>Consultar movimentação original</button></div>}
      <p className="catalog-confirm-note">Os valores acima foram registrados no momento da operação. Alterar o cadastro do produto não substitui este histórico.</p>
    </>}
    <div className="dialog-actions"><button type="button" className="button-secondary" onClick={onClose}>Fechar</button>{movement && canAdjust && movement.type !== "COMPENSATION" && !movement.compensationId && <button type="button" className="button-primary" onClick={() => onCompensate(movement)}>Compensar movimentação</button>}</div>
  </CatalogModal>;
}

export function StockCompensation({ movement, initialJustification = "", onClose, onReview }: {
  movement: StockMovementDTO; initialJustification?: string; onClose: () => void; onReview: (intent: StockIntent) => void;
}) {
  const id = useId();
  const [justification, setJustification] = useState(initialJustification);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const inFlight = useRef(false);
  async function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (inFlight.current) return;
    if (!justification.trim()) { setError("Informe por que esta movimentação precisa ser compensada."); return; }
    inFlight.current = true; setLoading(true); setError("");
    try {
      const product = await stockRequest<{ quantity: string }>(`/api/stock/products/${encodeURIComponent(movement.productId)}`);
      onReview({ kind: "compensation", movementId: movement.id, body: { justification: justification.trim(), idempotencyKey: crypto.randomUUID() }, review: {
        productName: movement.product.name, sku: movement.product.sku, unit: movement.product.unitOfMeasure,
        type: "COMPENSATION", quantityDelta: inverse(movement.quantityDelta), quantityBefore: product.quantity,
        unitCost: movement.historicalUnitCost, unitPrice: movement.historicalUnitPrice,
        supplier: movement.supplier?.name ?? null, customer: movement.customer?.name ?? null,
        occurredAt: new Date().toISOString(), notes: null, justification: justification.trim()
      } });
    } catch (failure) { setError(stockError(failure)); }
    finally { inFlight.current = false; setLoading(false); }
  }
  return <CatalogModal title="Compensar movimentação" caption="CORREÇÃO DE ESTOQUE" onClose={onClose} busy={loading}>
    <form className="catalog-form" onSubmit={(event) => void review(event)}><div className="stock-review-product"><strong>{movement.product.name}</strong><span>{movement.product.sku} · {movementLabels[movement.type]} de {date(movement.occurredAt)}</span></div>
      <p className="catalog-confirm-note">Será registrado o inverso desta operação: <strong>{decimal(inverse(movement.quantityDelta))} {movement.product.unitOfMeasure}</strong>, com os mesmos custos e preços históricos. A operação original será preservada. A compensação não será permitida se produzir saldo negativo.</p>
      <div className="form-field"><label htmlFor={id}>Justificativa da correção</label><textarea id={id} required value={justification} maxLength={2000} rows={4} disabled={loading} onChange={(event) => setJustification(event.target.value)} /></div>
      {error && <p className="form-message form-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button className="button-secondary" type="button" disabled={loading} onClick={onClose}>Cancelar</button><button className="button-primary" disabled={loading} type="submit">{loading ? "Conferindo saldo…" : "Revisar compensação"}</button></div>
    </form>
  </CatalogModal>;
}
