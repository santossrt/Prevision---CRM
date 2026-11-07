import { emailSchema } from "../../src/server/auth/settings.ts";
import { passwordSchema } from "../../src/server/security/password.ts";

export interface BootstrapPrompts {
  ask: (message: string, secret?: boolean) => Promise<string>;
  notify: (message: string) => void;
}

export async function collectBootstrapCredentials(
  prompts: BootstrapPrompts,
  initial: { email?: string; password?: string } = {}
): Promise<{ email: string; password: string }> {
  let email = emailSchema.safeParse(initial.email);
  while (!email.success) {
    email = emailSchema.safeParse(await prompts.ask("E-mail do primeiro administrador: "));
    if (!email.success) prompts.notify("E-mail inválido. Digite um endereço completo e tente novamente.");
  }

  const suppliedPassword = passwordSchema.safeParse(initial.password);
  if (suppliedPassword.success) return { email: email.data, password: suppliedPassword.data };

  prompts.notify("A senha fica oculta: não aparecem letras nem asteriscos. Digite e pressione Enter.");
  while (true) {
    const password = passwordSchema.safeParse(await prompts.ask("Senha (12 a 128 caracteres): ", true));
    if (!password.success) {
      prompts.notify("A senha precisa ter de 12 a 128 caracteres. Digite novamente.");
      continue;
    }
    const confirmation = await prompts.ask("Repita a senha para confirmar: ", true);
    if (password.data !== confirmation) {
      prompts.notify("As senhas não coincidem. Digite a senha e a confirmação novamente.");
      continue;
    }
    return { email: email.data, password: password.data };
  }
}
