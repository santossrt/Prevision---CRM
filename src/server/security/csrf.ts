import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

function signature(nonce: string, expires: string, session: string, secret: string) {
  return createHmac("sha256", secret).update(JSON.stringify(["prevision-csrf-v1", nonce, expires, session])).digest("hex");
}

export function createCsrfToken(session: string, secret: string, now = Date.now()) {
  const nonce = randomBytes(32).toString("hex");
  const expires = String(Math.floor(now / 1000) + 7200);
  return `${nonce}.${expires}.${signature(nonce, expires, session, secret)}`;
}

export function verifyCsrfToken(value: string | undefined, session: string, secret: string, now = Date.now()) {
  if (!value || value.length > 200) return false;
  const [nonce, expires, supplied, ...extra] = value.split(".");
  if (extra.length || !/^[0-9a-f]{64}$/.test(nonce ?? "") || !/^\d{10}$/.test(expires ?? "") || !/^[0-9a-f]{64}$/.test(supplied ?? "")) return false;
  const epoch = Math.floor(now / 1000);
  if (Number(expires) <= epoch || Number(expires) > epoch + 7200) return false;
  return timingSafeEqual(Buffer.from(supplied, "hex"), Buffer.from(signature(nonce, expires, session, secret), "hex"));
}

export function readCookie(header: string, name: string): string {
  const entries = header.split(";").map((entry) => entry.trim().split(/=(.*)/s));
  const direct = entries.find(([key]) => key === name);
  if (direct) return direct[1] ?? "";
  return entries.filter(([key]) => key.startsWith(`${name}.`) && /^\d+$/.test(key.slice(name.length + 1)))
    .sort(([a], [b]) => Number(a.slice(name.length + 1)) - Number(b.slice(name.length + 1)))
    .map(([, value]) => value).join("");
}
