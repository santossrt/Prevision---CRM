import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const workspace = fileURLToPath(new URL("../../", import.meta.url));

describe("proteção dos comandos de migrations", () => {
  it.each([
    ["dev", "--schema", "elsewhere.prisma"],
    ["deploy", "--config", "elsewhere.ts"],
    ["status", "--url", "postgresql://other.invalid/database"]
  ])("recusa substituição de configuração em %s", (...arguments_) => {
    const result = spawnSync(process.execPath, ["scripts/database/migrate.ts", ...arguments_], {
      cwd: workspace, encoding: "utf8", timeout: 10000
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Argumentos de migration inválidos.");
  });

  it.each(["dev", "deploy", "status"])("recusa %s fora do ambiente local antes de conectar", (operation) => {
    const result = spawnSync(process.execPath, ["scripts/database/migrate.ts", operation], {
      cwd: workspace,
      encoding: "utf8",
      timeout: 10000,
      env: {
        ...process.env,
        APP_ENV: "demo",
        DATABASE_ID: "unrelated-demo-database",
        DATABASE_URL: "postgresql://app:never-log-this@127.0.0.1:54329/prevision_dev",
        DIRECT_URL: "postgresql://admin:never-log-this@127.0.0.1:54329/prevision_dev"
      }
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("A identificação inicial é permitida somente no banco local");
    expect(result.stderr).not.toContain("never-log-this");
  });
});
