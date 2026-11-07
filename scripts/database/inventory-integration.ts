import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "pg";
import { config } from "dotenv";
import type { InventoryDTO, InventoryList, InventoryMutationResult } from "../../src/lib/inventory/types.ts";
import { assertDatabaseIdentity, assertLocalDevelopmentDatabase, readEnvironment } from "../../src/server/config/environment.ts";
import { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS } from "../../src/server/authorization/permissions.ts";
import { hashPassword } from "../../src/server/security/password.ts";
import { errorDiagnostic } from "../../src/server/security/error-diagnostic.ts";

config({ path: ".env", quiet: true });
const port = 3014;
const base = `http://127.0.0.1:${port}`;
class Browser {
  cookies = new Map<string, string>();
  async request(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    if (this.cookies.size) headers.set("cookie", [...this.cookies].map(([key, value]) => `${key}=${value}`).join("; "));
    const response = await fetch(new URL(path, base), { ...init, headers, redirect: "manual", signal: AbortSignal.timeout(40000) });
    for (const entry of response.headers.getSetCookie()) {
      const [pair, ...attributes] = entry.split(";"); const separator = pair.indexOf("=");
      const name = pair.slice(0, separator); const value = pair.slice(separator + 1);
      if (!value || attributes.some((part) => /^\s*max-age=0$/i.test(part))) this.cookies.delete(name); else this.cookies.set(name, value);
    }
    return response;
  }
  async json(path: string, body: unknown, method = "POST", extra: Record<string, string> = {}) {
    await this.request("/login"); const csrf = this.cookies.get("prevision.csrf"); assert.ok(csrf);
    return this.request(path, { method, headers: { "Content-Type": "application/json", Origin: base, "X-Prevision-CSRF": csrf, ...extra }, body: JSON.stringify(body) });
  }
  async login(email: string, password: string) {
    const challenge = await this.request("/api/auth/csrf"); assert.equal(challenge.status, 200);
    const { csrfToken } = await challenge.json() as { csrfToken: string };
    const response = await this.request("/api/auth/callback/credentials", { method: "POST", headers: { Origin: base, "Content-Type": "application/x-www-form-urlencoded", "X-Auth-Return-Redirect": "1" }, body: new URLSearchParams({ csrfToken, email, password, callbackUrl: base + "/" }) });
    const result = await response.json() as { url?: string };
    return Boolean(result.url && !new URL(result.url, base).searchParams.has("error") && [...this.cookies.keys()].some((name) => name === "prevision.session-token" || name.startsWith("prevision.session-token.")));
  }
}
async function freePort() {
  const probe = createServer(); await new Promise<void>((accept, reject) => { probe.once("error", reject); probe.listen(port, "127.0.0.1", accept); });
  await new Promise<void>((accept, reject) => probe.close((error) => error ? reject(error) : accept()));
}
async function stopServer(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null) return; child.kill();
  await Promise.race([new Promise<void>((accept) => child.once("exit", () => accept())), delay(5000)]);
  if (child.exitCode === null) { child.kill("SIGKILL"); await delay(500); }
}
async function get<T>(browser: Browser, path: string): Promise<T> {
  const response = await browser.request(path); assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  return response.json() as Promise<T>;
}
async function result(response: Response, status = 200): Promise<InventoryMutationResult> {
  assert.equal(response.status, status); assert.equal(response.headers.get("cache-control"), "no-store");
  const value = await response.json() as InventoryMutationResult; assert.ok(value.inventory?.id); assert.equal(typeof value.replayed, "boolean"); return value;
}

