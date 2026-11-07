import "server-only";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import nodemailer from "nodemailer-smtp";
import { getAuthSettings } from "../auth/settings.ts";
import { ApplicationError } from "../errors/application-error.ts";

export async function deliverAccessEmail(to: string, subject: string, text: string) {
  const settings = getAuthSettings();
  if (settings.transport === "local") {
    const directory = process.env.APP_ENV === "test"
      ? resolve(process.cwd(), ".cache/mail-test")
      : resolve(process.cwd(), ".cache/mail");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(resolve(directory, `${Date.now()}-${randomUUID()}.json`), JSON.stringify({ to, subject, text, createdAt: new Date().toISOString() }, null, 2), { flag: "wx", mode: 0o600 });
    return;
  }
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASSWORD || !process.env.MAIL_FROM) {
    throw new ApplicationError("UNAVAILABLE", "O envio de e-mail não está configurado.");
  }
  const port = Number(process.env.SMTP_PORT ?? "587");
  if (![465, 587].includes(port)) throw new ApplicationError("UNAVAILABLE", "Configuração SMTP inválida.");
  const transporter = nodemailer.createTransport({
    disableFileAccess: true, disableUrlAccess: true,
    host: process.env.SMTP_HOST, port, secure: port === 465, requireTLS: port === 587,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
    tls: { rejectUnauthorized: true }
  });
  try { await transporter.sendMail({ from: process.env.MAIL_FROM, to, subject, text }); }
  catch { throw new ApplicationError("UNAVAILABLE", "Não foi possível enviar o e-mail. Tente novamente."); }
  finally { transporter.close(); }
}
