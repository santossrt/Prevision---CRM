export interface AnalysisFilters {
  from: string; to: string; search: string; status: "all" | "active" | "inactive";
  thresholdA: string; thresholdB: string; horizonDays: number;
}
export interface AbcProduct {
  id: string; name: string; sku: string; unit: string; isActive: boolean; unitChanged: boolean;
  grossExitQuantity: string; reversedExitQuantity: string; netQuantity: string | null;
  grossExitCost: string; reversedExitCost: string; consumptionCost: string; clamped: boolean;
  share: string; cumulativeShare: string; classification: "A" | "B" | "C" | null;
}
export type ReplenishmentStatus = "INACTIVE" | "UNIT_CHANGED" | "INSUFFICIENT_HISTORY" | "NO_CONSUMPTION" | "MISSING_LEAD_TIME" | "REORDER" | "OK";
export interface ReplenishmentProduct {
  id: string; name: string; sku: string; unit: string; isActive: boolean;
  quantity: string; minimumStock: string; safetyStock: string; minimumGap: string;
  supplier: { id: string; name: string; isActive: boolean } | null;
  leadTimeDays: number | null; leadTimeSource: "product" | "supplier" | null;
  observedDays: number; positiveExitDays: number; netExitQuantity: string | null;
  averageDaily: string | null; daysUntilStockout: string | null;
  reorderPoint: string | null; recommendedQuantity: string | null;
  estimatedStockoutDate: string | null; estimatedReorderDate: string | null; dateLimited: boolean;
  status: ReplenishmentStatus;
}
export interface AnalysisDTO {
  generatedAt: string; asOfDate: string;
  filters: AnalysisFilters;
  criteria: { timeZone: "America/Sao_Paulo"; periodDays: number; minimumHistoryDays: 30; minimumPositiveExitDays: 2; dateLimitDays: 3650 };
  abc: { totalConsumptionCost: string; products: AbcProduct[]; classes: { classification: "A" | "B" | "C" | null; products: number; consumptionCost: string; share: string }[] };
  replenishment: { products: ReplenishmentProduct[]; reorderCount: number; insufficientCount: number };
  warnings: string[];
}
