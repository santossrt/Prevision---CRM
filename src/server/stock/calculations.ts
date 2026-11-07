import { ApplicationError } from "../errors/application-error.ts";

const maximumScaled = 999999999999999999n;
export function scaled4(value: string): bigint {
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [integer, fraction = ""] = unsigned.split(".");
  return BigInt(integer + fraction.padEnd(4, "0")) * (negative ? -1n : 1n);
}
export function fixed(value: bigint, places: number): string {
  const sign = value < 0n ? "-" : "";
  const digits = (value < 0n ? -value : value).toString().padStart(places + 1, "0");
  return `${sign}${digits.slice(0, -places)}.${digits.slice(-places)}`;
}
/** Exact integer arithmetic; positive money rounds half up to two decimals. */
export function totalCents(quantity: string, unitValue: string): bigint {
  const product = scaled4(quantity) * scaled4(unitValue);
  return ((product < 0n ? -product : product) + 500000n) / 1000000n;
}
export function movementTotal(quantity: string, unitValue: string): string {
  const cents = totalCents(quantity, unitValue);
  if (cents > maximumScaled) throw new ApplicationError("VALIDATION", "O valor total da movimentação ultrapassa o limite permitido.");
  return fixed(cents, 2);
}
export function resultingQuantity(before: string, delta: string): string {
  const after = scaled4(before) + scaled4(delta);
  if (after < 0n) throw new ApplicationError("CONFLICT", "Saldo insuficiente para esta movimentação. Atualize o estoque e confira a quantidade.");
  if (after > maximumScaled) throw new ApplicationError("VALIDATION", "O saldo resultante ultrapassa o limite permitido.");
  return fixed(after, 4);
}
