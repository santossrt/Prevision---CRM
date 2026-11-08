import type { PoolConfig } from "pg";
import type { Environment } from "../config/environment.ts";

/** O ambiente publicado sempre verifica o certificado e o hostname do banco. */
export function databaseConnectionOptions(environment: Pick<Environment, "APP_ENV" | "DATABASE_URL" | "DATABASE_SSL_CA">): PoolConfig {
  if (environment.APP_ENV !== "demo") return { connectionString: environment.DATABASE_URL };

  const url = new URL(environment.DATABASE_URL);
  // pg aplica parametros da URL depois do objeto ssl. Remova os que poderiam
  // desabilitar a verificacao ou substituir a CA por um arquivo do servidor.
  for (const key of ["ssl", "sslmode", "sslcert", "sslkey", "sslrootcert", "sslnegotiation", "uselibpqcompat"]) {
    url.searchParams.delete(key);
  }
  return {
    connectionString: url.toString(),
    ssl: {
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
      ...(environment.DATABASE_SSL_CA ? { ca: environment.DATABASE_SSL_CA } : {})
    }
  };
}
