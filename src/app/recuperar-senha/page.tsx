import type { Metadata } from "next";
import { AccessShell } from "@/components/auth/access-shell";
import { PasswordResetRequestForm } from "@/components/auth/access-forms";

export const metadata: Metadata = { title: "Recupere seu acesso" };

export default function RecoverPasswordPage() {
  return <AccessShell title="Vamos recuperar seu acesso" description="Informe seu e-mail para solicitar as instruções de recuperação de senha."><PasswordResetRequestForm /></AccessShell>;
}
