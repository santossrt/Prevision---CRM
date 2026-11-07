import type { Metadata } from "next";
import { WorkspaceShell } from "@/components/layout/workspace-shell";
import { NotificationsManager } from "@/components/notifications/notifications-manager";
import { requireIdentity } from "@/server/auth/identity";

export const metadata: Metadata = { title: "Notificações" };

export default async function NotificationsPage() {
  const identity = await requireIdentity();
  return <WorkspaceShell identity={identity}><div className="management-intro"><p className="eyebrow">CENTRAL DE NOTIFICAÇÕES</p><h1>O que merece sua atenção<span>.</span></h1><p>Acompanhe os avisos da equipe e os acontecimentos do estoque em um só lugar.</p></div><NotificationsManager ownerId={identity.id} canPublish={identity.role === "ADMINISTRATOR" && identity.permissions.includes("settings.manage")} /></WorkspaceShell>;
}
