import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "pg";
import { config } from "dotenv";
import type { AuditEventDTO, AuditList, AuditOptions } from "../../src/lib/audit/types.ts";
import { assertDatabaseIdentity, assertLocalDevelopmentDatabase, readEnvironment } from "../../src/server/config/environment.ts";
import { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS } from "../../src/server/authorization/permissions.ts";
import { hashPassword } from "../../src/server/security/password.ts";

config({ path: ".env", quiet: true });
const port = 3015;
const base = `http://127.0.0.1:${port}`;
class Browser {
  cookies = new Map<string, string>();
  async request(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    if (this.cookies.size) headers.set("cookie", [...this.cookies].map(([key, value]) => `${key}=${value}`).join("; "));
    const response = await fetch(new URL(path, base), { ...init, headers, redirect: "manual", signal: AbortSignal.timeout(20000) });
    for (const entry of response.headers.getSetCookie()) {
      const [pair, ...attributes] = entry.split(";");
      const separator = pair.indexOf("="); const name = pair.slice(0, separator); const value = pair.slice(separator + 1);
      if (!value || attributes.some((part) => /^\s*max-age=0$/iu.test(part))) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return response;
  }
  async login(email: string, password: string) {
    const challenge = await this.request("/api/auth/csrf");
    assert.equal(challenge.status, 200);
    const { csrfToken } = await challenge.json() as { csrfToken: string };
    const response = await this.request("/api/auth/callback/credentials", {
      method: "POST", headers: { Origin: base, "Content-Type": "application/x-www-form-urlencoded", "X-Auth-Return-Redirect": "1" },
      body: new URLSearchParams({ csrfToken, email, password, callbackUrl: base + "/" })
    });
    const result = await response.json() as { url?: string };
    return Boolean(result.url && !new URL(result.url, base).searchParams.has("error") && [...this.cookies.keys()].some((name) => name.startsWith("prevision.session-token")));
  }
}
async function get<T>(browser: Browser, path: string): Promise<T> {
  const response = await browser.request(path);
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  return response.json() as Promise<T>;
}
async function assertFreePort() {
  const server = createServer();
  await new Promise<void>((accept, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", accept); });
  await new Promise<void>((accept, reject) => server.close((error) => error ? reject(error) : accept()));
}
async function stopServer(server: ChildProcess | undefined) {
  if (!server || server.exitCode !== null) return;
  server.kill();
  await Promise.race([new Promise<void>((accept) => server.once("exit", () => accept())), delay(5000)]);
  if (server.exitCode === null) { server.kill("SIGKILL"); await delay(500); }
}

async function integration() {
  const source = readEnvironment();
  assertLocalDevelopmentDatabase(source); assert.ok(source.DIRECT_URL);
  assert.equal(new URL(source.DIRECT_URL).host, new URL(source.DATABASE_URL).host);
  await assertFreePort();
  const suffix = randomBytes(6).toString("hex");
  const databaseName = `prevision_audit_test_${suffix}`;
  assert.match(databaseName, /^prevision_audit_test_[0-9a-f]{12}$/u);
  const marker = `prevision-audit-integration-${randomUUID()}`;
  const adminUrl = new URL(source.DIRECT_URL); const runtimeUrl = new URL(source.DATABASE_URL);
  adminUrl.pathname = runtimeUrl.pathname = `/${databaseName}`;
  const admin = new Client({ connectionString: source.DIRECT_URL, connectionTimeoutMillis: 5000 });
  const fixture = new Client({ connectionString: adminUrl.href, connectionTimeoutMillis: 5000 });
  const runtime = new Client({ connectionString: runtimeUrl.href, connectionTimeoutMillis: 5000 });
  const password = `Audit-integration-${randomBytes(20).toString("hex")}`;
  const actors = {
    ADMINISTRATOR: { id: randomUUID(), email: `audit.admin.${suffix}@example.invalid`, browser: new Browser() },
    MANAGER: { id: randomUUID(), email: `audit.manager.${suffix}@example.invalid`, browser: new Browser() },
    OPERATOR: { id: randomUUID(), email: `audit.operator.${suffix}@example.invalid`, browser: new Browser() }
  };
  const roles = new Map<string, string>();
  const administrator = actors.ADMINISTRATOR.browser; const manager = actors.MANAGER.browser; const operator = actors.OPERATOR.browser; const anonymous = new Browser();
  const publicId = randomUUID(); const stockId = randomUUID(); const nullActorId = randomUUID(); const inventoryId = randomUUID(); const escapedId = randomUUID();
  const operationId = randomUUID(); const entityId = randomUUID(); const stockEntityId = randomUUID();
  const secrets = ["audit-private-password-hash", "audit-private-token", "audit-private-secret", "audit-private-authorization", "audit-private-cookie"];
  let created = false; let connectedFixture = false; let connectedRuntime = false; let server: ChildProcess | undefined; let checked = 0; let currentCheck = "preparo do banco descartável";
  const check = async (name: string, work: () => unknown | Promise<unknown>) => { currentCheck = name; await work(); checked++; };
  try {
    await admin.connect();
    const identity = await admin.query('SELECT environment,database_id AS "databaseId" FROM environment_sentinel WHERE id=$1', ["primary"]);
    assertDatabaseIdentity(source, identity.rows[0] ?? null);
    await admin.query(`CREATE DATABASE "${databaseName}"`); created = true;
    await admin.query(`COMMENT ON DATABASE "${databaseName}" IS '${marker}'`);
    await fixture.connect(); connectedFixture = true;
    for (const name of (await readdir(resolve("prisma", "migrations"))).filter((name) => /^\d+_/u.test(name)).sort()) {
      await fixture.query(await readFile(resolve("prisma", "migrations", name, "migration.sql"), "utf8"));
    }
    await fixture.query('INSERT INTO environment_sentinel(id,environment,database_id) VALUES($1,$2,$3)', ["primary", "test", marker]);
    for (const code of Object.keys(actors)) {
      const roleId = randomUUID(); roles.set(code, roleId);
      await fixture.query('INSERT INTO roles(id,code,name,updated_at) VALUES($1,$2,$3,now())', [roleId, code, code]);
    }
    for (const code of PERMISSIONS) {
      const permissionId = randomUUID();
      await fixture.query('INSERT INTO permissions(id,code) VALUES($1,$2)', [permissionId, code]);
      for (const [role, defaults] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
        // The manager intentionally has audit.read only to prove independence
        // from catalog, users and stock privileges in the audit reader.
        const permissions = role === "MANAGER" ? ["audit.read"] : defaults;
        if ((permissions as readonly string[]).includes(code)) await fixture.query('INSERT INTO role_permissions(role_id,permission_id) VALUES($1,$2)', [roles.get(role), permissionId]);
      }
    }
    const hash = await hashPassword(password);
    for (const [code, actor] of Object.entries(actors)) await fixture.query('INSERT INTO users(id,name,email,password_hash,role_id,updated_at) VALUES($1,$2,$3,$4,$5,now())', [actor.id, `Auditoria ${code}`, actor.email, hash, roles.get(code)]);
    const insert = async (id: string, actorId: string | null, action: string, module: string, type: string, target: string | null, operation: string, origin: string | null, before: unknown, after: unknown, time: string) => fixture.query(
      'INSERT INTO audit_events(id,actor_id,action,module,entity_type,entity_id,operation_id,origin,previous_values,new_values,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [id, actorId, action, module, type, target, operation, origin, before, after, time]
    );
    await insert(publicId, actors.ADMINISTRATOR.id, "UPDATE", "PRODUCTS", "Product", entityId, operationId, "catalog",
      { name: "Produto anterior", passwordHash: secrets[0] },
      { name: "Produto atualizado", sku: `AUDIT-${suffix}`, token: secrets[1], category: { name: "Categoria", clientSecret: secrets[2] }, items: [{ productId: entityId, countedQuantity: "2.5000", authorization: secrets[3] }], cookie: secrets[4] }, "2026-10-31T12:00:00Z");
    await insert(stockId, actors.OPERATOR.id, "STOCK_ENTRY", "STOCK", "StockMovement", stockEntityId, operationId, "stock", { quantity: "0.0000" }, { quantity: "2.5000", historicalUnitCost: "3.3350", historicalTotalCost: "8.34" }, "2026-10-31T12:01:00Z");
    await insert(nullActorId, null, "LOGIN_FAILURE", "AUTH", "User", null, randomUUID(), `https://example.invalid/callback?token=${secrets[1]}`, null, null, "2026-10-31T12:02:00Z");
    await insert(inventoryId, actors.ADMINISTRATOR.id, "UPDATE", "INVENTORY", "Inventory", randomUUID(), randomUUID(), "inventory.complete", { status: "OPEN" }, { status: "COMPLETED", itemCount: 1, movementIds: [stockEntityId] }, "2026-10-31T12:03:00Z");
    await insert(escapedId, actors.ADMINISTRATOR.id, "UPDATE", "SYSTEM", "Audit%Item_", `literal_%_${suffix}`, randomUUID(), null, null, { name: "Consulta literal" }, "2026-10-31T12:04:00Z");
    await runtime.connect(); connectedRuntime = true;
    server = spawn(process.execPath, [resolve("node_modules", "next", "dist", "bin", "next"), "start", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: process.cwd(), windowsHide: true, stdio: ["ignore", "ignore", "pipe"], env: {
        ...process.env, NODE_ENV: "production", APP_ENV: "test", DATABASE_ID: marker,
        DATABASE_URL: runtimeUrl.href, DIRECT_URL: adminUrl.href, AUTH_SECRET: randomBytes(48).toString("hex"), AUTH_URL: base,
        MAIL_TRANSPORT: "local", GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "", VERCEL: "", REQUEST_IP_HEADER: "", NEXT_TELEMETRY_DISABLED: "1"
      }
    });
    // stderr is deliberately not printed: driver/auth errors may carry data.
    server.stderr?.on("data", () => undefined);
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      if (server.exitCode !== null) break;
      try { ready = (await fetch(base + "/api/health", { signal: AbortSignal.timeout(1000) })).ok; } catch { /* wait for our child only */ }
      if (ready) break; await delay(250);
    }
    assert.ok(ready, "Execute o build atualizado antes da integração de auditoria.");

    await check("consultas exigem autenticação", async () => {
      for (const path of ["/api/audit", "/api/audit/options", `/api/audit/${publicId}`]) assert.equal((await anonymous.request(path)).status, 401);
    });
    await check("login das três contas efêmeras", async () => {
      for (const actor of Object.values(actors)) assert.equal(await actor.browser.login(actor.email, password), true);
    });
    await check("operador não consulta auditoria mesmo com acesso a estoque", async () => {
      for (const path of ["/api/audit", "/api/audit/options", `/api/audit/${publicId}`]) assert.equal((await operator.request(path)).status, 403);
    });
    await check("leitor com audit.read não precisa de permissões de catálogo ou estoque", async () => {
      assert.ok((await get<AuditList>(manager, "/api/audit")).total >= 5);
      assert.equal((await manager.request("/api/stock/balances")).status, 403);
      assert.equal((await manager.request("/api/catalog/products")).status, 403);
    });
    await check("lista pagina e não expõe snapshots ou credenciais", async () => {
      const result = await get<AuditList>(administrator, "/api/audit?pageSize=2");
      assert.equal(result.items.length, 2); assert.equal(result.pageSize, 2); assert.ok(result.totalPages >= 3);
      for (const event of result.items) { assert.equal("previousValues" in event, false); assert.equal("newValues" in event, false); assert.equal(event.actor ? "email" in event.actor : false, false); }
      for (const secret of secrets) assert.equal(JSON.stringify(result).includes(secret), false);
    });
    await check("detalhes exibem campos públicos e removem credenciais aninhadas", async () => {
      const event = await get<AuditEventDTO>(manager, `/api/audit/${publicId}`);
      assert.equal(event.actor?.id, actors.ADMINISTRATOR.id); assert.equal(event.origin, "catalog");
      assert.deepEqual(event.previousValues?.values, { name: "Produto anterior" }); assert.equal(event.previousValues?.omitted, true);
      assert.equal(event.newValues?.omitted, true);
      for (const secret of secrets) assert.equal(JSON.stringify(event).includes(secret), false);
    });
    await check("evento sem responsável preserva ausência e omite origem privada", async () => {
      const event = await get<AuditEventDTO>(administrator, `/api/audit/${nullActorId}`);
      assert.equal(event.actor, null); assert.equal(event.origin, null); assert.equal(event.newValues, null);
    });
    await check("novo módulo de inventário e vínculos múltiplos são consultáveis", async () => {
      const events = await get<AuditList>(manager, "/api/audit?module=INVENTORY");
      assert.equal(events.total, 1); assert.equal(events.items[0].id, inventoryId);
      const event = await get<AuditEventDTO>(manager, `/api/audit/${inventoryId}`);
      assert.equal(event.origin, "inventory.complete"); assert.deepEqual((event.newValues?.values as { movementIds: string[] }).movementIds, [stockEntityId]);
    });
    await check("identificação da operação reúne eventos de módulos diferentes", async () => {
      const result = await get<AuditList>(manager, `/api/audit?operationId=${operationId}`);
      assert.equal(result.total, 2); assert.deepEqual(new Set(result.items.map((event) => event.id)), new Set([publicId, stockId]));
    });
    await check("filtros por ator módulo ação e entidade respeitam combinação", async () => {
      const query = new URLSearchParams({ actorId: actors.ADMINISTRATOR.id, module: "PRODUCTS", action: "UPDATE", entityType: "Product", entityId });
      const result = await get<AuditList>(manager, `/api/audit?${query}`);
      assert.equal(result.total, 1); assert.equal(result.items[0].id, publicId);
    });
    await check("período com fuso horário utiliza limites inclusivos", async () => {
      const query = new URLSearchParams({ from: "2026-10-31T09:00:00-03:00", to: "2026-10-31T09:01:00-03:00", operationId });
      assert.equal((await get<AuditList>(manager, `/api/audit?${query}`)).total, 2);
    });
    await check("pesquisa trata percentuais e underscores como literais", async () => {
      const result = await get<AuditList>(manager, `/api/audit?${new URLSearchParams({ search: "%Item_" })}`);
      assert.equal(result.total, 1); assert.equal(result.items[0].id, escapedId);
      assert.equal((await get<AuditList>(manager, `/api/audit?${new URLSearchParams({ search: "' OR 1=1 --" })}`)).total, 0);
    });
    await check("pesquisa não infere campos privados ou origens omitidas pela contagem", async () => {
      for (const secret of secrets) assert.equal((await get<AuditList>(manager, `/api/audit?${new URLSearchParams({ search: secret })}`)).total, 0);
    });
    await check("filtros inválidos repetidos e período invertido são recusados", async () => {
      for (const query of ["page=&page=2", "search=&search=", "page=0", "pageSize=101", "module=UNKNOWN", "action=UNKNOWN", "actorId=x", "operationId=x", "extra=valor", "from=2026-10-31", "from=2026-11-01T00:00:00Z&to=2026-10-31T00:00:00Z"]) {
        assert.equal((await manager.request(`/api/audit?${query}`)).status, 400);
      }
    });
    await check("detalhe distingue identificador inválido e evento inexistente", async () => {
      assert.equal((await manager.request("/api/audit/not-id")).status, 400); assert.equal((await manager.request(`/api/audit/${randomUUID()}`)).status, 404);
    });
    await check("opções retornam apenas IDs nomes e enums declarados", async () => {
      const options = await get<AuditOptions>(manager, "/api/audit/options");
      assert.ok(options.modules.some((module) => module.value === "INVENTORY")); assert.ok(options.actions.some((action) => action.value === "STOCK_ENTRY")); assert.ok(options.entityTypes.includes("Product"));
      for (const actor of options.actors) assert.deepEqual(Object.keys(actor).sort(), ["id", "name"]);
    });
    await check("APIs não aceitam criação edição ou exclusão de auditoria", async () => {
      for (const method of ["POST", "PATCH", "DELETE"]) assert.equal((await administrator.request(`/api/audit/${publicId}`, { method })).status, 405);
      assert.equal((await administrator.request("/api/audit", { method: "POST" })).status, 405);
    });
    await check("PostgreSQL nega alteração de auditoria ao runtime", async () => {
      const grants = await runtime.query("SELECT has_table_privilege(current_user,'public.audit_events','UPDATE,DELETE,TRUNCATE') AS change_history");
      assert.equal(grants.rows[0].change_history, false);
      for (const sql of ['UPDATE audit_events SET origin=$1 WHERE id=$2', 'DELETE FROM audit_events WHERE origin=$1 AND id=$2']) {
        let code: unknown;
        try { await runtime.query(sql, ["alterado", publicId]); } catch (error) { code = (error as { code?: string }).code; }
        assert.equal(code, "42501");
      }
      assert.equal((await get<AuditEventDTO>(manager, `/api/audit/${publicId}`)).origin, "catalog");
    });
    await check("página autorizada abre e operador recebe explicação de restrição", async () => {
      const allowed = await manager.request("/auditoria"); assert.equal(allowed.status, 200); assert.ok((await allowed.text()).includes("Histórico de atividades"));
      const denied = await operator.request("/auditoria"); assert.equal(denied.status, 200); assert.ok((await denied.text()).includes("Esta área exige permissão de auditoria"));
    });
    await check("revogar audit.read é aplicado sem depender do cookie antigo", async () => {
      await fixture.query('DELETE FROM role_permissions WHERE role_id=$1', [roles.get("MANAGER")]);
      assert.equal((await manager.request("/api/audit")).status, 403); assert.equal((await manager.request(`/api/audit/${publicId}`)).status, 403);
    });
    await check("sessão revogada não lê opções ou histórico", async () => {
      await fixture.query('UPDATE login_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [actors.ADMINISTRATOR.id]);
      assert.equal((await administrator.request("/api/audit/options")).status, 401); assert.equal((await administrator.request("/api/audit")).status, 401);
    });
    console.info(`${checked} verificações de auditoria aprovadas em banco e servidor descartáveis: leitura restrita, filtros, snapshots seguros, operações, privilégios e revogação.`);
  } catch (error) {
    console.error(`Integração de auditoria interrompida em: ${currentCheck}. Dados sensíveis foram omitidos.`);
    if (error instanceof assert.AssertionError && ["number", "boolean"].includes(typeof error.actual) && ["number", "boolean"].includes(typeof error.expected)) console.error(`Resultado recebido: ${String(error.actual)}; esperado: ${String(error.expected)}.`);
    process.exitCode = 1;
  } finally {
    await stopServer(server);
    if (connectedRuntime) await runtime.end().catch(() => {});
    if (connectedFixture) await fixture.end().catch(() => {});
    if (created) {
      const result = await admin.query("SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=$1", [databaseName]).catch(() => null);
      if (result?.rows[0]?.marker === marker && /^prevision_audit_test_[0-9a-f]{12}$/u.test(databaseName)) {
        await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`).catch(() => { console.error("Não foi possível remover o banco descartável desta execução."); process.exitCode = 1; });
      } else { console.error("Marcador divergente; limpeza do banco descartável interrompida."); process.exitCode = 1; }
    }
    await admin.end().catch(() => {});
  }
}
integration().catch(() => { console.error("Não foi possível preparar a integração de auditoria. Confira banco local, porta 3015 e build; detalhes privados omitidos."); process.exitCode = 1; });
