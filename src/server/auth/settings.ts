import { z } from "zod";

export function getAuthSettings() {
  const secret = process.env.AUTH_SECRET;
  const rawUrl = process.env.AUTH_URL;
  if (!secret || secret.length < 32 || !rawUrl) throw new Error("Configure AUTH_SECRET e AUTH_URL; consulte .env.example.");
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new Error("AUTH_URL inválida."); }
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" || (url.protocol !== "https:" && !(url.protocol === "http:" && ["development", "test"].includes(process.env.APP_ENV ?? "") && local))) {
    throw new Error("AUTH_URL exige HTTPS; HTTP é permitido somente no desenvolvimento local.");
  }
  const transport = process.env.MAIL_TRANSPORT ?? "local";
  if (!["local", "smtp"].includes(transport) || (transport === "local" && !["development", "test"].includes(process.env.APP_ENV ?? ""))) {
    throw new Error("Configure um transporte de e-mail válido para este ambiente.");
  }
  return { secret, url, secure: url.protocol === "https:", transport: transport as "local" | "smtp", sessionSeconds: 8 * 60 * 60, idleSeconds: 30 * 60 };
}

export function getAuthCapabilities(): { google: boolean; emailDelivery: "local" | "smtp" } {
  return { google: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET), emailDelivery: getAuthSettings().transport };
}

export function sessionCookieName() {
  return getAuthSettings().secure ? "__Secure-prevision.session-token" : "prevision.session-token";
}

export const emailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));
export const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
