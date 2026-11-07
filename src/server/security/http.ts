import "server-only";
import { ZodError } from "zod";
import { ApplicationError } from "../errors/application-error.ts";
import { getAuthSettings, sessionCookieName } from "../auth/settings.ts";
import { readCookie, verifyCsrfToken } from "./csrf.ts";
import { consumeRateLimit } from "./rate-limit.ts";
import { errorDiagnostic } from "./error-diagnostic.ts";
import { readBoundedBody } from "./body-reader.ts";
import { requestOrigin } from "./request-origin.ts";

export { requestOrigin } from "./request-origin.ts";

export function assertTrustedHost(request: Request) {
  if (request.headers.get("host")?.toLowerCase() !== getAuthSettings().url.host.toLowerCase()) throw new ApplicationError("FORBIDDEN", "Origem inválida.");
}

export function assertSameOrigin(request: Request) {
  assertTrustedHost(request);
  if (request.headers.get("origin") !== getAuthSettings().url.origin || request.headers.get("sec-fetch-site") === "cross-site") {
    throw new ApplicationError("FORBIDDEN", "Origem inválida. Recarregue a página.");
  }
}

export function assertCsrf(request: Request) {
  assertSameOrigin(request);
  const settings = getAuthSettings();
  const cookie = request.headers.get("cookie") ?? "";
  const supplied = request.headers.get("X-Prevision-CSRF") ?? "";
  if (supplied !== readCookie(cookie, "prevision.csrf") || !verifyCsrfToken(supplied, readCookie(cookie, sessionCookieName()), settings.secret)) {
    throw new ApplicationError("FORBIDDEN", "Sua página expirou. Recarregue e tente novamente.");
  }
}

export async function readJson(request: Request, maximumBytes: 16384 | 65536 = 16384): Promise<unknown> {
  assertCsrf(request);
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") throw new ApplicationError("VALIDATION", "Envie dados em JSON.");
  const text = (await readBoundedBody(request, maximumBytes)).toString("utf8");
  try { return JSON.parse(text); } catch { throw new ApplicationError("VALIDATION", "Dados inválidos."); }
}

export async function limitRequest(request: Request, operation: string, limit = 60, seconds = 900, account?: string) {
  const result = await consumeRateLimit([operation, requestOrigin(request), ...(account ? [account] : [])], limit, seconds);
  if (!result.allowed) throw new ApplicationError("RATE_LIMIT", "Muitas tentativas. Aguarde e tente novamente.");
}

export function errorResponse(error: unknown) {
  if (error instanceof ZodError) return Response.json({ message: "Confira os campos informados." }, { status: 400 });
  if (error instanceof ApplicationError) {
    const status = { VALIDATION: 400, UNAUTHORIZED: 401, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409, RATE_LIMIT: 429, UNAVAILABLE: 503 }[error.code];
    return Response.json({ message: error.message }, { status, headers: error.code === "RATE_LIMIT" ? { "Retry-After": "900" } : undefined });
  }
  console.error("[prevision] Operação não concluída; detalhes sensíveis foram omitidos.", errorDiagnostic(error));
  return Response.json({ message: "Não foi possível concluir a operação. Tente novamente." }, { status: 503 });
}
