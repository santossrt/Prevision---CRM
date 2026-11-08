import { z } from "zod";

const postgresUrl = z.string().refine((value) => {
  try {
    const parsed = new URL(value);
    return ["postgres:", "postgresql:"].includes(parsed.protocol) && Boolean(parsed.hostname) && parsed.pathname.length > 1;
  } catch {
    return false;
  }
});

const environmentSchema = z.object({
  APP_ENV: z.enum(["development", "test", "demo"]),
  DATABASE_ID: z.string().min(1).max(100),
  DATABASE_URL: postgresUrl,
  DATABASE_SSL_CA: z.string().min(1).max(32768).optional(),
  DIRECT_URL: postgresUrl.optional()
});

export type Environment = z.infer<typeof environmentSchema>;

/** Valida apenas no uso do banco; importação e build não exigem segredos. */
export function readEnvironment(source: Record<string, string | undefined> = process.env): Environment {
  const result = environmentSchema.safeParse(source);
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((issue) => String(issue.path[0])))];
    throw new Error(`Configuração de ambiente inválida: ${fields.join(", ")}. Consulte .env.example.`);
  }
  if (result.data.APP_ENV === "demo" && result.data.DATABASE_ID === "prevision-local-development") {
    throw new Error("O ambiente de demonstração exige uma identificação de banco independente.");
  }
  return result.data;
}

export function assertLocalDevelopmentDatabase(environment: Environment): void {
  const runtime = new URL(environment.DATABASE_URL);
  const administrative = new URL(environment.DIRECT_URL ?? environment.DATABASE_URL);
  const localTargets = [runtime, administrative].every((url) =>
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && url.pathname === "/prevision_dev"
  );
  if (environment.APP_ENV !== "development" || !localTargets || runtime.port !== administrative.port || environment.DATABASE_ID !== "prevision-local-development") {
    throw new Error("A identificação inicial é permitida somente no banco local prevision_dev de desenvolvimento.");
  }
}

export function assertDatabaseIdentity(environment: Pick<Environment, "APP_ENV" | "DATABASE_ID">, identity: { environment: string; databaseId: string } | null): void {
  if (!identity || identity.environment !== environment.APP_ENV || identity.databaseId !== environment.DATABASE_ID) {
    throw new Error("Identidade do banco ausente ou incompatível com o ambiente. A operação foi interrompida.");
  }
}
