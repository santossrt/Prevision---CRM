"use client";

import { useEffect, useId, useState } from "react";
import Link from "next/link";
import type { InventoryDTO, InventoryItemDTO } from "@/lib/inventory/types";
import { CatalogModal } from "@/components/catalog/catalog-modal";
import { Icon } from "@/components/ui/icon";
import { inventoryError, inventoryRequest, isCancelled, type InventoryIntent } from "./inventory-api";
import { date, decimal, inventoryLabels, normalizeDecimal, quantityDifference } from "./inventory-format";

type Draft = Record<string, { quantity: string; justification: string }>;
function initialDraft(inventory: InventoryDTO): Draft {
  return Object.fromEntries(inventory.items.map((item) => [item.productId, { quantity: item.countedQuantity?.replace(".", ",") ?? "", justification: item.justification ?? "" }]));
}
function difference(item: InventoryItemDTO, quantity: string): string | null {
  try { return quantity.trim() ? quantityDifference(normalizeDecimal(quantity), item.baselineQuantity) : null; } catch { return null; }
}

export function InventoryDetail({ inventoryId, ownerId, canWrite, canAdjust, blocked, revision, onBack, onReview }: {
  inventoryId: string; ownerId: string; canWrite: boolean; canAdjust: boolean; blocked: boolean; revision: number;
  onBack: () => void; onReview: (intent: InventoryIntent) => void;
}) {
  const [inventory, setInventory] = useState<InventoryDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
    void inventoryRequest<InventoryDTO>(`/api/inventories/${encodeURIComponent(inventoryId)}`, { signal: controller.signal }).then((result) => { if (!controller.signal.aborted) setInventory(result); })
      .catch((failure) => { if (!isCancelled(failure)) setError(inventoryError(failure)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [inventoryId, revision, retry]);
  if (loading) return <section className="management-panel"><div className="table-state" role="status"><span className="catalog-loader" /><p>Consultando a conferência e os saldos atuais…</p></div></section>;
  if (error || !inventory) return <section className="management-panel inventory-error-panel"><h2>Não foi possível consultar o inventário</h2><p className="form-message form-error" role="alert">{error || "Inventário indisponível."}</p><div className="dialog-actions"><button className="button-secondary" type="button" onClick={onBack}>Voltar à lista</button><button className="button-primary" type="button" onClick={() => setRetry((value) => value + 1)}>Tentar novamente</button></div></section>;
  return <InventoryCountPanel key={`${inventory.id}:${inventory.version}:${retry}`} inventory={inventory} ownerId={ownerId} canWrite={canWrite} canAdjust={canAdjust} blocked={blocked} onBack={onBack} onReview={onReview} onRefresh={() => setRetry((value) => value + 1)} />;
}

function InventoryCountPanel({ inventory, ownerId, canWrite, canAdjust, blocked, onBack, onReview, onRefresh }: {
  inventory: InventoryDTO; ownerId: string; canWrite: boolean; canAdjust: boolean; blocked: boolean;
  onBack: () => void; onReview: (intent: InventoryIntent) => void; onRefresh: () => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState<Draft>(() => initialDraft(inventory));
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [error, setError] = useState("");
  const [discardAction, setDiscardAction] = useState<(() => void) | null>(null);
  const open = inventory.status === "OPEN";
  const editable = open && canWrite && !blocked;
  const initial = initialDraft(inventory);
  const dirty = inventory.items.some((item) => draft[item.productId].quantity !== initial[item.productId].quantity || draft[item.productId].justification !== initial[item.productId].justification);
  const changed = inventory.items.filter((item) => item.stockChanged);
  const inactive = inventory.items.filter((item) => !item.productIsActive);
  const canComplete = open && canAdjust && !blocked && !dirty && inventory.countedItems === inventory.itemCount && !changed.length && !inactive.length;
  const canCancel = open && !blocked && (canAdjust || (canWrite && inventory.createdBy.id === ownerId));
  const query = search.trim().toLocaleLowerCase("pt-BR");
  const filtered = inventory.items.filter((item) => (!query || `${item.name} ${item.sku} ${item.categoryName}`.toLocaleLowerCase("pt-BR").includes(query))
    && (filter === "all" || filter === "uncounted" && item.countedQuantity === null || filter === "divergent" && item.difference !== null && item.difference !== "0.0000" || filter === "changed" && item.stockChanged));
  const pages = Math.max(1, Math.ceil(filtered.length / 20));
  const visible = filtered.slice((page - 1) * 20, page * 20);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    const guardLink = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || !(event.target instanceof Element)) return;
      const anchor = event.target.closest<HTMLAnchorElement>("a[href]");
      if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download")) return;
      const target = new URL(anchor.href, window.location.href);
      if (!["http:", "https:"].includes(target.protocol) || target.origin === window.location.origin && target.pathname === window.location.pathname && target.search === window.location.search) return;
      event.preventDefault(); event.stopPropagation();
      setDiscardAction(() => () => { window.location.assign(target.href); });
    };
    window.addEventListener("beforeunload", warn);
    document.addEventListener("click", guardLink, true);
    return () => { window.removeEventListener("beforeunload", warn); document.removeEventListener("click", guardLink, true); };
  }, [dirty]);

  function protect(action: () => void) {
    if (dirty) setDiscardAction(() => action); else action();
  }
  function update(productId: string, field: "quantity" | "justification", value: string) {
    setDraft((current) => ({ ...current, [productId]: { ...current[productId], [field]: value } })); setError("");
  }
  function saveCounts() {
    setError("");
    try {
      const changedRows = visible.filter((item) => draft[item.productId].quantity !== initial[item.productId].quantity || draft[item.productId].justification !== initial[item.productId].justification);
      if (!changedRows.length) throw new Error("Altere pelo menos uma contagem nesta página antes de salvar.");
      const items = changedRows.map((item) => {
        if (!draft[item.productId].quantity.trim()) throw new Error(`Informe a quantidade física de ${item.name}. Zero é uma contagem válida.`);
        const countedQuantity = normalizeDecimal(draft[item.productId].quantity);
        const justification = draft[item.productId].justification.trim();
        if (quantityDifference(countedQuantity, item.baselineQuantity) !== "0.0000" && !justification) throw new Error(`Justifique a divergência de ${item.name}.`);
        if (justification.length > 600) throw new Error("A justificativa deve ter até 600 caracteres.");
        return { productId: item.productId, countedQuantity, ...(justification ? { justification } : {}) };
      });
      onReview({ kind: "COUNT", inventoryId: inventory.id, body: { expectedVersion: inventory.version, idempotencyKey: crypto.randomUUID(), items }, review: {
        title: "Salvar contagens", description: `Registrar ${items.length} ${items.length === 1 ? "contagem física" : "contagens físicas"} em “${inventory.title}”. O saldo do estoque ainda não será alterado.`,
        lines: items.map((item) => { const product = inventory.items.find((row) => row.productId === item.productId)!; return `${product.name}: ${decimal(item.countedQuantity)} ${product.unitOfMeasure}.`; })
      } });
    } catch (failure) { setError(inventoryError(failure)); }
  }
  function rebase(items: InventoryItemDTO[]) {
    protect(() => onReview({ kind: "REBASE", inventoryId: inventory.id, body: { expectedVersion: inventory.version, idempotencyKey: crypto.randomUUID(), productIds: items.map((item) => item.productId) }, review: {
      title: "Atualizar referência e recontar", description: `Usar os saldos atuais como referência para ${items.length} ${items.length === 1 ? "produto" : "produtos"} de “${inventory.title}”. Esta ação não altera o estoque.`,
      lines: items.map((item) => `${item.name}: referência ${decimal(item.baselineQuantity)} → saldo atual ${decimal(item.currentQuantity)} ${item.unitOfMeasure}.`)
    } }));
  }
  function complete() {
    if (!canComplete) return;
    onReview({ kind: "COMPLETE", inventoryId: inventory.id, body: { expectedVersion: inventory.version, idempotencyKey: crypto.randomUUID() }, review: {
      title: "Confirmar ajustes do inventário", description: `Concluir “${inventory.title}” e registrar os ajustes necessários para igualar os saldos às quantidades físicas conferidas.`,
      lines: [`${inventory.countedItems} produtos contados; ${inventory.divergentItems} ${inventory.divergentItems === 1 ? "produto com ajuste" : "produtos com ajuste"}.`, "Itens sem diferença serão preservados sem criar movimentação.", "Se algum saldo tiver mudado desde a referência, a confirmação inteira será recusada para permitir nova conferência."]
    } });
  }
  function cancel() {
    protect(() => onReview({ kind: "CANCEL", inventoryId: inventory.id, body: { expectedVersion: inventory.version, idempotencyKey: crypto.randomUUID() }, review: {
      title: "Cancelar inventário", description: `Encerrar “${inventory.title}” como cancelado, preservando suas contagens para consulta.`, lines: ["Nenhum saldo será alterado e nenhum ajuste de estoque será gerado.", "O inventário cancelado não poderá ser retomado."]
    } }));
  }

  return <>
    <div className="inventory-detail-toolbar"><button type="button" className="text-link" onClick={() => protect(onBack)}>← Todos os inventários</button><button type="button" className="text-link" onClick={() => protect(onRefresh)}>Atualizar consulta</button></div>
    <section className="management-panel inventory-overview"><div><p className="eyebrow">{inventoryLabels[inventory.status]}</p><h2>{inventory.title}</h2>{inventory.notes && <p className="inventory-notes">{inventory.notes}</p>}</div><dl className="inventory-metadata"><div><dt>Aberto por</dt><dd>{inventory.createdBy.name || "Usuário cadastrado"}</dd></div><div><dt>Início</dt><dd>{date(inventory.openedAt)}</dd></div>{inventory.completedAt && <><div><dt>Concluído por</dt><dd>{inventory.completedBy?.name || "Usuário cadastrado"}</dd></div><div><dt>Conclusão</dt><dd>{date(inventory.completedAt)}</dd></div></>}{inventory.canceledAt && <><div><dt>Cancelado por</dt><dd>{inventory.canceledBy?.name || "Usuário cadastrado"}</dd></div><div><dt>Cancelamento</dt><dd>{date(inventory.canceledAt)}</dd></div></>}</dl></section>
    <div className="inventory-summary"><div><span>Produtos no inventário</span><strong>{inventory.itemCount}</strong></div><div><span>Contagens salvas</span><strong>{inventory.countedItems} <small>/ {inventory.itemCount}</small></strong></div><div><span>Divergências salvas</span><strong>{inventory.divergentItems}</strong></div>{open && <div><span>Referências alteradas</span><strong>{changed.length}</strong></div>}</div>
    {open && <p className="inventory-guidance">Conte fisicamente os produtos e salve até 20 contagens por página. Uma quantidade igual a zero também deve ser informada. As quantidades do estoque só serão alteradas na confirmação dos ajustes.</p>}
    {open && changed.length > 0 && <div className="form-message inventory-warning" role="status"><p><strong>{changed.length} {changed.length === 1 ? "produto está com a referência alterada" : "produtos estão com a referência alterada"}</strong>. Atualize os itens e faça nova contagem antes de concluir. Se a unidade de medida mudou, cancele e abra outro inventário ou restaure a unidade do cadastro.</p>{canWrite && <button className="button-secondary" type="button" disabled={blocked || !changed.some((item) => item.productIsActive)} onClick={() => rebase(changed.filter((item) => item.productIsActive))}>Atualizar referências alteradas e recontar</button>}</div>}
    {open && inactive.length > 0 && <p className="form-message inventory-warning" role="status">Há {inactive.length} {inactive.length === 1 ? "produto inativo" : "produtos inativos"}. Reative o cadastro para continuar a conferência ou cancele este inventário.</p>}
    {dirty && <p className="form-message inventory-unsaved" role="status">Há contagens editadas nesta página que ainda não foram salvas.</p>}
    <div className="catalog-toolbar"><div className="catalog-search"><label className="sr-only" htmlFor={`${id}-search`}>Pesquisar itens do inventário</label><input id={`${id}-search`} type="search" maxLength={100} value={search} placeholder="Pesquisar produto, SKU ou categoria" onChange={(event) => { const value = event.target.value; protect(() => { setSearch(value); setPage(1); }); }} /></div><div className="inventory-item-filter"><label htmlFor={`${id}-filter`}>Exibir</label><select id={`${id}-filter`} value={filter} onChange={(event) => { const value = event.target.value; protect(() => { setFilter(value); setPage(1); }); }}><option value="all">Todos os produtos</option><option value="uncounted">Ainda não contados</option><option value="divergent">Com divergência salva</option>{open && <option value="changed">Referência alterada</option>}</select></div></div>
    {error && <p className="form-message form-error catalog-notice" role="alert">{error}</p>}
    <section className="management-panel catalog-panel inventory-items-panel" aria-labelledby={`${id}-items-title`}><div className="panel-heading"><div><h2 id={`${id}-items-title`}>Produtos conferidos</h2><p>Referência do sistema, contagem física e diferença por produto.</p></div><span className="count-badge">{filtered.length} produtos</span></div>
      {visible.length ? <div className="table-scroll"><table className="catalog-table inventory-items-table"><thead><tr><th scope="col">Produto / Categoria</th><th scope="col">Saldo de referência</th><th scope="col">Quantidade física</th><th scope="col">Diferença</th><th scope="col">Justificativa / Registro</th></tr></thead><tbody>{visible.map((item) => {
        const row = draft[item.productId];
        const delta = open ? difference(item, row.quantity) : item.difference;
        const rowEditable = editable && item.productIsActive && !item.stockChanged;
        return <tr key={item.productId} className={item.stockChanged ? "inventory-item-changed" : ""}><td><div className="catalog-name-cell"><strong>{item.name}</strong><span className="catalog-sku">{item.sku}</span><span>{item.categoryName}</span>{!item.productIsActive && <span className="inventory-inactive">Produto inativo</span>}</div></td><td><div className="catalog-quantity"><strong>{decimal(item.baselineQuantity)} <small>{item.unitOfMeasure}</small></strong>{open && item.stockChanged && <><span className="inventory-changed-label">Referência alterada</span><small>Atual: {decimal(item.currentQuantity)} {item.unitOfMeasure}</small>{canWrite && item.productIsActive && <button className="text-link" type="button" disabled={blocked} onClick={() => rebase([item])}>Atualizar e recontar</button>}</>}</div></td><td>{open && canWrite ? <input className="inventory-count-input" inputMode="decimal" autoComplete="off" maxLength={19} placeholder="Não contado" aria-label={`Quantidade física de ${item.name}`} value={row.quantity} disabled={!rowEditable} onChange={(event) => update(item.productId, "quantity", event.target.value)} /> : <strong>{item.countedQuantity === null ? "Não contado" : `${decimal(item.countedQuantity)} ${item.unitOfMeasure}`}</strong>}{item.countedAt && <small className="inventory-count-meta">{item.countedBy?.name || "Usuário cadastrado"}<br />{date(item.countedAt)}</small>}</td><td><span className={`inventory-difference${delta && delta !== "0.0000" ? delta.startsWith("-") ? " inventory-difference-negative" : " inventory-difference-positive" : ""}`}>{delta === null ? "—" : `${delta.startsWith("-") || delta === "0.0000" ? "" : "+"}${decimal(delta)}`}</span></td><td>{open && canWrite ? <textarea aria-label={`Justificativa de ${item.name}`} rows={3} maxLength={600} value={row.justification} placeholder={delta !== null && delta !== "0.0000" ? "Justifique a diferença" : "Opcional se não houver diferença"} disabled={!rowEditable} onChange={(event) => update(item.productId, "justification", event.target.value)} /> : <p className="inventory-justification">{item.justification || "Sem divergência justificada"}</p>}{item.movementId && <Link className="text-link inventory-movement-link" href={`/estoque?${new URLSearchParams({ search: item.sku })}`}>Consultar estoque · ajuste {item.movementId.slice(0, 8)}</Link>}</td></tr>;
      })}</tbody></table></div> : <div className="table-state"><Icon name="inventory" /><strong>Nenhum produto neste filtro</strong><p>Altere a pesquisa ou a situação para ampliar a consulta.</p></div>}
      <div className="catalog-pagination"><span>{filtered.length ? (page - 1) * 20 + 1 : 0}–{Math.min(page * 20, filtered.length)} de {filtered.length} produtos</span><div><button className="button-secondary" type="button" disabled={page <= 1} onClick={() => protect(() => setPage((value) => value - 1))}>Anterior</button><span>Página {page} de {pages}</span><button className="button-secondary" type="button" disabled={page >= pages} onClick={() => protect(() => setPage((value) => value + 1))}>Próxima</button></div></div>
    </section>
    {open && <div className="inventory-completion-actions"><div>{canWrite && <button className="button-primary" type="button" disabled={!editable || !dirty} onClick={saveCounts}>Salvar contagens desta página</button>}{canCancel && <button className="text-link inventory-cancel" type="button" onClick={cancel}>Cancelar inventário</button>}</div>{canAdjust ? <button className="button-secondary" type="button" disabled={!canComplete} onClick={complete}>Revisar e confirmar ajustes<Icon name="arrow-right" /></button> : <p>A confirmação dos ajustes exige permissão de administrador ou gerente.</p>}</div>}
    {open && canAdjust && !canComplete && <p className="inventory-completion-hint">Para concluir, salve a contagem de todos os itens, resolva as referências alteradas e mantenha os produtos ativos.</p>}
    {!open && <p className="management-footnote"><Icon name="shield" />O inventário {inventory.status === "COMPLETED" ? "concluído" : "cancelado"} está preservado para consulta e não pode ser reaberto ou editado.</p>}
    {discardAction && <CatalogModal title="Há contagens não salvas" caption="CONTINUAR A CONFERÊNCIA" onClose={() => setDiscardAction(null)}><p className="dialog-description">As alterações desta página ainda não foram registradas. Volte e salve as contagens ou descarte as edições para continuar.</p><div className="dialog-actions"><button className="button-primary" type="button" onClick={() => setDiscardAction(null)}>Voltar às contagens</button><button className="button-secondary" type="button" onClick={() => { const action = discardAction; setDiscardAction(null); setDraft(initialDraft(inventory)); setError(""); action(); }}>Descartar edições e continuar</button></div></CatalogModal>}
  </>;
}