async function integration() {
  const source = readEnvironment(); assertLocalDevelopmentDatabase(source); assert.ok(source.DIRECT_URL);
  assert.equal(new URL(source.DIRECT_URL).host, new URL(source.DATABASE_URL).host); await freePort();
  const suffix = randomBytes(6).toString("hex"); const databaseName = `prevision_inventory_test_${suffix}`;
  const marker = `prevision-inventory-integration-${randomUUID()}`;
  const adminUrl = new URL(source.DIRECT_URL); const runtimeUrl = new URL(source.DATABASE_URL); adminUrl.pathname = runtimeUrl.pathname = `/${databaseName}`;
  const admin = new Client({ connectionString: source.DIRECT_URL, connectionTimeoutMillis: 5000 });
  const fixture = new Client({ connectionString: adminUrl.href, connectionTimeoutMillis: 5000 });
  const runtime = new Client({ connectionString: runtimeUrl.href, connectionTimeoutMillis: 5000 });
  const password = `Inventory-${randomBytes(20).toString("hex")}`;
  const actors = {
    ADMINISTRATOR: { id: randomUUID(), email: `inventory.admin.${suffix}@example.invalid`, browser: new Browser() },
    MANAGER: { id: randomUUID(), email: `inventory.manager.${suffix}@example.invalid`, browser: new Browser() },
    OPERATOR: { id: randomUUID(), email: `inventory.operator.${suffix}@example.invalid`, browser: new Browser() }
  };
  const administrator = actors.ADMINISTRATOR.browser; const manager = actors.MANAGER.browser; const operator = actors.OPERATOR.browser; const anonymous = new Browser();
  const roles = new Map<string, string>(); const categoryId = randomUUID(); const otherCategoryId = randomUUID(); const inactiveCategoryId = randomUUID();
  const supplierId = randomUUID(); const productIds = Array.from({ length: 3 }, () => randomUUID()); const inactiveProductId = randomUUID();
  let created = false; let fixtureConnected = false; let runtimeConnected = false; let server: ChildProcess | undefined;
  let checked = 0; let currentCheck = "preparo do banco de inventário";
  async function check(name: string, work: () => unknown | Promise<unknown>) { currentCheck = name; await work(); checked++; }
  const latest = (inventoryId: string) => get<InventoryDTO>(administrator, `/api/inventories/${inventoryId}`);
  const action = (inventory: InventoryDTO, key = randomUUID()) => ({ expectedVersion: inventory.version, idempotencyKey: key });
  const open = async (browser = administrator, ids = productIds) => (await result(await browser.json("/api/inventories", { title: `Conferência ${suffix}`, scope: "products", productIds: ids, idempotencyKey: randomUUID() }), 201)).inventory;
  const count = async (inventory: InventoryDTO, values: string[], browser = administrator) => (await result(await browser.json(`/api/inventories/${inventory.id}/counts`, { ...action(inventory), items: inventory.items.map((item, index) => ({ productId: item.productId, countedQuantity: values[index], justification: values[index] === item.baselineQuantity ? null : "Divergência física conferida" })) }, "PATCH"))).inventory;
  const resetStock = () => fixture.query('UPDATE stock_balances SET quantity=5,version=version+1,updated_at=clock_timestamp() WHERE product_id=ANY($1::uuid[])', [productIds]);
  const movement = async (type: "ENTRY" | "EXIT", productId = productIds[0]) => {
    const response = await administrator.json("/api/stock/movements", { type, productId, quantity: "1", occurredAt: new Date().toISOString(), idempotencyKey: randomUUID(), ...(type === "ENTRY" ? { unitCost: "2.335", supplierId } : { unitPrice: "4" }) });
    assert.equal(response.status, 201);
  };
  const snapshot = async (inventoryId: string) => {
    const stock = await fixture.query('SELECT product_id,quantity::text,version FROM stock_balances WHERE product_id=ANY($1::uuid[]) ORDER BY product_id', [productIds]);
    const alerts = await fixture.query('SELECT product_id,kind,opened_at::text,changed_at::text,resolved_at::text FROM stock_alerts WHERE product_id=ANY($1::uuid[]) ORDER BY product_id', [productIds]);
    const inventory = await fixture.query('SELECT status,version FROM inventories WHERE id=$1', [inventoryId]);
    const counts = await fixture.query('SELECT (SELECT count(*)::int FROM stock_movements) AS movements,(SELECT count(*)::int FROM audit_events) AS audits');
    return { stock: stock.rows, alerts: alerts.rows, inventory: inventory.rows, counts: counts.rows };
  };
  async function waitForAuthLock() {
    for (let attempt = 0; attempt < 100; attempt++) {
      const activity = await admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1 AND usename=$2 AND state='active' AND wait_event_type='Lock' AND wait_event='advisory'", [databaseName, decodeURIComponent(runtimeUrl.username)]);
      if (activity.rows[0].n) return; await delay(50);
    }
    assert.fail("A operação de teste não aguardou o lock controlado.");
  }
  try {
    await admin.connect();
    const identity = await admin.query('SELECT environment,database_id AS "databaseId" FROM environment_sentinel WHERE id=$1', ["primary"]); assertDatabaseIdentity(source, identity.rows[0] ?? null);
    assert.match(databaseName, /^prevision_inventory_test_[0-9a-f]{12}$/);
    await admin.query(`CREATE DATABASE "${databaseName}"`); created = true;
    await admin.query(`COMMENT ON DATABASE "${databaseName}" IS '${marker}'`);
    await fixture.connect(); fixtureConnected = true;
    for (const name of (await readdir(resolve("prisma", "migrations"))).filter((name) => /^\d+_/.test(name)).sort()) { currentCheck = `migration ${name}`; await fixture.query(await readFile(resolve("prisma", "migrations", name, "migration.sql"), "utf8")); }
    currentCheck = "fixtures de acesso e produtos";
    await fixture.query('INSERT INTO environment_sentinel(id,environment,database_id) VALUES($1,$2,$3)', ["primary", "test", marker]);
    for (const role of Object.keys(actors)) { const roleId = randomUUID(); roles.set(role, roleId); await fixture.query('INSERT INTO roles(id,code,name,updated_at) VALUES($1,$2,$3,now())', [roleId, role, role]); }
    for (const permission of PERMISSIONS) {
      const permissionId = randomUUID(); await fixture.query('INSERT INTO permissions(id,code) VALUES($1,$2)', [permissionId, permission]);
      for (const [role, permissions] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) if ((permissions as readonly string[]).includes(permission)) await fixture.query('INSERT INTO role_permissions(role_id,permission_id) VALUES($1,$2)', [roles.get(role), permissionId]);
    }
    const passwordHash = await hashPassword(password);
    for (const [role, actor] of Object.entries(actors)) await fixture.query('INSERT INTO users(id,name,email,password_hash,role_id,updated_at) VALUES($1,$2,$3,$4,$5,now())', [actor.id, `Inventário ${role}`, actor.email, passwordHash, roles.get(role)]);
    for (const [category, active] of [[categoryId, true], [otherCategoryId, true], [inactiveCategoryId, false]] as const) await fixture.query('INSERT INTO categories(id,name,is_active,updated_at) VALUES($1,$2,$3,now())', [category, `Categoria ${category}`, active]);
    await fixture.query('INSERT INTO suppliers(id,name,updated_at) VALUES($1,$2,now())', [supplierId, "Fornecedor de teste"]);
    for (const [index, productId] of [...productIds, inactiveProductId].entries()) {
      await fixture.query('INSERT INTO products(id,name,sku,category_id,unit_of_measure,minimum_stock,acquisition_cost,sale_price,is_active,updated_at) VALUES($1,$2,$3,$4,$5,2,2.335,4,$6,now())', [productId, `Produto inventário ${index}`, `INV-${suffix}-${index}`.toUpperCase(), categoryId, "UN", productId !== inactiveProductId]);
      await fixture.query('INSERT INTO stock_balances(product_id,quantity,updated_at) VALUES($1,5,now())', [productId]);
    }
    await runtime.connect(); runtimeConnected = true;
    currentCheck = "servidor isolado de inventário";
    server = spawn(process.execPath, [resolve("node_modules", "next", "dist", "bin", "next"), "start", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: process.cwd(), windowsHide: true, stdio: "ignore", env: {
      ...process.env, NODE_ENV: "production", APP_ENV: "test", DATABASE_ID: marker, DATABASE_URL: runtimeUrl.href, DIRECT_URL: adminUrl.href,
      AUTH_SECRET: randomBytes(48).toString("hex"), AUTH_URL: base, MAIL_TRANSPORT: "local", GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "", VERCEL: "", REQUEST_IP_HEADER: "", NEXT_TELEMETRY_DISABLED: "1"
    } });
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt++) { if (server.exitCode !== null) break; try { ready = (await fetch(base + "/api/health", { signal: AbortSignal.timeout(1000) })).ok; } catch {} if (ready) break; await delay(250); }
    assert.ok(ready, "Execute um build atualizado antes da integração de inventário.");

    await check("consultas e alterações exigem sessão e CSRF", async () => {
      assert.equal((await anonymous.request("/api/inventories")).status, 401);
      assert.equal((await anonymous.request("/api/inventories", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 403);
      for (const actor of Object.values(actors)) assert.equal(await actor.browser.login(actor.email, password), true);
      assert.equal((await administrator.json("/api/inventories", {}, "POST", { "X-Prevision-CSRF": "invalid" })).status, 403);
    });
    await check("validação recusa escopos ambíguos, inativos e entradas inválidas", async () => {
      const input = { title: "Conferência", scope: "products", productIds: [productIds[0]], idempotencyKey: randomUUID() };
      for (const body of [{ ...input, scope: "all" }, { ...input, productIds: [inactiveProductId] }, { ...input, productIds: [productIds[0], productIds[0]] }, { ...input, stock: "100" }, { ...input, scope: "categories", productIds: undefined, categoryIds: [inactiveCategoryId] }]) assert.equal((await administrator.json("/api/inventories", body)).status, 400);
    });
    await check("seleção por categoria e todos os ativos preserva o escopo escolhido", async () => {
      for (const scope of [{ scope: "categories", categoryIds: [categoryId] }, { scope: "all" }]) {
        const value = (await result(await administrator.json("/api/inventories", { title: "Escopo de conferência", ...scope, idempotencyKey: randomUUID() }), 201)).inventory;
        assert.equal(value.itemCount, 3); assert.equal(value.items.some((item) => item.productId === inactiveProductId), false);
      }
    });
    let inventory: InventoryDTO;
    await check("abertura seleciona snapshots e é idempotente sem mover saldo", async () => {
      const before = (await fixture.query('SELECT count(*)::int AS n FROM stock_movements')).rows[0].n;
      const input = { title: "Conferência principal", scope: "products", productIds: [...productIds].reverse(), idempotencyKey: randomUUID() };
      inventory = (await result(await administrator.json("/api/inventories", input), 201)).inventory;
      assert.equal(inventory.itemCount, 3); assert.equal(inventory.countedItems, 0); assert.ok(inventory.items.every((item) => item.baselineQuantity === "5.0000"));
      const replay = await result(await administrator.json("/api/inventories", { ...input, productIds, notes: null })); assert.equal(replay.replayed, true); assert.equal(replay.inventory.id, inventory.id);
      assert.equal((await fixture.query('SELECT count(*)::int AS n FROM stock_movements')).rows[0].n, before);
      assert.equal((await manager.json("/api/inventories", input)).status, 409);
    });
    await check("listas têm filtros paginação sem cache e rejeitam parâmetros inválidos", async () => {
      const list = await get<InventoryList>(operator, "/api/inventories?status=OPEN&search=principal&pageSize=1"); assert.equal(list.total, 1); assert.equal(list.items[0].id, inventory.id);
      for (const query of ["page=&page=2", "status=UNKNOWN", "pageSize=101", "unknown=x"]) assert.equal((await operator.request(`/api/inventories?${query}`)).status, 400);
      assert.equal((await operator.request("/api/inventories/not-an-id")).status, 400);
      assert.equal((await operator.request(`/api/inventories/${randomUUID()}`)).status, 404);
    });
    await check("operador conta mas não confirma ajustes de inventário", async () => {
      assert.equal((await operator.json(`/api/inventories/${inventory.id}/complete`, action(inventory))).status, 403);
      inventory = await count(inventory, ["4.5000", "5.5000", "5.0000"], operator);
      assert.equal(inventory.countedItems, 3); assert.equal(inventory.divergentItems, 2);
    });
    await check("versão protege contagem e chave repetida preserva efeitos", async () => {
      const input = { ...action(inventory), items: [{ productId: productIds[0], countedQuantity: "0", justification: "Perda identificada" }] };
      const response = await result(await operator.json(`/api/inventories/${inventory.id}/counts`, input, "PATCH")); inventory = response.inventory;
      const replay = await result(await operator.json(`/api/inventories/${inventory.id}/counts`, { ...input, items: [{ ...input.items[0], countedQuantity: "000.0000" }] }, "PATCH")); assert.equal(replay.replayed, true); assert.equal(replay.inventory.version, inventory.version);
      assert.equal((await operator.json(`/api/inventories/${inventory.id}/counts`, { ...input, idempotencyKey: randomUUID() }, "PATCH")).status, 409);
      assert.equal((await operator.json(`/api/inventories/${inventory.id}/counts`, { ...input, items: [{ ...input.items[0], countedQuantity: "1" }] }, "PATCH")).status, 409);
    });
    await check("divergência sem justificativa e produto externo são recusados sem efeito", async () => {
      for (const items of [[{ productId: productIds[1], countedQuantity: "0" }], [{ productId: inactiveProductId, countedQuantity: "0", justification: "Contagem" }], [{ productId: productIds[1], countedQuantity: "-1" }]]) assert.equal((await operator.json(`/api/inventories/${inventory.id}/counts`, { ...action(inventory), items }, "PATCH")).status, 400);
      assert.equal((await latest(inventory.id)).version, inventory.version);
    });
    await check("confirmação gera só ajustes divergentes com custo histórico e vínculo", async () => {
      const input = action(inventory); const completed = await result(await manager.json(`/api/inventories/${inventory.id}/complete`, input)); inventory = completed.inventory;
      assert.equal(inventory.status, "COMPLETED"); assert.equal(inventory.items.filter((item) => item.movementId).length, 2);
      const rows = await fixture.query('SELECT quantity_delta::text,historical_total_cost::text,operation_id FROM stock_movements WHERE id=ANY($1::uuid[])', [inventory.items.flatMap((item) => item.movementId ? [item.movementId] : [])]);
      assert.equal(new Set(rows.rows.map((row) => row.operation_id)).size, 1);
      const positive = rows.rows.find((row) => row.quantity_delta === "0.5000"); assert.equal(positive?.historical_total_cost, "1.17");
      const keyRepeat = await result(await manager.json(`/api/inventories/${inventory.id}/complete`, input)); assert.equal(keyRepeat.replayed, true);
      const alert = await fixture.query('SELECT kind FROM stock_alerts WHERE product_id=$1 AND resolved_at IS NULL', [productIds[0]]); assert.equal(alert.rows[0].kind, "EMPTY");
    });
    await check("histórico fechado e operações idempotentes são imutáveis no banco", async () => {
      const reject = async (sql: string, values: unknown[], code: string) => { let received = ""; try { await runtime.query(sql, values); } catch (error) { received = String((error as { code?: string }).code); } assert.equal(received, code); };
      await reject('UPDATE inventories SET title=$1 WHERE id=$2', ["Alteração proibida", inventory.id], "55000");
      await reject('UPDATE inventory_items SET justification=$1 WHERE inventory_id=$2', ["Alteração proibida", inventory.id], "55000");
      await reject('DELETE FROM inventories WHERE id=$1', [inventory.id], "42501");
      await reject('UPDATE inventory_operations SET request_hash=$1 WHERE inventory_id=$2', ["a".repeat(64), inventory.id], "42501");
      assert.equal((await operator.json(`/api/inventories/${inventory.id}/counts`, { ...action(inventory), items: [{ productId: productIds[0], countedQuantity: "0" }] }, "PATCH")).status, 409);
    });
    await check("compensar ajuste preserva o inventário histórico", async () => {
      const item = inventory.items.find((candidate) => candidate.movementId && candidate.difference === "0.5000")!;
      const response = await administrator.json(`/api/stock/movements/${item.movementId}/compensate`, { justification: "Correção explícita do ajuste", idempotencyKey: randomUUID() }); assert.equal(response.status, 201);
      const preserved = await latest(inventory.id); assert.equal(preserved.items.find((candidate) => candidate.productId === item.productId)!.countedQuantity, item.countedQuantity); assert.equal(preserved.version, inventory.version);
    });
    await check("movimentar e retornar ao mesmo saldo exige recontagem pela versão", async () => {
      await resetStock(); let value = await open(); value = await count(value, value.items.map((item) => item.baselineQuantity));
      await movement("ENTRY"); await movement("EXIT");
      assert.equal((await latest(value.id)).items.find((item) => item.productId === productIds[0])!.stockChanged, true);
      assert.equal((await administrator.json(`/api/inventories/${value.id}/complete`, action(value))).status, 409);
      const rebase = (await result(await operator.json(`/api/inventories/${value.id}/rebase`, { ...action(value), productIds: [productIds[0]] }))).inventory;
      assert.equal(rebase.countedItems, 2); assert.equal(rebase.items.find((item) => item.productId === productIds[0])!.countedQuantity, null);
      assert.equal(rebase.items.filter((item) => item.productId !== productIds[0]).every((item) => item.countedQuantity !== null), true);
      assert.equal((await administrator.json(`/api/inventories/${value.id}/complete`, action(rebase))).status, 400);
      const recounted = (await result(await operator.json(`/api/inventories/${value.id}/counts`, { ...action(rebase), items: [{ productId: productIds[0], countedQuantity: "5" }] }, "PATCH"))).inventory;
      const before = (await fixture.query('SELECT count(*)::int AS n FROM stock_movements')).rows[0].n;
      assert.equal((await result(await administrator.json(`/api/inventories/${value.id}/complete`, action(recounted)))).inventory.status, "COMPLETED");
      assert.equal((await fixture.query('SELECT count(*)::int AS n FROM stock_movements')).rows[0].n, before);
    });
    await check("troca da unidade impede contar rebase e confirmação até novo inventário", async () => {
      let value = await open(); value = await count(value, value.items.map((item) => item.baselineQuantity));
      await fixture.query('UPDATE products SET unit_of_measure=$1,updated_at=now() WHERE id=$2', ["KG", productIds[0]]);
      assert.equal((await latest(value.id)).changedItems, 1);
      assert.equal((await administrator.json(`/api/inventories/${value.id}/complete`, action(value))).status, 409);
      assert.equal((await administrator.json(`/api/inventories/${value.id}/rebase`, { ...action(value), productIds: [productIds[0]] })).status, 409);
      await fixture.query('UPDATE products SET unit_of_measure=$1,updated_at=now() WHERE id=$2', ["UN", productIds[0]]);
    });
    await check("inativação durante a contagem impede confirmação", async () => {
      let value = await open(administrator, [productIds[0]]); value = await count(value, value.items.map((item) => item.baselineQuantity));
      await fixture.query('UPDATE products SET is_active=false,updated_at=now() WHERE id=$1', [productIds[0]]);
      try {
        assert.equal((await latest(value.id)).items[0].productIsActive, false);
        assert.equal((await administrator.json(`/api/inventories/${value.id}/complete`, action(value))).status, 409);
      } finally { await fixture.query('UPDATE products SET is_active=true,updated_at=now() WHERE id=$1', [productIds[0]]); }
    });
    await check("quantidades fracionárias e totais são preservados sem IEEE-754", async () => {
      await resetStock(); let value = await open(administrator, [productIds[2]]); value = await count(value, ["0.0001"]);
      value = (await result(await administrator.json(`/api/inventories/${value.id}/complete`, action(value)))).inventory;
      const row = (await fixture.query('SELECT quantity_delta::text,historical_total_cost::text,quantity_after::text FROM stock_movements WHERE id=$1', [value.items[0].movementId])).rows[0];
      assert.equal(row.quantity_delta, "-4.9999"); assert.equal(row.quantity_after, "0.0001"); assert.equal(row.historical_total_cost, "11.67");
    });
    await check("falha no fechamento reverte todos os ajustes alertas vínculos e auditoria", async () => {
      await resetStock(); let value = await open(); value = await count(value, ["4.0000", "6.0000", "7.0000"]); const before = await snapshot(value.id); const input = action(value);
      await fixture.query("CREATE FUNCTION reject_inventory_completion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.origin='inventory.complete' AND NEW.module::text='INVENTORY' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Controlled inventory rollback'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_inventory_completion BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_inventory_completion()");
      try { assert.equal((await administrator.json(`/api/inventories/${value.id}/complete`, input)).status, 503); } finally { await fixture.query('DROP TRIGGER reject_inventory_completion ON audit_events; DROP FUNCTION reject_inventory_completion()'); }
      assert.deepEqual(await snapshot(value.id), before);
      assert.equal((await latest(value.id)).items.every((item) => item.movementId === null), true);
      assert.equal((await result(await administrator.json(`/api/inventories/${value.id}/complete`, input))).inventory.status, "COMPLETED");
    });
    await check("duas confirmações concorrentes da mesma chave aplicam uma vez", async () => {
      await resetStock(); let value = await open(administrator, [productIds[0]]); value = await count(value, ["6.0000"]); const input = action(value);
      const responses = await Promise.all([administrator.json(`/api/inventories/${value.id}/complete`, input), administrator.json(`/api/inventories/${value.id}/complete`, input)]);
      const values = await Promise.all(responses.map((response) => result(response))); assert.equal(values.filter((value) => value.replayed).length, 1);
      assert.equal((await fixture.query('SELECT quantity::text FROM stock_balances WHERE product_id=$1', [productIds[0]])).rows[0].quantity, "6.0000");
    });
    await check("inventários simultâneos do mesmo produto não sobrescrevem o saldo", async () => {
      await resetStock(); let first = await open(administrator, [productIds[0]]); let second = await open(manager, [productIds[0]]);
      first = await count(first, ["6.0000"]); second = await count(second, ["7.0000"]);
      const responses = await Promise.all([administrator.json(`/api/inventories/${first.id}/complete`, action(first)), manager.json(`/api/inventories/${second.id}/complete`, action(second))]);
      assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
      const histories = await Promise.all([latest(first.id), latest(second.id)]); assert.equal(histories.filter((item) => item.status === "COMPLETED").length, 1);
    });
    await check("cancelamento respeita criador ou ajustador e não modifica estoque", async () => {
      const value = await open(operator, [productIds[0]]); const before = await snapshot(value.id);
      assert.equal((await actors.OPERATOR.browser.json(`/api/inventories/${(await open()).id}/cancel`, action(value))).status, 403);
      const canceled = await result(await operator.json(`/api/inventories/${value.id}/cancel`, action(value))); assert.equal(canceled.inventory.status, "CANCELED");
      const after = await snapshot(value.id); assert.deepEqual(after.stock, before.stock); assert.deepEqual(after.alerts, before.alerts);
    });
    await check("stock.read é exigida para consultas e detalhes de inventário", async () => {
      await fixture.query('DELETE FROM role_permissions WHERE role_id=$1 AND permission_id=(SELECT id FROM permissions WHERE code=$2)', [roles.get("MANAGER"), "stock.read"]);
      try {
        assert.equal((await manager.request("/api/inventories")).status, 403);
        assert.equal((await manager.request(`/api/inventories/${inventory.id}`)).status, 403);
      } finally { await fixture.query('INSERT INTO role_permissions(role_id,permission_id) SELECT $1,id FROM permissions WHERE code=$2', [roles.get("MANAGER"), "stock.read"]); }
    });
    await check("alteração de perfil durante espera impede a confirmação", async () => {
      let value = await open(manager, [productIds[1]]); value = await count(value, ["8.0000"]); let pending: Promise<Response> | undefined; let transactionOpen = false;
      try {
        await fixture.query("BEGIN"); transactionOpen = true; await fixture.query("SELECT pg_advisory_xact_lock(2026103002)");
        pending = manager.json(`/api/inventories/${value.id}/complete`, action(value)); await waitForAuthLock();
        await fixture.query('UPDATE users SET role_id=$1,updated_at=now() WHERE id=$2', [roles.get("OPERATOR"), actors.MANAGER.id]);
        await fixture.query("COMMIT"); transactionOpen = false; assert.equal((await pending).status, 403);
        assert.equal((await latest(value.id)).status, "OPEN");
      } finally { if (transactionOpen) await fixture.query("ROLLBACK"); await pending?.catch(() => {}); await fixture.query('UPDATE users SET role_id=$1,updated_at=now() WHERE id=$2', [roles.get("MANAGER"), actors.MANAGER.id]); }
    });
    await check("sessão revogada durante espera não salva contagem", async () => {
      const value = await open(operator, [productIds[2]]); let pending: Promise<Response> | undefined; let transactionOpen = false;
      try {
        await fixture.query("BEGIN"); transactionOpen = true; await fixture.query("SELECT pg_advisory_xact_lock(2026103002)");
        pending = operator.json(`/api/inventories/${value.id}/counts`, { ...action(value), items: [{ productId: productIds[2], countedQuantity: "5" }] }, "PATCH"); await waitForAuthLock();
        await fixture.query('UPDATE login_sessions SET revoked_at=clock_timestamp() WHERE user_id=$1 AND revoked_at IS NULL', [actors.OPERATOR.id]);
        await fixture.query("COMMIT"); transactionOpen = false; assert.equal((await pending).status, 401); assert.equal((await latest(value.id)).countedItems, 0);
      } finally { if (transactionOpen) await fixture.query("ROLLBACK"); await pending?.catch(() => {}); }
    });
    await check("lote de justificativas Unicode acima de 16KB respeita o limite ampliado de inventário", async () => {
      const ids = Array.from({ length: 20 }, () => randomUUID());
      for (const [index, productId] of ids.entries()) {
        await fixture.query('INSERT INTO products(id,name,sku,category_id,updated_at) VALUES($1,$2,$3,$4,now())', [productId, `Unicode ${index}`, `UNICODE-${suffix}-${index}`.toUpperCase(), categoryId]);
        await fixture.query('INSERT INTO stock_balances(product_id,quantity,updated_at) VALUES($1,0,now())', [productId]);
      }
      const value = await open(administrator, ids);
      const justification = "á".repeat(598) + "😀";
      const input = { ...action(value), items: value.items.map((item) => ({ productId: item.productId, countedQuantity: "1", justification })) };
      assert.ok(Buffer.byteLength(JSON.stringify(input)) > 16384);
      const saved = (await result(await administrator.json(`/api/inventories/${value.id}/counts`, input, "PATCH"))).inventory;
      assert.equal(saved.countedItems, 20); assert.equal(saved.items.every((item) => item.justification === justification), true);
    });
    await check("lotes maiores que 200 são recusados sem truncar inventário", async () => {
      await fixture.query('INSERT INTO products(id,name,sku,category_id,updated_at) SELECT gen_random_uuid(),$1,$2||n::text,$3,now() FROM generate_series(1,201) n', ["Produto de lote", `BULK-${suffix}-`.toUpperCase(), otherCategoryId]);
      await fixture.query('INSERT INTO stock_balances(product_id,quantity,updated_at) SELECT id,0,now() FROM products WHERE category_id=$1', [otherCategoryId]);
      const before = (await fixture.query('SELECT count(*)::int AS n FROM inventories')).rows[0].n;
      assert.equal((await administrator.json("/api/inventories", { title: "Escopo grande", scope: "categories", categoryIds: [otherCategoryId], idempotencyKey: randomUUID() })).status, 400);
      assert.equal((await fixture.query('SELECT count(*)::int AS n FROM inventories')).rows[0].n, before);
    });
    await check("auditoria liga conclusão aos ajustes sem incluir segredos de solicitação", async () => {
      const events = await fixture.query("SELECT module::text,entity_id,operation_id,new_values FROM audit_events WHERE origin='inventory.complete'"); assert.ok(events.rows.some((row) => row.module === "INVENTORY"));
      for (const row of events.rows) { const text = JSON.stringify(row.new_values); assert.equal(text.includes("requestHash"), false); assert.equal(text.includes("idempotencyKey"), false); }
      const duplicates = await fixture.query('SELECT inventory_id,product_id,count(*)::int AS n FROM inventory_items GROUP BY inventory_id,product_id HAVING count(*)>1'); assert.equal(duplicates.rows.length, 0);
    });
    console.info(`${checked} verificações de inventário aprovadas em banco e servidor descartáveis: contagem, snapshots, permissões, idempotência, concorrência, rebase, ajustes, auditoria e rollback.`);
  } catch (error) {
    console.error(`Integração de inventário interrompida em: ${currentCheck}. Dados sensíveis foram omitidos.`);
    console.error(errorDiagnostic(error));
    if (error instanceof assert.AssertionError && ["number", "boolean"].includes(typeof error.actual) && ["number", "boolean"].includes(typeof error.expected)) console.error(`Resultado recebido: ${String(error.actual)}; esperado: ${String(error.expected)}.`);
    process.exitCode = 1;
  } finally {
    await stopServer(server); if (runtimeConnected) await runtime.end().catch(() => {}); if (fixtureConnected) await fixture.end().catch(() => {});
    if (created) {
      const known = await admin.query("SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=$1", [databaseName]).catch(() => null);
      if (known?.rows[0]?.marker === marker && /^prevision_inventory_test_[0-9a-f]{12}$/.test(databaseName)) await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`).catch(() => { console.error("Não foi possível remover o banco descartável de inventário."); process.exitCode = 1; });
      else { console.error("Marcador divergente; limpeza de inventário interrompida."); process.exitCode = 1; }
    }
    await admin.end().catch(() => {});
  }
}
integration().catch(() => { console.error("Não foi possível preparar a integração de inventário. Confira banco local, porta 3014 e build; detalhes privados omitidos."); process.exitCode = 1; });
