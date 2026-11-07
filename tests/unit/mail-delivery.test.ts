import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import nodemailer from "nodemailer-smtp";
import { mkdir, writeFile } from "node:fs/promises";
import { deliverAccessEmail } from "../../src/server/mail/delivery.ts";

vi.mock("node:fs/promises", () => ({ mkdir: vi.fn(), writeFile: vi.fn() }));

beforeEach(() => {
  vi.stubEnv("APP_ENV", "test");
  vi.stubEnv("AUTH_URL", "http://127.0.0.1:3000");
  vi.stubEnv("AUTH_SECRET", "secret-for-mail-delivery-unit-tests-only-0001");
  vi.stubEnv("MAIL_TRANSPORT", "smtp");
  vi.stubEnv("MAIL_FROM", "Prevision <sender@example.invalid>");
  vi.stubEnv("SMTP_HOST", "smtp.example.invalid");
  vi.stubEnv("SMTP_PORT", "587");
  vi.stubEnv("SMTP_USER", "synthetic-user");
  vi.stubEnv("SMTP_PASSWORD", "synthetic-password");
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("envio de mensagens de acesso", () => {
  it.each(["587", "465"])("exige TLS e bloqueia acesso a arquivos e URLs na porta %s", async (port) => {
    vi.stubEnv("SMTP_PORT", port);
    const sendMail = vi.fn().mockResolvedValue({}); const close = vi.fn();
    const create = vi.spyOn(nodemailer, "createTransport").mockReturnValue({ sendMail, close } as unknown as ReturnType<typeof nodemailer.createTransport>);
    await deliverAccessEmail("recipient@example.invalid", "Ativação", "Mensagem de teste");
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      secure: port === "465", requireTLS: port === "587",
      disableFileAccess: true, disableUrlAccess: true, tls: { rejectUnauthorized: true }
    }));
    expect(sendMail).toHaveBeenCalledWith({ from: "Prevision <sender@example.invalid>", to: "recipient@example.invalid", subject: "Ativação", text: "Mensagem de teste" });
    expect(close).toHaveBeenCalledOnce();
  });
  it("não devolve mensagens privadas de falha do transporte e fecha a conexão", async () => {
    const close = vi.fn();
    vi.spyOn(nodemailer, "createTransport").mockReturnValue({ sendMail: vi.fn().mockRejectedValue(new Error("private diagnostic")), close } as unknown as ReturnType<typeof nodemailer.createTransport>);
    await expect(deliverAccessEmail("recipient@example.invalid", "Teste", "Teste")).rejects.toMatchObject({ code: "UNAVAILABLE", message: "Não foi possível enviar o e-mail. Tente novamente." });
    expect(close).toHaveBeenCalledOnce();
  });
  it("mantém a caixa local de teste exclusiva, sem acionar SMTP", async () => {
    vi.stubEnv("MAIL_TRANSPORT", "local");
    const create = vi.spyOn(nodemailer, "createTransport");
    await deliverAccessEmail("recipient@example.invalid", "Teste", "Conteúdo fictício");
    expect(create).not.toHaveBeenCalled();
    expect(mkdir).toHaveBeenCalledWith(expect.stringContaining("mail-test"), { recursive: true, mode: 0o700 });
    expect(writeFile).toHaveBeenCalledWith(expect.stringMatching(/mail-test[\\/][0-9]+-[0-9a-f-]+\.json$/u), expect.any(String), { flag: "wx", mode: 0o600 });
  });
  it("a biblioteca atualizada compõe uma mensagem real somente em memória", async () => {
    const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, disableFileAccess: true, disableUrlAccess: true });
    const result = await transport.sendMail({ from: "sender@example.invalid", to: "recipient@example.invalid", subject: "Teste Prevision", text: "Mensagem fictícia de validação." });
    expect(Buffer.isBuffer(result.message)).toBe(true);
    expect(result.message.toString()).toContain("Subject: Teste Prevision");
    transport.close();
  });
});
