import type { Metadata } from "next";
import { AccessShell } from "@/components/auth/access-shell";
import { SetPasswordForm } from "@/components/auth/access-forms";
import { getAuthCapabilities } from "@/server/auth/settings";

export const metadata: Metadata = { title: "Ative seu acesso" };

export default async function ActivateAccessPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const [capabilities, { token }] = await Promise.all([getAuthCapabilities(), searchParams]);
  return <AccessShell title="Seu espaço está esperando" description="Ative seu acesso definindo uma senha ou conectando sua conta Google, quando autorizado."><SetPasswordForm token={typeof token === "string" ? token : ""} mode="activation" googleAvailable={capabilities.google} /></AccessShell>;
}
