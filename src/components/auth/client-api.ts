"use client";

function csrfToken() {
  const value = document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith("prevision.csrf="));
  if (!value) return "";
  try { return decodeURIComponent(value.slice("prevision.csrf=".length)); } catch { return ""; }
}

export async function sendJson<T = { message: string }>(url: string, body: unknown, method: "POST" | "PATCH" = "POST"): Promise<T> {
  const response = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-Prevision-CSRF": csrfToken() },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(result?.message || "Não foi possível concluir a solicitação. Tente novamente.");
  return result as T;
}

export function errorMessage(error: unknown) {
  if (error instanceof TypeError) return "Não foi possível conectar ao Prevision. Confira sua conexão e tente novamente.";
  return error instanceof Error ? error.message : "Não foi possível concluir a solicitação. Tente novamente.";
}
