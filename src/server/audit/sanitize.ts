import type { AuditSnapshotDTO, AuditValue } from "../../lib/audit/types.ts";
import { PERMISSIONS } from "../authorization/permissions.ts";

// This allowlist mirrors public domain snapshots. Unknown fields are omitted,
// including future credentials that may accidentally be persisted elsewhere.
const fields = new Set([
  "id", "name", "email", "role", "permissions", "isActive", "googleAccessAllowed", "googleLinked", "provider",
  "description", "sku", "barcode", "categoryId", "category", "defaultSupplierId", "defaultSupplier", "unitOfMeasure",
  "quantity", "minimumStock", "safetyStock", "acquisitionCost", "salePrice", "replenishmentLeadTimeDays", "taxId", "phone", "address",
  "version", "createdAt", "updatedAt", "productId", "type", "quantityDelta", "quantityBefore", "quantityAfter",
  "historicalUnitCost", "historicalTotalCost", "historicalUnitPrice", "historicalTotalPrice", "supplierId", "customerId",
  "compensatesMovementId", "justification", "occurredAt", "notes", "title", "inventoryId", "status", "scope", "items", "itemCount",
  "countedItems", "divergentItems", "changedItems", "productIds", "categoryIds", "baselineQuantity", "baselineVersion", "countedQuantity",
  "difference", "countedById", "countedAt", "movementId", "movementIds", "operationId", "openedAt", "completedAt", "canceledAt", "createdById",
  "completedById", "canceledById", "stockStatus", "previousValue", "newValue", "effectiveAt", "code",
  "fileName", "format", "rowCount", "validCount", "errorCount", "createdCount", "importId", "exportId", "reportId", "reportKind", "kind", "filters",
  "expiresAt", "search", "stock", "from", "to", "actorId", "module", "action", "entityType", "entityId"
]);
const booleanFlags = new Set(["passwordResetRequested", "administrativeReset", "passwordResetDeliveryFailed", "activationEmailRequested"]);
const permissions = new Set<string>(PERMISSIONS);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const forbidden = /password|token|secret|credential|authorization|cookie|session|__proto__|constructor|prototype/iu;

/** Never returns credential fields or serializes arbitrary error/model objects. */
export function sanitizeAuditSnapshot(input: unknown): AuditSnapshotDTO | null {
  if (input === null || input === undefined) return null;
  const result: AuditSnapshotDTO = { values: null, omitted: false, truncated: false };
  let remaining = 400;
  const seen = new WeakSet<object>();

  function visit(value: unknown, depth: number, key?: string): AuditValue | undefined {
    if (--remaining < 0 || depth > 6) { result.truncated = true; return undefined; }
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string") {
      if (value.length > 1000) result.truncated = true;
      return value.slice(0, 1000);
    }
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "object" || !value) { result.omitted = true; return undefined; }
    if (seen.has(value)) { result.omitted = true; return undefined; }
    seen.add(value);
    if (Array.isArray(value)) {
      if (value.length > 50) result.truncated = true;
      const values: AuditValue[] = [];
      for (let index = 0; index < Math.min(value.length, 50); index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor)) { result.omitted = true; continue; }
        const item: unknown = descriptor.value;
        if (key === "permissions" || key === "productIds" || key === "categoryIds" || key === "movementIds") {
          if (typeof item === "string" && (key === "permissions" ? permissions.has(item) : uuid.test(item))) values.push(item);
          else result.omitted = true;
          continue;
        }
        if (key === "items" && (typeof item !== "object" || !item || Array.isArray(item))) { result.omitted = true; continue; }
        const safe = visit(item, depth + 1, key);
        if (safe !== undefined) values.push(safe);
      }
      return values;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) { result.omitted = true; return undefined; }
    const entries = Object.entries(Object.getOwnPropertyDescriptors(value));
    if (entries.length > 80) result.truncated = true;
    const safe: Record<string, AuditValue> = Object.create(null);
    for (const [field, descriptor] of entries.slice(0, 80)) {
      if (!("value" in descriptor)) { result.omitted = true; continue; }
      if (booleanFlags.has(field)) {
        if (typeof descriptor.value === "boolean") safe[field] = descriptor.value;
        else result.omitted = true;
        continue;
      }
      if (forbidden.test(field) || !fields.has(field)) { result.omitted = true; continue; }
      const child = visit(descriptor.value, depth + 1, field);
      if (child !== undefined) safe[field] = child;
    }
    return safe;
  }

  // All current snapshots are objects; top-level primitives/arrays have no
  // field context that could establish they contain public domain values.
  if (typeof input !== "object" || Array.isArray(input)) { result.omitted = true; return result; }
  try { result.values = visit(input, 0) ?? null; }
  catch { result.values = null; result.omitted = true; }
  return result;
}

/** Origins currently written by the application or trusted platform IPs. */
export function sanitizeAuditOrigin(value: string | null): string | null {
  if (!value) return null;
  if (/^(?:local-development|catalog|stock|inventory(?:\.[a-z_]+)?|transfers(?:\.[a-z_]+)*|notifications\.notice\.create|users(?:\.[a-z_]+)+)$/u.test(value)) return value;
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/u.test(value) || /^[0-9a-f:]{2,45}$/iu.test(value)) return value;
  return null;
}
