import type { Metadata } from "next";
import { AccessShell } from "@/components/auth/access-shell";
import { SetPasswordForm } from "@/components/auth/access-forms";

export const metadata: Metadata = { title: "Defina uma nova senha" };

export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  return <AccessShell title="Uma nova senha para continuar" description="Escolha uma senha longa e exclusiva para o seu acesso ao Prevision."><SetPasswordForm token={typeof token === "string" ? token : ""} mode="reset" /></AccessShell>;
}
