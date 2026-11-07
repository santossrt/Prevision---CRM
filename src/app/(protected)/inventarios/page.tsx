import Link from "next/link";
import type { Metadata } from "next";
import { WorkspaceShell } from "@/components/layout/workspace-shell";
import { InventoryManager } from "@/components/inventory/inventory-manager";
import { requireIdentity } from "@/server/auth/identity";

export const metadata: Metadata = { title: "Inventário físico" };

export default async function InventoriesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const identity = await requireIdentity();
  const candidate = (await searchParams).id;
  const initialInventoryId = typeof candidate === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(candidate) ? candidate : undefined;
  return <WorkspaceShell identity={identity}><div className="management-intro inventory-intro"><p className="eyebrow">INVENTÁRIO FÍSICO</p><h1>Conferir para ter certeza<span>.</span></h1><p>Compare as quantidades físicas com o sistema e registre cada ajuste com sua justificativa.</p></div>{identity.permissions.includes("stock.read") ? <InventoryManager ownerId={identity.id} canWrite={identity.permissions.includes("stock.write")} canAdjust={identity.permissions.includes("stock.adjust")} initialInventoryId={initialInventoryId} /> : <section className="management-panel denied-panel"><h2>Esta área exige permissão de consulta</h2><p>Fale com o administrador se precisar consultar os inventários.</p><Link className="button-secondary" href="/">Voltar para a visão geral</Link></section>}</WorkspaceShell>;
}
