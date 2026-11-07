import { getAuthSettings } from "../auth/settings.ts";

export const CANONICAL_REDIRECT_PATH = "/api/access/canonical-origin";
export const CANONICAL_TARGET_HEADER = "x-prevision-canonical-target";

export function canonicalRedirectResponse(request: Request): Response {
  const settings = getAuthSettings();
  const host = request.headers.get("host");
  const rawTarget = request.headers.get(CANONICAL_TARGET_HEADER);
  const missing = () => new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
  if (!host || host.toLowerCase() === settings.url.host.toLowerCase() || !rawTarget || rawTarget.length > 16_384) return missing();
  let targetParts: unknown;
  try { targetParts = JSON.parse(rawTarget); } catch { return missing(); }
  if (!targetParts || typeof targetParts !== "object" || Array.isArray(targetParts)) return missing();
  const { pathname, search } = targetParts as Record<string, unknown>;
  if (typeof pathname !== "string" || !pathname.startsWith("/") || pathname === CANONICAL_REDIRECT_PATH
    || typeof search !== "string" || (search !== "" && !search.startsWith("?"))) return missing();

  // Assign path/query independently so even a path such as //other.example
  // cannot replace the configured origin.
  const destination = new URL(settings.url);
  destination.pathname = pathname;
  destination.search = search;
  return new Response(null, {
    status: 308,
    headers: { Location: destination.href, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" }
  });
}
