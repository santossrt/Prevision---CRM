import { config } from "dotenv";

config({ path: ".env", quiet: true });

/** Não propaga mensagens de drivers: elas podem conter dados de conexão. */
export function reportDatabaseFailure(context: string, error: unknown) {
  const knownPrefix = ["Configuração de ambiente inválida:", "O ambiente de demonstração", "A identificação inicial", "Identidade do banco", "Configure DIRECT_URL", "Argumentos de migration inválidos."];
  const message = error instanceof Error && knownPrefix.some((prefix) => error.message.startsWith(prefix))
    ? error.message
    : "Verifique a configuração, a disponibilidade do PostgreSQL e as migrations. Detalhes de conexão foram omitidos.";
  const sqlState = typeof error === "object" && error !== null && "code" in error && /^[0-9A-Z]{5}$/.test(String(error.code))
    ? ` (SQLSTATE ${String(error.code)})`
    : "";
  console.error(`${context}: ${message}${sqlState}`);
  process.exitCode = 1;
}
