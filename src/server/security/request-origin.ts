import "server-only";
import { isIP } from "node:net";
import { getAuthSettings } from "../auth/settings.ts";
import { ApplicationError } from "../errors/application-error.ts";

const unavailable = () => new ApplicationError("UNAVAILABLE", "A identificação da origem precisa ser configurada para este ambiente.");
function clientIp(request: Request, header: string): string {
  const value = request.headers.get(header)?.trim();
  // A trusted ingress must replace the value with one address. Do not accept
  // chains, ports, arbitrary forwarded prefixes, or an absent client identity.
  if (!value || !isIP(value)) throw unavailable();
  return isIP(value) === 6 ? new URL(`http://[${value}]/`).hostname.slice(1, -1) : value;
}

export function requestOrigin(request: Request): string {
  if (process.env.VERCEL === "1") return clientIp(request, "x-vercel-forwarded-for");
  const header = process.env.REQUEST_IP_HEADER;
  if (header !== undefined && header !== "") {
    if (!/^[a-z][a-z0-9-]{0,63}$/iu.test(header)) throw unavailable();
    return clientIp(request, header);
  }
  const url = getAuthSettings().url;
  if (["development", "test"].includes(process.env.APP_ENV ?? "") && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return "local-development";
  throw unavailable();
}
