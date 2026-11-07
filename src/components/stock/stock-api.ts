"use client";
import type { MovementResult } from "@/lib/stock/types";
import type { StockIntent } from "./stock-intent";

export { catalogRequest as stockRequest, catalogError as stockError, isCancelled } from "@/components/catalog/catalog-api";

export class StockSubmissionError extends Error {
  constructor(message: string, readonly uncertain: boolean) { super(message); }
}
export async function submitStockIntent(intent: StockIntent): Promise<MovementResult> {
  const cookie = document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith("prevision.csrf="));
  let csrf = "";
  try { csrf = cookie ? decodeURIComponent(cookie.slice("prevision.csrf=".length)) : ""; } catch { /* server rejects invalid cookie */ }
  const path = intent.kind === "movement" ? "/api/stock/movements" : `/api/stock/movements/${encodeURIComponent(intent.movementId)}/compensate`;
  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST", credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(30000),
      headers: { "Content-Type": "application/json", "X-Prevision-CSRF": csrf }, body: JSON.stringify(intent.body)
    });
  } catch { throw new StockSubmissionError("A conexão foi interrompida antes da confirmação. O lançamento pode ter sido registrado.", true); }
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new StockSubmissionError(result?.message || "Não foi possível confirmar o lançamento.", response.status >= 500);
  if (!result?.movement?.id || typeof result.replayed !== "boolean") throw new StockSubmissionError("O servidor respondeu sem a confirmação completa do lançamento.", true);
  return result as MovementResult;
}
