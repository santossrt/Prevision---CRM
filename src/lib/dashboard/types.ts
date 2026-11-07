export interface DashboardPeriod { from: string; to: string; granularity: "day" | "month"; timeZone: "America/Sao_Paulo" }
export interface DashboardProduct {
  id: string; name: string; sku: string; unit: string; isActive: boolean;
  quantity: string; estimatedCost: string; potentialSale: string;
}
export interface DashboardMovedProduct {
  id: string; name: string; sku: string; movements: number; entries: number; exits: number; exitCost: string;
}
export interface DashboardSeriesPoint {
  from: string; to: string;
  entries: number; exits: number; entriesCost: string; exitsCost: string; exitsSale: string;
  adjustments: number; compensations: number; estimatedStockCost: string;
}
export interface DashboardDTO {
  generatedAt: string;
  period: DashboardPeriod;
  current: { products: number; activeProducts: number; inactiveProducts: number; lowStock: number; emptyStock: number; estimatedCost: string; potentialSale: string; estimatedMargin: string };
  movements: { entries: number; exits: number; adjustments: number; compensations: number; entriesCost: string; exitsCost: string; exitsSale: string };
  units: { unit: string; entryQuantity: string; exitQuantity: string; adjustmentDelta: string; compensationDelta: string }[];
  series: DashboardSeriesPoint[];
  mostMoved: DashboardMovedProduct[];
  highestValue: DashboardProduct[];
  categories: { id: string; name: string; products: number; estimatedCost: string }[];
  warnings: string[];
}
