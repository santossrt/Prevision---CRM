import type { Metadata } from "next";
import { AccessShell } from "@/components/auth/access-shell";
import { LoginForm } from "@/components/auth/access-forms";
import { getAuthCapabilities } from "@/server/auth/settings";

export const metadata: Metadata = { title: "Acesse seu ambiente" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const [capabilities, params] = await Promise.all([getAuthCapabilities(), searchParams]);
  return <AccessShell title="Bom ter você por aqui" description="Entre no seu ambiente para continuar a cuidar do seu estoque." backLink={false}><LoginForm googleAvailable={capabilities.google} initialError={!!params.error} /></AccessShell>;
}
