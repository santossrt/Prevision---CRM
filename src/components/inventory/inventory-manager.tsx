"use client";

import { useEffect, useId, useState } from "react";
import type { CreateInventoryInput, InventoryList, InventoryMutationResult, InventoryStatus } from "@/lib/inventory/types";
import { Icon } from "@/components/ui/icon";
import { InventoryCreate } from "./inventory-create";
import { InventoryDetail } from "./inventory-detail";
import { InventorySubmission } from "./inventory-submission";
import { inventoryError, inventoryRequest, inventoryStorageKey, isCancelled, recoverInventoryIntent, type InventoryIntent } from "./inventory-api";
import { date, inventoryLabels } from "./inventory-format";

function InventoryIndex({ revision, onOpen }: { revision: number; onOpen: (id: string) => void }) {
  const id = useId();
  const [search, setSearch] = useState("");
  const [term, setTerm] = useState("");
  const [status, setStatus] = useState<InventoryStatus | "all">("all");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<InventoryList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => { const timer = setTimeout(() => { setTerm(search.trim()); setPage(1); }, 300); return () => clearTimeout(timer); }, [search]);
  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ status, page: String(page), pageSize: "20" });
    if (term) query.set("search", term);
    setLoading(true); setError("");
    void inventoryRequest<InventoryList>(`/api/inventories?${query}`, { signal: controller.signal }).then((result) => { if (controller.signal.aborted) return; setData(result); if (result.totalPages && page > result.totalPages) setPage(result.totalPages); })
      .catch((failure) => { if (!isCancelled(failure)) { setData(null); setError(inventoryError(failure)); } }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [term, status, page, revision, retry]);
  return <>
    <div className="catalog-toolbar"><div className="catalog-search"><label className="sr-only" htmlFor={`${id}-search`}>Pesquisar inventários</label><input id={`${id}-search`} type="search" maxLength={100} value={search} placeholder="Pesquisar pelo título da conferência" onChange={(event) => setSearch(event.target.value)} /></div><div className="inventory-item-filter"><label htmlFor={`${id}-status`}>Situação</label><select id={`${id}-status`} value={status} onChange={(event) => { setStatus(event.target.value as InventoryStatus | "all"); setPage(1); }}><option value="all">Todos os inventários</option><option value="OPEN">Em contagem</option><option value="COMPLETED">Concluídos</option><option value="CANCELED">Cancelados</option></select></div><button className="text-link" type="button" disabled={loading} onClick={() => setRetry((value) => value + 1)}>Atualizar consulta</button></div>
    {error && <div className="form-message form-error catalog-notice" role="alert"><p>{error}</p><button className="text-link" type="button" onClick={() => setRetry((value) => value + 1)}>Tentar novamente</button></div>}
    <section className="management-panel catalog-panel" aria-labelledby={`${id}-title`} aria-busy={loading}><div className="panel-heading"><div><h2 id={`${id}-title`}>Conferências do estoque</h2><p>Contagens físicas e seus ajustes, preservados com os responsáveis.</p></div>{data && <span className="count-badge">{data.total} inventários</span>}</div>
      {loading ? <div className="table-state" role="status"><span className="catalog-loader" /><p>Consultando inventários…</p></div> : data?.items.length ? <div className="table-scroll"><table className="catalog-table inventory-list-table"><thead><tr><th scope="col">Conferência / Responsável</th><th scope="col">Situação</th><th scope="col">Contagem</th><th scope="col">Datas</th><th scope="col"><span className="sr-only">Ações</span></th></tr></thead><tbody>{data.items.map((inventory) => <tr key={inventory.id}><td><div className="catalog-name-cell"><button className="catalog-record-link" type="button" onClick={() => onOpen(inventory.id)}>{inventory.title}</button><span>{inventory.createdBy.name || "Usuário cadastrado"}</span></div></td><td><span className={`inventory-status inventory-status-${inventory.status.toLowerCase()}`}>{inventoryLabels[inventory.status]}</span>{inventory.status === "OPEN" && inventory.changedItems > 0 && <small className="inventory-changed-label inventory-count-meta">{inventory.changedItems} referências alteradas</small>}</td><td><div className="catalog-contact-cell"><span>{inventory.countedItems} de {inventory.itemCount} produtos</span><small>{inventory.divergentItems} com divergência</small></div></td><td><div className="catalog-contact-cell"><span>Início: {date(inventory.openedAt)}</span>{inventory.completedAt && <small>Conclusão: {date(inventory.completedAt)}</small>}{inventory.canceledAt && <small>Cancelamento: {date(inventory.canceledAt)}</small>}</div></td><td><button className="text-link" type="button" onClick={() => onOpen(inventory.id)} aria-label={`Abrir ${inventory.title}`}>{inventory.status === "OPEN" ? "Conferir" : "Consultar"}</button></td></tr>)}</tbody></table></div> : !error && <div className="table-state"><Icon name="inventory" /><strong>{term || status !== "all" ? "Nenhum inventário encontrado" : "A conferência começa com um inventário"}</strong><p>{term || status !== "all" ? "Ajuste o título ou a situação da pesquisa." : "Abra uma conferência para selecionar produtos e registrar as quantidades físicas."}</p></div>}
      {data && data.total > 0 && <div className="catalog-pagination"><span>{(data.page - 1) * data.pageSize + 1}–{Math.min(data.page * data.pageSize, data.total)} de {data.total} inventários</span><div><button className="button-secondary" type="button" disabled={loading || page <= 1} onClick={() => setPage((value) => value - 1)}>Anterior</button><span>Página {data.page} de {Math.max(1, data.totalPages)}</span><button className="button-secondary" type="button" disabled={loading || page >= data.totalPages} onClick={() => setPage((value) => value + 1)}>Próxima</button></div></div>}
    </section>
  </>;
}

