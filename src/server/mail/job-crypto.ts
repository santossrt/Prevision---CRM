import "server-only";
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { emailSchema } from "../auth/settings.ts";
import { ApplicationError } from "../errors/application-error.ts";

const unavailable = () => new ApplicationError("UNAVAILABLE", "Não foi possível processar a recuperação de acesso.");
const jobIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function context(jobId: string) {
  const secret = process.env.AUTH_SECRET; const databaseId = process.env.DATABASE_ID;
  if (!jobIdPattern.test(jobId) || !secret || secret.length < 32 || !databaseId || databaseId.length > 100) throw unavailable();
  const label = "prevision.password-reset-jobs.v1";
  return {
    key: Buffer.from(hkdfSync("sha256", Buffer.from(secret, "utf8"), Buffer.from(databaseId, "utf8"), Buffer.from(label), 32)),
    aad: Buffer.from(JSON.stringify([label, databaseId, jobId.toLowerCase()]), "utf8")
  };
}

/** This queue stores only the requested address, never an access token. */
export function encryptResetJobEmail(jobId: string, email: string): string {
  const normalized = emailSchema.parse(email); const { key, aad } = context(jobId);
  const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(normalized, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function decryptResetJobEmail(jobId: string, payload: string): string {
  try {
    if (typeof payload !== "string" || payload.length > 1536 || !/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{1,1024}$/u.test(payload)) throw unavailable();
    const [, encodedIv, encodedTag, encodedCiphertext] = payload.split(".");
    const { key, aad } = context(jobId);
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(encodedIv, "base64url"));
    decipher.setAAD(aad); decipher.setAuthTag(Buffer.from(encodedTag, "base64url"));
    const cleartext = Buffer.concat([decipher.update(Buffer.from(encodedCiphertext, "base64url")), decipher.final()]);
    return emailSchema.parse(new TextDecoder("utf-8", { fatal: true }).decode(cleartext));
  } catch { throw unavailable(); }
}
