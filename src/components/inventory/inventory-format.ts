import type { InventoryStatus } from "@/lib/inventory/types";
import { estimatedBalance, inverse } from "@/components/stock/stock-format";

export { decimal, date, normalizeDecimal } from "@/components/stock/stock-format";
export const inventoryLabels: Record<InventoryStatus, string> = { OPEN: "Em contagem", COMPLETED: "Concluído", CANCELED: "Cancelado" };
export function quantityDifference(counted: string, baseline: string): string { return estimatedBalance(counted, inverse(baseline)); }