export function InventoryManager({ ownerId, canWrite, canAdjust, initialInventoryId }: {
  ownerId: string; canWrite: boolean; canAdjust: boolean; initialInventoryId?: string;
}) {
  const storageKey = inventoryStorageKey(ownerId);
  const [selectedId, setSelectedId] = useState<string | null>(initialInventoryId ?? null);
  const [creating, setCreating] = useState(false);
  const [createInitial, setCreateInitial] = useState<CreateInventoryInput | undefined>();
  const [revision, setRevision] = useState(0);
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState<InventoryIntent | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [submissionOpen, setSubmissionOpen] = useState(false);
  const [recoveryReady, setRecoveryReady] = useState(false);
  const [recoveryError, setRecoveryError] = useState("");
  useEffect(() => {
    try {
      const stored = sessionStorage.getItem(storageKey);
      if (stored) { const intent = recoverInventoryIntent(stored); setPending(intent); setSubmitted(true); setSubmissionOpen(true); if (intent.kind !== "CREATE") setSelectedId(intent.inventoryId); }
    } catch { setRecoveryError("Não foi possível recuperar um possível pedido pendente. Confira a lista e o inventário antes de liberar novas alterações nesta aba."); }
    setRecoveryReady(true);
  }, [storageKey]);
  function clear() { try { sessionStorage.removeItem(storageKey); } catch { /* replaying the stored key remains safe */ } setSubmitted(false); }
  function review(intent: InventoryIntent) { setCreating(false); setPending(intent); setSubmitted(false); setSubmissionOpen(true); setNotice(""); }
  function closeSubmission(unresolved: boolean) {
    setSubmissionOpen(false);
    if (unresolved) setSubmitted(true); else {
      if (pending?.kind === "CREATE") { setCreateInitial(pending.body); setCreating(true); }
      clear(); setPending(null);
    }
  }
  function saved(result: InventoryMutationResult) {
    const action = pending?.kind;
    clear(); setPending(null); setSubmissionOpen(false); setSelectedId(result.inventory.id); setRevision((value) => value + 1);
    setNotice(result.replayed ? "Pedido conferido: ele já havia sido registrado. Os efeitos não foram repetidos." : action === "CREATE" ? "Inventário aberto. A referência dos saldos foi registrada; você já pode iniciar a contagem." : action === "COUNT" ? "Contagens salvas. O estoque ainda não foi alterado." : action === "REBASE" ? "Referências atualizadas. Faça novamente a contagem dos produtos indicados." : action === "CANCEL" ? "Inventário cancelado, com o histórico preservado." : "Inventário concluído. Os ajustes necessários foram registrados no estoque e na auditoria.");
    if (action === "COMPLETE") window.dispatchEvent(new Event("prevision:stock-changed"));
  }
  const blocked = !recoveryReady || !!recoveryError || !!pending;
  return <>
    {!selectedId && canWrite && <div className="inventory-actions"><button className="button-primary" type="button" disabled={blocked} onClick={() => { setCreateInitial(undefined); setCreating(true); }}>Abrir inventário<Icon name="arrow-right" /></button></div>}
    {notice && <p className="form-message form-success catalog-notice" role="status">{notice}</p>}
    {pending && !submissionOpen && <div className="form-message stock-pending-message stock-pending-banner" role="status"><div><strong>Há um pedido de inventário aguardando conferência</strong><p>Verifique o pedido anterior antes de fazer outra alteração nesta aba.</p></div><button className="button-secondary" type="button" onClick={() => setSubmissionOpen(true)}>Conferir o mesmo pedido</button></div>}
    {recoveryError && <div className="form-message form-error catalog-notice" role="alert"><p>{recoveryError}</p><button className="text-link" type="button" onClick={() => setSelectedId(null)}>Consultar inventários</button><button className="text-link" type="button" onClick={() => { clear(); setRecoveryError(""); }}>Já conferi os registros; liberar esta aba</button></div>}
    {selectedId ? <InventoryDetail key={selectedId} inventoryId={selectedId} ownerId={ownerId} canWrite={canWrite} canAdjust={canAdjust} blocked={blocked} revision={revision} onBack={() => setSelectedId(null)} onReview={review} /> : <InventoryIndex revision={revision} onOpen={(inventoryId) => { setSelectedId(inventoryId); setNotice(""); }} />}
    <p className="management-footnote"><Icon name="shield" />{canAdjust ? "Contagens e ajustes ficam registrados com o responsável. Confirmar um inventário preserva o histórico." : canWrite ? "Você pode abrir e contar inventários. A confirmação dos ajustes exige permissão de administrador ou gerente." : "Seu acesso permite consultar as conferências, contagens e ajustes registrados."}</p>
    {creating && <InventoryCreate initial={createInitial} onClose={() => setCreating(false)} onReview={review} />}
    {pending && submissionOpen && <InventorySubmission key={pending.body.idempotencyKey} intent={pending} recovered={submitted} persist={() => { sessionStorage.setItem(storageKey, JSON.stringify({ intent: pending })); setSubmitted(true); }} clear={clear} onClose={closeSubmission} onSaved={saved} />}
  </>;
}
