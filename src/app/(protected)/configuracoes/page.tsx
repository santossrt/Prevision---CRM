import type { Metadata } from "next";
import { WorkspaceShell } from "@/components/layout/workspace-shell";
import { AppearanceSettings } from "@/components/preferences/appearance-settings";
import { requireIdentity } from "@/server/auth/identity";

export const metadata: Metadata = { title: "Configurações" };

export default async function SettingsPage() {
  const identity = await requireIdentity();
  return <WorkspaceShell identity={identity}><div className="management-intro"><p className="eyebrow">DO SEU JEITO</p><h1>Seu espaço, sua preferência<span>.</span></h1><p>Ajuste a aparência para trabalhar com conforto em qualquer dispositivo.</p></div><AppearanceSettings /></WorkspaceShell>;
}
