"use client";

export class CatalogRequestError extends Error {
  readonly status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

function csrfToken() {
  const cookie = document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith("prevision.csrf="));
  try { return cookie ? decodeURIComponent(cookie.slice("prevision.csrf=".length)) : ""; } catch { return ""; }
}

export async function catalogRequest<T>(url: string, options: { signal?: AbortSignal; method?: "POST" | "PATCH"; body?: unknown } = {}): Promise<T> {
  const response = await fetch(url, {
    cache: "no-store", credentials: "same-origin", signal: options.signal,
    ...(options.method ? { method: options.method, headers: { "Content-Type": "application/json", "X-Prevision-CSRF": csrfToken() }, body: JSON.stringify(options.body) } : {})
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new CatalogRequestError(result?.message || "Não foi possível concluir a solicitação. Tente novamente.", response.status);
  return result as T;
}

export function catalogError(error: unknown): string {
  if (error instanceof TypeError) return "Não foi possível conectar ao Prevision. Confira sua conexão e tente novamente.";
  return error instanceof Error ? error.message : "Não foi possível concluir a solicitação. Tente novamente.";
}

export function isCancelled(error: unknown): boolean { return error instanceof DOMException && error.name === "AbortError"; }
