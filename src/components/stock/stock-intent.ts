import type { CompensateMovementInput, CreateMovementInput, MovementType } from "@/lib/stock/types";

export interface MovementReview {
  productName: string;
  sku: string;
  unit: string;
  type: MovementType;
  quantityDelta: string;
  quantityBefore: string;
  unitCost: string;
  unitPrice: string | null;
  supplier: string | null;
  customer: string | null;
  occurredAt: string;
  justification: string | null;
  notes: string | null;
}
export type StockIntent =
  | { kind: "movement"; body: CreateMovementInput; review: MovementReview }
  | { kind: "compensation"; movementId: string; body: CompensateMovementInput; review: MovementReview };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const types = ["ENTRY", "EXIT", "POSITIVE_ADJUSTMENT", "NEGATIVE_ADJUSTMENT", "COMPENSATION"];

/** Recovery data contains operation input only, never session credentials. */
export function recoverIntent(raw: string): StockIntent {
  if (raw.length > 24000) throw new Error("invalid-pending-operation");
  const stored: unknown = JSON.parse(raw);
  if (typeof stored !== "object" || !stored || !("intent" in stored)) throw new Error("invalid-pending-operation");
  const intent = stored.intent as StockIntent;
  if (!intent || !["movement", "compensation"].includes(intent.kind) || !intent.body || !uuid.test(intent.body.idempotencyKey) || !intent.review) throw new Error("invalid-pending-operation");
  const review = intent.review;
  if (typeof review.productName !== "string" || typeof review.sku !== "string" || typeof review.unit !== "string" || !types.includes(review.type)
    || !/^-?\d{1,14}\.\d{4}$/.test(review.quantityDelta) || !/^\d{1,14}\.\d{4}$/.test(review.quantityBefore)
    || !/^\d{1,14}\.\d{4}$/.test(review.unitCost) || typeof review.occurredAt !== "string" || !Number.isFinite(new Date(review.occurredAt).getTime())
    || !(review.unitPrice === null || (typeof review.unitPrice === "string" && /^\d{1,14}\.\d{4}$/.test(review.unitPrice)))
    || ![review.supplier, review.customer, review.notes, review.justification].every((value) => value === null || typeof value === "string")) throw new Error("invalid-pending-operation");
  if (intent.kind === "movement") {
    if (!uuid.test(intent.body.productId) || !types.slice(0, 4).includes(intent.body.type) || typeof intent.body.quantity !== "string" || typeof intent.body.occurredAt !== "string" || !Number.isFinite(new Date(intent.body.occurredAt).getTime())) throw new Error("invalid-pending-operation");
  } else if (!uuid.test(intent.movementId) || typeof intent.body.justification !== "string") throw new Error("invalid-pending-operation");
  return intent;
}
