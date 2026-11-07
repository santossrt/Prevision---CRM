import { canonicalRedirectResponse } from "@/server/security/canonical-origin";

export const runtime = "nodejs";

// Redirect from a route handler because Next's proxy response processing makes
// an absolute loopback-IP Location relative to the server's bind address.
export function GET(request: Request) {
  return canonicalRedirectResponse(request);
}

export function HEAD(request: Request) {
  return canonicalRedirectResponse(request);
}
