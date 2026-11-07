import { NextResponse, type NextRequest } from "next/server";
import { getAuthSettings, sessionCookieName } from "./server/auth/settings.ts";
import { createCsrfToken, readCookie, verifyCsrfToken } from "./server/security/csrf.ts";
import { CANONICAL_REDIRECT_PATH, CANONICAL_TARGET_HEADER } from "./server/security/canonical-origin.ts";

export function proxy(request: NextRequest) {
  const settings = getAuthSettings();
  // NextURL normalizes loopback IPs to localhost; Host retains the address used.
  if (request.headers.get("host")?.toLowerCase() !== settings.url.host.toLowerCase()) {
    if (!["GET", "HEAD"].includes(request.method)) return new NextResponse("Origem inválida.", { status: 403 });
    if (request.nextUrl.pathname === CANONICAL_REDIRECT_PATH) return new NextResponse(null, { status: 404 });
    const headers = new Headers(request.headers);
    headers.set(CANONICAL_TARGET_HEADER, JSON.stringify({ pathname: request.nextUrl.pathname, search: request.nextUrl.search }));
    const internal = new URL(request.url);
    internal.pathname = CANONICAL_REDIRECT_PATH;
    internal.search = "";
    const response = NextResponse.rewrite(internal, { request: { headers } });
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("Referrer-Policy", "no-referrer");
    return response;
  }
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const development = process.env.NODE_ENV === "development";
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'", "img-src 'self' data:", "font-src 'self'",
    `connect-src 'self'${development ? " ws: wss:" : ""}`,
    "object-src 'none'", "base-uri 'self'", "form-action 'self' https://accounts.google.com", "frame-ancestors 'none'"
  ].join("; ");
  const requestHeaders = new Headers(request.headers);
  requestHeaders.delete(CANONICAL_TARGET_HEADER);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  response.headers.set("Referrer-Policy", "no-referrer");
  if (settings.secure) response.headers.set("Strict-Transport-Security", "max-age=31536000");
  const session = readCookie(request.headers.get("cookie") ?? "", sessionCookieName());
  const existing = request.cookies.get("prevision.csrf")?.value;
  if (!verifyCsrfToken(existing, session, settings.secret)) {
    response.cookies.set("prevision.csrf", createCsrfToken(session, settings.secret), {
      httpOnly: false, secure: settings.secure, sameSite: "lax", path: "/", maxAge: 7200
    });
  }
  return response;
}

export const config = { matcher: ["/((?!_next/static|_next/image|icon.svg|favicon.ico|api/health).*)"] };
