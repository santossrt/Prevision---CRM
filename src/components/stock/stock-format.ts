import type { MovementType } from "@/lib/stock/types";
export { formatCatalogDecimal as decimal, formatCatalogMoney as money, formatCatalogDate as date } from "@/components/catalog/catalog-meta";

export const movementLabels: Record<MovementType, string> = {
  ENTRY: "Entrada", EXIT: "Saída", POSITIVE_ADJUSTMENT: "Ajuste positivo",
  NEGATIVE_ADJUSTMENT: "Ajuste negativo", COMPENSATION: "Compensação"
};

export function localDateTime(value = new Date()): string {
  return new Date(value.getTime() - value.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

export function normalizeDecimal(value: string): string {
  const normalized = value.trim().replace(",", ".");
  if (!/^\d{1,14}(?:\.\d{1,4})?$/.test(normalized)) throw new Error("Informe até 14 dígitos inteiros e quatro casas decimais, sem separador de milhar.");
  const [integer, fraction = ""] = normalized.split(".");
  return `${BigInt(integer)}.${fraction.padEnd(4, "0")}`;
}

function scaled(value: string): bigint {
  const negative = value.startsWith("-");
  const [integer, fraction = ""] = (negative ? value.slice(1) : value).split(".");
  return (BigInt(integer) * 10000n + BigInt(fraction.padEnd(4, "0"))) * (negative ? -1n : 1n);
}
function unscaled(value: bigint, places: number): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(places + 1, "0");
  return `${negative ? "-" : ""}${digits.slice(0, -places)}.${digits.slice(-places)}`;
}
export function estimatedBalance(before: string, delta: string): string { return unscaled(scaled(before) + scaled(delta), 4); }
export function estimatedTotal(quantity: string, unit: string): string {
  const quantityValue = scaled(quantity);
  const product = (quantityValue < 0n ? -quantityValue : quantityValue) * scaled(unit);
  return unscaled((product + 500000n) / 1000000n, 2);
}

export function inverse(value: string): string { return value.startsWith("-") ? value.slice(1) : `-${value}`; }
