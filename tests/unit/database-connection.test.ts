import type { ConnectionOptions } from "node:tls";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { databaseConnectionOptions } from "../../src/server/database/connection-options";

function driverSsl(url: string, ca?: string) {
  const client = new Client(databaseConnectionOptions({ APP_ENV: "demo", DATABASE_URL: url, DATABASE_SSL_CA: ca }));
  return (client as unknown as { connectionParameters: { ssl: ConnectionOptions } }).connectionParameters.ssl;
}

describe("TLS do PostgreSQL publicado", () => {
  it.each(["ssl=0", "sslmode=disable", "sslmode=no-verify", "sslmode=require&uselibpqcompat=true", "sslmode=verify-ca&sslrootcert=/unavailable/ca.crt"])(
    "mantem verificacao de certificado e hostname no pg com %s",
    (query) => {
      const ssl = driverSsl(`postgresql://app:only-a-test@db.example.test/postgres?${query}`, "test-ca");
      expect(ssl).toMatchObject({ rejectUnauthorized: true, ca: "test-ca", minVersion: "TLSv1.2" });
      expect(ssl.checkServerIdentity).toBeUndefined();
    }
  );

  it("usa as autoridades do sistema quando nenhuma CA especifica foi configurada", () => {
    const ssl = driverSsl("postgresql://app:only-a-test@db.example.test/postgres");
    expect(ssl.rejectUnauthorized).toBe(true);
    expect(ssl.ca).toBeUndefined();
  });

  it("preserva parametros que nao sao de TLS", () => {
    const options = databaseConnectionOptions({ APP_ENV: "demo", DATABASE_URL: "postgresql://app:only-a-test@db.example.test/postgres?application_name=prevision&sslmode=disable" });
    const url = new URL(options.connectionString!);
    expect(url.searchParams.get("application_name")).toBe("prevision");
    expect(url.searchParams.has("sslmode")).toBe(false);
  });

  it.each(["development", "test"] as const)("preserva a conexao local de %s", (APP_ENV) => {
    const DATABASE_URL = "postgresql://app:only-a-test@127.0.0.1/prevision_dev?schema=public";
    expect(databaseConnectionOptions({ APP_ENV, DATABASE_URL })).toEqual({ connectionString: DATABASE_URL });
  });
});
