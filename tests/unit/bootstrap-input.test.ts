import { describe, expect, it, vi } from "vitest";
import { collectBootstrapCredentials } from "../../scripts/database/bootstrap-input.ts";

function fixture(answers: string[]) {
  const remaining = [...answers];
  const ask = vi.fn(async (_message: string, _secret?: boolean) => {
    if (!remaining.length) throw new Error("Entrada encerrada.");
    return remaining.shift()!;
  });
  const notify = vi.fn();
  return { ask, notify };
}

describe("cadastro interativo do administrador", () => {
  it("permite corrigir senha vazia e curta sem pedir o e-mail novamente", async () => {
    const prompts = fixture([" ADMIN@example.invalid ", "", "12345678901", "uma senha valida longa", "uma senha valida longa"]);
    await expect(collectBootstrapCredentials(prompts)).resolves.toEqual({ email: "admin@example.invalid", password: "uma senha valida longa" });
    expect(prompts.ask.mock.calls.filter(([, secret]) => !secret)).toHaveLength(1);
    expect(prompts.notify.mock.calls.filter(([message]) => String(message).includes("12 a 128"))).toHaveLength(2);
  });

  it("exige confirmação igual e mantém as perguntas de senha ocultas", async () => {
    const first = "primeira senha secreta";
    const second = "segunda senha secreta";
    const prompts = fixture([first, "confirmacao diferente", second, second]);
    await expect(collectBootstrapCredentials(prompts, { email: "admin@example.invalid" })).resolves.toEqual({ email: "admin@example.invalid", password: second });
    expect(prompts.ask.mock.calls.every(([, secret]) => secret === true)).toBe(true);
    const messages = JSON.stringify([...prompts.ask.mock.calls, ...prompts.notify.mock.calls]);
    expect(messages).not.toContain(first);
    expect(messages).not.toContain(second);
    expect(messages).not.toContain("confirmacao diferente");
  });

  it("permite corrigir e-mail inválido antes de pedir a senha", async () => {
    const prompts = fixture(["invalido", "admin@example.invalid", "uma senha longa valida", "uma senha longa valida"]);
    await expect(collectBootstrapCredentials(prompts)).resolves.toHaveProperty("email", "admin@example.invalid");
    expect(prompts.notify).toHaveBeenCalledWith(expect.stringContaining("E-mail inválido"));
  });

  it("preserva credenciais válidas fornecidas pelo ambiente sem perguntas", async () => {
    const prompts = fixture([]);
    await expect(collectBootstrapCredentials(prompts, { email: "ADMIN@example.invalid", password: "  senha com espacos  " })).resolves.toEqual({ email: "admin@example.invalid", password: "  senha com espacos  " });
    expect(prompts.ask).not.toHaveBeenCalled();
  });

  it("interrompe quando a entrada fecha em vez de continuar repetindo", async () => {
    const prompts = fixture([]);
    await expect(collectBootstrapCredentials(prompts, { email: "admin@example.invalid" })).rejects.toThrow("Entrada encerrada.");
    expect(prompts.ask).toHaveBeenCalledTimes(1);
  });
});
