import "server-only";
import { z } from "zod";
import { themeModes } from "../../lib/preferences/types.ts";
import { ApplicationError } from "../errors/application-error.ts";

const updateSchema = z.object({
  theme: z.enum(themeModes),
  expectedVersion: z.number().int().min(0).max(2147483646)
}).strict();

export function parsePreferenceUpdate(value: unknown) {
  const result = updateSchema.safeParse(value);
  if (!result.success) throw new ApplicationError("VALIDATION", "Escolha um tema válido e recarregue suas preferências antes de salvar.");
  return result.data;
}

export function validTheme(value: unknown) {
  return typeof value === "string" && (themeModes as readonly string[]).includes(value);
}
