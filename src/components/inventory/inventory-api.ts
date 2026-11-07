"use client";

import type { CountInventoryInput, CreateInventoryInput, InventoryActionInput, InventoryMutationResult, RebaseInventoryInput } from "@/lib/inventory/types";

export { catalogRequest as inventoryRequest, catalogError as inventoryError, isCancelled } from "@/components/catalog/catalog-api";

interface IntentReview { title: string; description: string; lines: string[] }
export type InventoryIntent =
  | { kind: "CREATE"; body: CreateInventoryInput; review: IntentReview }
  | { kind: "COUNT"; inventoryId: string; body: CountInventoryInput; review: IntentReview }
  | { kind: "REBASE"; inventoryId: string; body: RebaseInventoryInput; review: IntentReview }
  | { kind: "COMPLETE" | "CANCEL"; inventoryId: string; body: InventoryActionInput; review: IntentReview };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function inventoryStorageKey(ownerId: string): string { return `prevision.inventory.pending.v1.${ownerId}`; }
const ids = (value: unknown, maximum: number): value is string[] => Array.isArray(value) && value.length > 0 && value.length <= maximum && value.every((id) => typeof id === "string" && uuid.test(id)) && new Set(value).size === value.length;
const nullableText = (value: unknown, maximum: number) => value === undefined || value === null || typeof value === "string" && value.length <= maximum;
export function recoverInventoryIntent(raw: string): InventoryIntent {
  const stored: unknown = JSON.parse(raw);
  if (!stored || typeof stored !== "object" || !("intent" in stored)) throw new Error("invalid-pending-inventory");
  const intent = stored.intent as InventoryIntent;
  if (!intent || !["CREATE", "COUNT", "REBASE", "COMPLETE", "CANCEL"].includes(intent.kind) || !intent.body || !uuid.test(intent.body.idempotencyKey)
    || !intent.review || typeof intent.review.title !== "string" || typeof intent.review.description !== "string"
    || !Array.isArray(intent.review.lines) || intent.review.lines.length > 200 || !intent.review.lines.every((line) => typeof line === "string" && line.length <= 2000)) throw new Error("invalid-pending-inventory");
  if (intent.kind === "CREATE") {
    if (typeof intent.body.title !== "string" || !intent.body.title.trim() || intent.body.title.length > 160 || !nullableText(intent.body.notes, 2000) || !["all", "products", "categories"].includes(intent.body.scope)) throw new Error("invalid-pending-inventory");
    if (intent.body.scope === "products" && !ids(intent.body.productIds, 200)) throw new Error("invalid-pending-inventory");
    if (intent.body.scope === "categories" && !ids(intent.body.categoryIds, 200)) throw new Error("invalid-pending-inventory");
  } else {
    if (!uuid.test(intent.inventoryId) || !Number.isInteger(intent.body.expectedVersion) || intent.body.expectedVersion < 0) throw new Error("invalid-pending-inventory");
    if (intent.kind === "COUNT" && (!Array.isArray(intent.body.items) || intent.body.items.length < 1 || intent.body.items.length > 20 || !intent.body.items.every((item) => item && uuid.test(item.productId) && typeof item.countedQuantity === "string" && /^\d{1,14}\.\d{4}$/.test(item.countedQuantity) && nullableText(item.justification, 600)))) throw new Error("invalid-pending-inventory");
    if (intent.kind === "REBASE" && !ids(intent.body.productIds, 200)) throw new Error("invalid-pending-inventory");
  }
  return intent;
}

export class InventorySubmissionError extends Error {
  constructor(message: string, readonly uncertain: boolean) { super(message); }
}

export async function submitInventoryIntent(intent: InventoryIntent): Promise<InventoryMutationResult> {
  const paths = { COUNT: "counts", REBASE: "rebase", COMPLETE: "complete", CANCEL: "cancel" } as const;
  const path = intent.kind === "CREATE" ? "/api/inventories" : `/api/inventories/${encodeURIComponent(intent.inventoryId)}/${paths[intent.kind]}`;
  const cookie = document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith("prevision.csrf="));
  let csrf = "";
  try { csrf = cookie ? decodeURIComponent(cookie.slice("prevision.csrf=".length)) : ""; } catch { /* rejected by the server */ }
  let response: Response;
  try {
    response = await fetch(path, {
      method: intent.kind === "COUNT" ? "PATCH" : "POST", credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(30000),
      headers: { "Content-Type": "application/json", "X-Prevision-CSRF": csrf }, body: JSON.stringify(intent.body)
    });
  } catch { throw new InventorySubmissionError("A conexão foi interrompida antes da confirmação. O pedido pode ter sido registrado.", true); }
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new InventorySubmissionError(typeof result?.message === "string" ? result.message : "Não foi possível confirmar o pedido.", response.status >= 500);
  if (!result?.inventory?.id || !Array.isArray(result.inventory.items) || typeof result.replayed !== "boolean") {
    throw new InventorySubmissionError("O servidor respondeu sem a confirmação completa do inventário.", true);
  }
  return result as InventoryMutationResult;
}
