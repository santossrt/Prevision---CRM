import "server-only";
import { ApplicationError } from "../errors/application-error.ts";

const resources = globalThis as unknown as { previsionTransferResources?: { active: number } };

/** Ephemeral CPU/memory protection only; no business or authorization state. */
export async function withTransferResource<T>(work: () => Promise<T>): Promise<T> {
  const state = resources.previsionTransferResources ??= { active: 0 };
  if (state.active >= 2) throw new ApplicationError("UNAVAILABLE", "Há arquivos sendo processados neste momento. Aguarde e tente novamente.");
  state.active++;
  try { return await work(); }
  finally { state.active--; }
}
