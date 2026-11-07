import { handlers } from "@/server/auth/config";
import { getToken } from "next-auth/jwt";
import { assertSameOrigin, assertTrustedHost, errorResponse, limitRequest } from "@/server/security/http";
import { getAuthSettings, sessionCookieName } from "@/server/auth/settings";
import { revokeLoginSession } from "@/server/auth/sessions";
import { BodyReadError, readBoundedBody } from "@/server/security/body-reader";
import { NextRequest } from "next/server";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    assertTrustedHost(request);
    await limitRequest(request, "auth-read", 240, 60);
    return await handlers.GET(request);
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    await limitRequest(request, "auth-write", 120, 900);
    const body = await readBoundedBody(request, 16384);
    const headers = new Headers(request.headers);
    headers.set("content-length", String(body.byteLength));
    headers.delete("transfer-encoding");
    // The original request has already been consumed. Construct from its URL,
    // not from that consumed Request object (framework adapters can retain its
    // disturbed body even when an init.body override is supplied).
    const boundedRequest = new NextRequest(request.url, {
      method: request.method, headers, body: new Uint8Array(body),
      credentials: request.credentials, redirect: request.redirect, signal: request.signal
    });
    if (new URL(request.url).pathname.endsWith("/signout")) {
      const token = await getToken({ req: boundedRequest, secret: getAuthSettings().secret, cookieName: sessionCookieName(), salt: sessionCookieName() });
      if (token) await revokeLoginSession(token.sid, token.sub);
    }
    return await handlers.POST(boundedRequest);
  } catch (error) {
    if (!request.bodyUsed) void request.body?.cancel().catch(() => {});
    if (error instanceof BodyReadError && ["TOO_LARGE", "TIMEOUT"].includes(error.reason)) return Response.json({ message: error.message }, { status: error.reason === "TOO_LARGE" ? 413 : 408, headers: { "Cache-Control": "no-store" } });
    return errorResponse(error);
  }
}
