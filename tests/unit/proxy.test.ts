import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "../../src/proxy.ts";
import { CANONICAL_TARGET_HEADER, canonicalRedirectResponse } from "../../src/server/security/canonical-origin.ts";

describe("canonical host and browser protections", () => {
  beforeEach(() => {
    vi.stubEnv("APP_ENV", "test");
    vi.stubEnv("AUTH_URL", "http://127.0.0.1:3000");
    vi.stubEnv("AUTH_SECRET", "test-secret-with-more-than-thirty-two-characters");
    vi.stubEnv("MAIL_TRANSPORT", "local");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("accepts the configured IP even when NextURL normalizes it to localhost", () => {
    const request = new NextRequest("http://127.0.0.1:3000/login", { headers: { host: "127.0.0.1:3000" } });
    expect(request.nextUrl.host).toBe("localhost:3000");
    const response = proxy(request);
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("content-security-policy")).toContain("'nonce-");
    expect(response.cookies.get("prevision.csrf")?.value).toBeTruthy();
  });

  it("redirects an alternative host to the configured origin", () => {
    const response = proxy(new NextRequest("http://localhost:3000/login?next=perfil", { headers: { host: "localhost:3000" } }));
    expect(response.headers.get("x-middleware-rewrite")).toContain("/api/access/canonical-origin");
    const target = response.headers.get(`x-middleware-request-${CANONICAL_TARGET_HEADER}`);
    expect(target).toBeTruthy();
    const redirect = canonicalRedirectResponse(new Request("http://localhost:3000/api/access/canonical-origin", { headers: { host: "localhost:3000", [CANONICAL_TARGET_HEADER]: target! } }));
    expect(redirect.status).toBe(308);
    expect(redirect.headers.get("location")).toBe("http://127.0.0.1:3000/login?next=perfil");
    expect(redirect.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects mutations sent to a different host", () => {
    expect(proxy(new NextRequest("http://localhost:3000/api/users", { method: "POST", headers: { host: "localhost:3000" } })).status).toBe(403);
  });

  it("overwrites an injected internal target and rejects direct access to the internal route", () => {
    const response = proxy(new NextRequest("http://localhost:3000/login", { headers: { host: "localhost:3000", [CANONICAL_TARGET_HEADER]: "injected" } }));
    expect(response.headers.get(`x-middleware-request-${CANONICAL_TARGET_HEADER}`)).toBe(JSON.stringify({ pathname: "/login", search: "" }));
    expect(proxy(new NextRequest("http://localhost:3000/api/access/canonical-origin", { headers: { host: "localhost:3000" } })).status).toBe(404);
    expect(canonicalRedirectResponse(new Request("http://127.0.0.1:3000/api/access/canonical-origin", { headers: { host: "127.0.0.1:3000", [CANONICAL_TARGET_HEADER]: JSON.stringify({ pathname: "/login", search: "" }) } })).status).toBe(404);
  });

  it("keeps the configured origin even for a target path beginning with two slashes", () => {
    const response = canonicalRedirectResponse(new Request("http://localhost:3000/api/access/canonical-origin", { headers: { host: "localhost:3000", [CANONICAL_TARGET_HEADER]: JSON.stringify({ pathname: "//other.example/path", search: "?error=Configuration" }) } }));
    const destination = new URL(response.headers.get("location")!);
    expect(destination.origin).toBe("http://127.0.0.1:3000");
    expect(destination.pathname).toBe("//other.example/path");
  });
});
