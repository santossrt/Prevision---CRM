import type { ReplenishmentStatus } from "./types.ts";
export const replenishmentStatusLabels: Record<ReplenishmentStatus, string> = {
  INACTIVE: "Produto inativo", UNIT_CHANGED: "Unidade alterada", INSUFFICIENT_HISTORY: "Histórico insuficiente",
  NO_CONSUMPTION: "Sem consumo líquido", MISSING_LEAD_TIME: "Prazo de entrega não informado",
  REORDER: "Reposição exige atenção", OK: "Cobertura disponível"
};
