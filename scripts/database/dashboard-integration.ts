import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "pg";
import { config } from "dotenv";
import type { DashboardDTO } from "../../src/lib/dashboard/types.ts";
import { assertDatabaseIdentity, assertLocalDevelopmentDatabase, readEnvironment } from "../../src/server/config/environment.ts";
import { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS } from "../../src/server/authorization/permissions.ts";
import { hashPassword } from "../../src/server/security/password.ts";
import { movementTotal } from "../../src/server/stock/calculations.ts";

config({ path: ".env", quiet: true });
const port = 3019; const base = `http://127.0.0.1:${port}`;
class Browser {
  cookies = new Map<string, string>();
  async request(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    if (this.cookies.size) headers.set("cookie", [...this.cookies].map(([key, value]) => `${key}=${value}`).join("; "));
    const response = await fetch(new URL(path, base), { ...init, headers, redirect: "manual", signal: AbortSignal.timeout(30000) });
    for (const entry of response.headers.getSetCookie()) {
      const [pair, ...attributes] = entry.split(";"); const separator = pair.indexOf("="); const name = pair.slice(0, separator); const value = pair.slice(separator + 1);
      if (!value || attributes.some((part) => /^\s*max-age=0$/iu.test(part))) this.cookies.delete(name); else this.cookies.set(name, value);
    }
    return response;
  }
  async login(email: string, password: string) {
    const challenge = await this.request("/api/auth/csrf"); assert.equal(challenge.status, 200);
    const { csrfToken } = await challenge.json() as { csrfToken: string };
    const response = await this.request("/api/auth/callback/credentials", { method: "POST", headers: { Origin: base, "Content-Type": "application/x-www-form-urlencoded", "X-Auth-Return-Redirect": "1" }, body: new URLSearchParams({ csrfToken, email, password, callbackUrl: base + "/" }) });
    const result = await response.json() as { url?: string };
    return Boolean(result.url && !new URL(result.url, base).searchParams.has("error") && [...this.cookies.keys()].some((name) => name.startsWith("prevision.session-token")));
  }
}
async function freePort() {
  const probe = createServer(); await new Promise<void>((accept, reject) => { probe.once("error", reject); probe.listen(port, "127.0.0.1", accept); });
  await new Promise<void>((accept, reject) => probe.close((error) => error ? reject(error) : accept()));
}
async function stopServer(server: ChildProcess | undefined) {
  if (!server || server.exitCode !== null) return;
  server.kill(); await Promise.race([new Promise<void>((accept) => server.once("exit", () => accept())), delay(5000)]);
  if (server.exitCode === null) { server.kill("SIGKILL"); await delay(500); }
}
async function response<T>(value: Response, status = 200): Promise<T> {
  assert.equal(value.status, status); assert.equal(value.headers.get("cache-control"), "no-store"); return value.json() as Promise<T>;
}
async function integration() {
  const source = readEnvironment(); assertLocalDevelopmentDatabase(source); assert.ok(source.DIRECT_URL);
  assert.equal(new URL(source.DATABASE_URL).host, new URL(source.DIRECT_URL).host); await freePort();
  const suffix = randomBytes(6).toString("hex"); const databaseName = `prevision_dashboard_test_${suffix}`;
  assert.match(databaseName, /^prevision_dashboard_test_[0-9a-f]{12}$/u); const marker = `prevision-dashboard-integration-${randomUUID()}`;
  const adminUrl = new URL(source.DIRECT_URL); const runtimeUrl = new URL(source.DATABASE_URL); adminUrl.pathname = runtimeUrl.pathname = `/${databaseName}`;
  const admin = new Client({ connectionString: source.DIRECT_URL, connectionTimeoutMillis: 5000 });
  const fixture = new Client({ connectionString: adminUrl.href, connectionTimeoutMillis: 5000 });
  const password = `Dashboard-${randomBytes(20).toString("hex")}`;
  const actors = Object.fromEntries(["ADMINISTRATOR", "MANAGER", "OPERATOR"].map((role) => [role, { id: randomUUID(), email: `dashboard.${role.toLowerCase()}.${suffix}@example.invalid`, browser: new Browser() }]));
  const administrator = actors.ADMINISTRATOR.browser; const operator = actors.OPERATOR.browser; const anonymous = new Browser();
  const roles = new Map<string, string>(); const products = { a: randomUUID(), b: randomUUID(), c: randomUUID(), d: randomUUID() };
  const categories = [randomUUID(), randomUUID(), randomUUID()];
  let created = false; let connected = false; let server: ChildProcess | undefined; let checked = 0; let currentCheck = "preparo do banco descartável";
  const check = async (name: string, work: () => unknown | Promise<unknown>) => { currentCheck = name; await work(); checked++; };
  const dashboard = (query = "from=2026-10-01&to=2026-10-05", browser = administrator) => browser.request(`/api/dashboard${query ? `?${query}` : ""}`).then((value) => response<DashboardDTO>(value));
  const makeProduct = async (id: string, sku: string, categoryId: string, unit: string, cost: string, price: string, active = true, minimum = "0.0000") => {
    await fixture.query('INSERT INTO products(id,sku,name,category_id,unit_of_measure,acquisition_cost,sale_price,is_active,minimum_stock,created_at,updated_at) VALUES($1,$2,$2,$3,$4,$5,$6,$7,$8,$9,$9)', [id, sku, categoryId, unit, cost, price, active, minimum, "2026-09-30T13:00:00Z"]);
    await fixture.query('INSERT INTO stock_balances(product_id,quantity,updated_at) VALUES($1,0,now())', [id]);
    for (const [type, value] of [["ACQUISITION_COST", cost], ["SALE_PRICE", price]]) await fixture.query('INSERT INTO product_value_history(id,product_id,type,new_value,changed_by_id,operation_id,effective_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$7)', [randomUUID(), id, type, value, actors.ADMINISTRATOR.id, randomUUID(), "2026-09-30T13:00:00Z"]);
  };
  const movement = async (productId: string, type: string, delta: string, before: string, after: string, occurredAt: string, registeredAt: string, cost: string, price: string | null = null, compensatesId: string | null = null) => {
    const id = randomUUID(); const absolute = delta.replace(/^-/, "");
    await fixture.query(`INSERT INTO stock_movements(id,product_id,type,quantity_delta,quantity_before,quantity_after,historical_unit_cost,historical_total_cost,historical_unit_price,historical_total_price,performed_by_id,occurred_at,created_at,operation_id,idempotency_key,justification,compensates_movement_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`, [id, productId, type, delta, before, after, cost, movementTotal(absolute, cost), price, price === null ? null : movementTotal(absolute, price), actors.ADMINISTRATOR.id, occurredAt, registeredAt, randomUUID(), `dashboard-fixture:${id}`, ["ENTRY", "EXIT"].includes(type) ? null : "Conferência descartável do dashboard", compensatesId]);
    await fixture.query('UPDATE stock_balances SET quantity=$2,version=version+1,updated_at=now() WHERE product_id=$1', [productId, after]);
    return id;
  };
  try {
    await admin.connect(); const identity = await admin.query('SELECT environment,database_id AS "databaseId" FROM environment_sentinel WHERE id=$1', ["primary"]); assertDatabaseIdentity(source, identity.rows[0] ?? null);
    await admin.query(`CREATE DATABASE "${databaseName}"`); created = true; await admin.query(`COMMENT ON DATABASE "${databaseName}" IS '${marker}'`);
    await fixture.connect(); connected = true;
    for (const name of (await readdir(resolve("prisma", "migrations"))).filter((name) => /^\d+_/.test(name)).sort()) await fixture.query(await readFile(resolve("prisma", "migrations", name, "migration.sql"), "utf8"));
    await fixture.query('INSERT INTO environment_sentinel(id,environment,database_id) VALUES($1,$2,$3)', ["primary", "test", marker]);
    for (const role of Object.keys(actors)) { const id = randomUUID(); roles.set(role, id); await fixture.query('INSERT INTO roles(id,code,name,updated_at) VALUES($1,$2,$3,now())', [id, role, role]); }
    for (const code of PERMISSIONS) {
      const id = randomUUID(); await fixture.query('INSERT INTO permissions(id,code) VALUES($1,$2)', [id, code]);
      for (const [role, defaults] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) if ((defaults as readonly string[]).includes(code)) await fixture.query('INSERT INTO role_permissions(role_id,permission_id) VALUES($1,$2)', [roles.get(role), id]);
    }
    const hash = await hashPassword(password);
    for (const [role, actor] of Object.entries(actors)) await fixture.query('INSERT INTO users(id,name,email,password_hash,role_id,updated_at) VALUES($1,$2,$3,$4,$5,now())', [actor.id, `Conferência ${role}`, actor.email, hash, roles.get(role)]);
    for (const [index, id] of categories.entries()) await fixture.query('INSERT INTO categories(id,name,updated_at) VALUES($1,$2,now())', [id, ["Bebidas", "Pesáveis", "Inativos"][index]]);
    currentCheck = "fixtures financeiras históricas";
    await makeProduct(products.a, "DASH-UN", categories[0], "UN", "2.0000", "6.0000");
    await makeProduct(products.b, "DASH-KG", categories[1], "KG", "4.0000", "3.0000", true, "0.4000");
    await makeProduct(products.c, "DASH-INACTIVE", categories[2], "UN", "10.0000", "12.0000", false);
    await makeProduct(products.d, "DASH-EMPTY", categories[0], "UN", "0.0000", "0.0000");
    await movement(products.a, "ENTRY", "10.0000", "0.0000", "10.0000", "2026-10-01T13:00:00Z", "2026-10-01T13:00:00Z", "1.2000");
    const exit = await movement(products.a, "EXIT", "-2.0000", "10.0000", "8.0000", "2026-10-02T11:00:00Z", "2026-10-02T12:00:00Z", "2.0000", "5.0000");
    await fixture.query('UPDATE products SET acquisition_cost=$2,version=version+1,updated_at=now() WHERE id=$1', [products.a, "3.3350"]);
    await fixture.query('INSERT INTO product_value_history(id,product_id,type,previous_value,new_value,changed_by_id,operation_id,effective_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8)', [randomUUID(), products.a, "ACQUISITION_COST", "2.0000", "3.3350", actors.ADMINISTRATOR.id, randomUUID(), "2026-10-03T12:00:00Z"]);
    const adjustment = await movement(products.a, "NEGATIVE_ADJUSTMENT", "-1.0000", "8.0000", "7.0000", "2026-10-03T13:00:00Z", "2026-10-03T13:00:00Z", "3.3350");
    await movement(products.a, "COMPENSATION", "2.0000", "7.0000", "9.0000", "2026-10-04T11:00:00Z", "2026-10-04T11:00:00Z", "2.0000", "5.0000", exit);
    await movement(products.a, "EXIT", "-1.5000", "9.0000", "7.5000", "2026-10-01T16:00:00Z", "2026-10-05T13:00:00Z", "3.3350", "7.0000");
    await movement(products.a, "COMPENSATION", "1.0000", "7.5000", "8.5000", "2026-11-01T13:00:00Z", "2026-11-01T13:00:00Z", "3.3350", null, adjustment);
    await movement(products.b, "ENTRY", "0.5000", "0.0000", "0.5000", "2026-10-01T14:00:00Z", "2026-10-01T14:00:00Z", "4.0000");
    await movement(products.b, "EXIT", "-0.2500", "0.5000", "0.2500", "2026-10-02T15:00:00Z", "2026-10-02T15:00:00Z", "4.0000", "3.0000");
    await movement(products.c, "ENTRY", "2.0000", "0.0000", "2.0000", "2026-10-02T13:00:00Z", "2026-10-02T13:00:00Z", "10.0000");
    await movement(products.b, "ENTRY", "0.0001", "0.2500", "0.2501", "2026-10-10T02:59:59.999Z", "2026-10-10T02:59:59.999Z", "4.0000");
    await movement(products.b, "EXIT", "-0.0001", "0.2501", "0.2500", "2026-10-10T03:00:00Z", "2026-10-10T03:00:00Z", "4.0000", "3.0000");
    await check("novo histórico registra a hora de inserção após uma espera na transação", async () => {
      await fixture.query("BEGIN");
      try {
        await fixture.query("SELECT pg_sleep(0.03)");
        const inserted = await fixture.query('INSERT INTO product_value_history(id,product_id,type,new_value,changed_by_id,operation_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING effective_at>transaction_timestamp() AS effective_after_start,created_at>transaction_timestamp() AS created_after_start', [randomUUID(), products.a, "ACQUISITION_COST", "3.3350", actors.ADMINISTRATOR.id, randomUUID()]);
        assert.equal(inserted.rows[0].effective_after_start, true); assert.equal(inserted.rows[0].created_after_start, true);
      } finally { await fixture.query("ROLLBACK"); }
    });
    currentCheck = "inicialização do servidor isolado";
    server = spawn(process.execPath, [resolve("node_modules", "next", "dist", "bin", "next"), "start", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: process.cwd(), windowsHide: true, stdio: "ignore", env: { ...process.env, NODE_ENV: "production", APP_ENV: "test", DATABASE_ID: marker, DATABASE_URL: runtimeUrl.href, DIRECT_URL: adminUrl.href, AUTH_SECRET: randomBytes(48).toString("hex"), AUTH_URL: base, MAIL_TRANSPORT: "local", GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "", VERCEL: "", REQUEST_IP_HEADER: "", NEXT_TELEMETRY_DISABLED: "1" }
    });
    let ready = false; let startupError = false; server.once("error", () => { startupError = true; });
    for (let attempt = 0; attempt < 80; attempt++) {
      if (startupError || server.exitCode !== null) break;
      try { ready = (await fetch(base + "/api/health", { signal: AbortSignal.timeout(1000) })).ok; } catch { /* owned child startup */ }
      if (ready) break; await delay(250);
    }
    assert.ok(ready, "O servidor isolado precisa de build atualizado.");
    await check("dashboard exige autenticação", async () => { const result = await anonymous.request("/api/dashboard"); assert.equal(result.status, 401); assert.equal(result.headers.get("cache-control"), "no-store"); });
    await check("perfis autorizados entram e consultam o painel", async () => { for (const actor of Object.values(actors)) assert.equal(await actor.browser.login(actor.email, password), true); await dashboard(undefined, operator); });
    const data = await dashboard();
    await check("indicadores atuais incluem inativos sem contar inativos nos alertas", async () => { assert.deepEqual(data.current, { products: 4, activeProducts: 3, inactiveProducts: 1, lowStock: 1, emptyStock: 1, estimatedCost: "49.35", potentialSale: "75.75", estimatedMargin: "26.40" }); });
    await check("período usa valores históricos brutos e destaca correções", async () => { assert.deepEqual(data.movements, { entries: 3, exits: 3, adjustments: 1, compensations: 1, entriesCost: "34.00", exitsCost: "10.00", exitsSale: "21.25" }); });
    await check("quantidades de UN e KG permanecem separadas", async () => {
      assert.deepEqual(data.units.find((unit) => unit.unit === "KG"), { unit: "KG", entryQuantity: "0.5000", exitQuantity: "0.2500", adjustmentDelta: "0.0000", compensationDelta: "0.0000" });
      assert.deepEqual(data.units.find((unit) => unit.unit === "UN"), { unit: "UN", entryQuantity: "12.0000", exitQuantity: "3.5000", adjustmentDelta: "-1.0000", compensationDelta: "2.0000" });
    });
    await check("evolução usa custo da época e data do registro, sem reescrever retroativos", async () => { assert.deepEqual(data.series.map((point) => point.estimatedStockCost), ["22.00", "37.00", "44.35", "51.02", "46.01"]); assert.equal(data.series[0].exitsCost, "5.00"); assert.equal(data.series[4].exits, 0); });
    await check("ranking de movimentação compara contagens e o de valor considera saldos atuais", async () => { assert.deepEqual(data.mostMoved.map((item) => [item.id, item.movements]), [[products.a, 3], [products.b, 2], [products.c, 1]]); assert.equal(data.mostMoved[0].exitCost, "9.00"); assert.deepEqual(data.highestValue.map((item) => item.id), [products.a, products.c, products.b]); });
    await check("distribuição por categoria usa contagem e valor exatos", async () => { assert.deepEqual(data.categories.map((item) => [item.name, item.products, item.estimatedCost]), [["Bebidas", 2, "28.35"], ["Inativos", 1, "20.00"], ["Pesáveis", 1, "1.00"]]); });
    await check("lacunas e períodos sem operações não inventam movimentos", async () => { const empty = await dashboard("from=2026-10-06&to=2026-10-08"); assert.equal(empty.movements.entries + empty.movements.exits, 0); assert.equal(empty.series.length, 3); assert.ok(empty.series.every((point) => point.entries === 0 && point.exits === 0 && point.estimatedStockCost === "46.01")); assert.equal(empty.current.estimatedCost, "49.35"); });
    await check("corte diário respeita America/Sao_Paulo e microssegundos do banco", async () => { const ninth = await dashboard("from=2026-10-09&to=2026-10-09"); const tenth = await dashboard("from=2026-10-10&to=2026-10-10"); assert.equal(ninth.movements.entries, 1); assert.equal(ninth.movements.exits, 0); assert.equal(tenth.movements.entries, 0); assert.equal(tenth.movements.exits, 1); assert.equal(tenth.period.timeZone, "America/Sao_Paulo"); });
    await check("período longo agrupa por mês e período anterior ao cadastro vale zero", async () => { const monthly = await dashboard("from=2026-09-01&to=2026-10-31"); assert.equal(monthly.period.granularity, "month"); assert.equal(monthly.series.length, 2); const previous = await dashboard("from=2026-09-01&to=2026-09-02"); assert.ok(previous.series.every((point) => point.estimatedStockCost === "0.00")); });
    await check("filtros incompletos, repetidos, inválidos e futuros são recusados", async () => {
      for (const query of ["from=2026-10-01", "from=2026-02-30&to=2026-03-01", "from=2026-10-05&to=2026-10-01", "from=2026-10-01&from=2026-10-02&to=2026-10-03", "from=2024-01-01&to=2026-01-01", "from=2999-01-01&to=2999-01-02", "search=private"]) assert.equal((await administrator.request(`/api/dashboard?${query}`)).status, 400);
    });
    await check("filtros padrão devolvem período e avisos dos critérios", async () => { const defaults = await dashboard(""); assert.equal(defaults.period.timeZone, "America/Sao_Paulo"); assert.ok(defaults.warnings.length > 0); });
    await check("página inicial oferece o dashboard sem substituir os módulos", async () => { const result = await administrator.request("/"); assert.equal(result.status, 200); const html = await result.text(); assert.ok(html.includes("dashboard")); assert.ok(html.includes("/notificacoes")); });
    await check("revogação de cada permissão bloqueia os dados imediatamente", async () => {
      for (const permission of ["reports.read", "stock.read"]) {
        await fixture.query('DELETE FROM role_permissions WHERE role_id=$1 AND permission_id=(SELECT id FROM permissions WHERE code=$2)', [roles.get("OPERATOR"), permission]);
        const denied = await operator.request("/api/dashboard"); assert.equal(denied.status, 403); assert.equal(denied.headers.get("cache-control"), "no-store"); assert.equal((await denied.text()).includes("DASH-UN"), false);
        await fixture.query('INSERT INTO role_permissions(role_id,permission_id) SELECT $1,id FROM permissions WHERE code=$2', [roles.get("OPERATOR"), permission]);
      }
    });
    await check("consulta não altera saldos, movimentos, preferências ou gera auditoria", async () => { const before = (await fixture.query('SELECT (SELECT count(*)::int FROM stock_movements) AS movements,(SELECT count(*)::int FROM audit_events) AS audits,(SELECT count(*)::int FROM user_preferences) AS preferences')).rows[0]; await dashboard(); const after = (await fixture.query('SELECT (SELECT count(*)::int FROM stock_movements) AS movements,(SELECT count(*)::int FROM audit_events) AS audits,(SELECT count(*)::int FROM user_preferences) AS preferences')).rows[0]; assert.deepEqual(after, before); });
    await check("centavos são arredondados por produto e preservados na soma", async () => {
      for (let index = 0; index < 2; index++) { const id = randomUUID(); await makeProduct(id, `ROUND-${index}`, categories[0], "UN", "0.0050", "0.0050"); await movement(id, "ENTRY", "1.0000", "0.0000", "1.0000", "2026-10-01T14:00:00Z", "2026-10-01T14:00:00Z", "0.0050"); }
      const rounded = await dashboard(); assert.equal(rounded.current.estimatedCost, "49.37"); assert.equal(rounded.series[0].estimatedStockCost, "22.02"); assert.equal(rounded.movements.entriesCost, "34.02");
    });
    await check("dinheiro e quantidade acima da precisão binária continuam texto exato", async () => {
      const id = randomUUID(); await makeProduct(id, "EXACT-LIMIT", categories[0], "UN", "0.0001", "0.0001");
      await movement(id, "ENTRY", "99999999999999.9999", "0.0000", "99999999999999.9999", "2026-10-01T15:00:00Z", "2026-10-01T15:00:00Z", "0.0001");
      const exact = await dashboard(); assert.equal(exact.current.estimatedCost, "10000000049.37"); assert.equal(exact.highestValue[0].quantity, "99999999999999.9999");
      await fixture.query('UPDATE products SET acquisition_cost=$2,version=version+1,updated_at=now() WHERE id=$1', [id, "99999999999999.9999"]);
      await fixture.query('INSERT INTO product_value_history(id,product_id,type,previous_value,new_value,changed_by_id,operation_id,effective_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8)', [randomUUID(), id, "ACQUISITION_COST", "0.0001", "99999999999999.9999", actors.ADMINISTRATOR.id, randomUUID(), "2026-10-03T15:00:00Z"]);
      const huge = await dashboard(); assert.equal(huge.current.estimatedCost, "9999999999999999980000000049.37"); assert.equal(huge.series[4].estimatedStockCost, "9999999999999999980000000046.03");
    });
    await check("histórico inconsistente é sinalizado, sem inventar saldo para o gráfico", async () => { await fixture.query('UPDATE stock_balances SET quantity=quantity+1,version=version+1,updated_at=now() WHERE product_id=$1', [products.d]); assert.equal((await administrator.request("/api/dashboard?from=2026-10-01&to=2026-10-05")).status, 503); await fixture.query('UPDATE stock_balances SET quantity=0,version=version+1,updated_at=now() WHERE product_id=$1', [products.d]); });
    await check("sessão revogada não consulta o painel", async () => { await fixture.query('UPDATE users SET session_version=session_version+1,updated_at=now() WHERE id=$1', [actors.OPERATOR.id]); assert.equal((await operator.request("/api/dashboard")).status, 401); });
    console.info(`${checked} verificações de dashboard aprovadas em banco e servidor descartáveis: precisão, histórico, períodos, gráficos, permissões e integridade.`);
  } catch (error) {
    console.error(`Integração do dashboard interrompida em: ${currentCheck}. Dados privados foram omitidos.`);
    if (error instanceof assert.AssertionError && ["number", "boolean"].includes(typeof error.actual) && ["number", "boolean"].includes(typeof error.expected)) console.error(`Resultado recebido: ${String(error.actual)}; esperado: ${String(error.expected)}.`);
    process.exitCode = 1;
  } finally {
    await stopServer(server); if (connected) await fixture.end().catch(() => {});
    if (created) {
      const result = await admin.query("SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=$1", [databaseName]).catch(() => null);
      if (result?.rows[0]?.marker === marker && /^prevision_dashboard_test_[0-9a-f]{12}$/u.test(databaseName)) await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`).catch(() => { console.error("Não foi possível remover o banco descartável desta execução."); process.exitCode = 1; });
      else { console.error("Marcador divergente; limpeza interrompida."); process.exitCode = 1; }
    }
    await admin.end().catch(() => {});
  }
}
integration().catch(() => { console.error("Não foi possível preparar a integração do dashboard. Confira banco local, porta 3019 e build; detalhes privados omitidos."); process.exitCode = 1; });
