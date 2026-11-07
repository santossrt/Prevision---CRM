import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "pg";
import { config } from "dotenv";
import type { CreateMovementInput, MovementResult, StockBalances, StockList, StockMovementDTO, StockOptions, StockProductDTO } from "../../src/lib/stock/types.ts";
import { assertDatabaseIdentity, assertLocalDevelopmentDatabase, readEnvironment } from "../../src/server/config/environment.ts";
import { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS } from "../../src/server/authorization/permissions.ts";
import { hashPassword } from "../../src/server/security/password.ts";

config({ path: ".env", quiet: true });

const port = 3012;
const base = `http://127.0.0.1:${port}`;
const diagnostics = new Set<string>();

class Browser {
  cookies = new Map<string, string>();

  async request(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    if (this.cookies.size) headers.set("cookie", [...this.cookies].map(([key, value]) => `${key}=${value}`).join("; "));
    const response = await fetch(new URL(path, base), { ...init, headers, redirect: "manual", signal: AbortSignal.timeout(20000) });
    for (const entry of response.headers.getSetCookie()) {
      const [pair, ...attributes] = entry.split(";");
      const separator = pair.indexOf("=");
      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      if (!value || attributes.some((part) => /^\s*max-age=0$/i.test(part))) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return response;
  }

  async json(path: string, body: unknown, method = "POST", extra: Record<string, string> = {}) {
    await this.request("/login");
    const csrf = this.cookies.get("prevision.csrf");
    assert.ok(csrf, "A navegação precisa fornecer proteção CSRF.");
    return this.request(path, {
      method, headers: { "Content-Type": "application/json", Origin: base, "X-Prevision-CSRF": csrf, ...extra }, body: JSON.stringify(body)
    });
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
    const error = result.url ? new URL(result.url, base).searchParams.get("error") : "MissingRedirect";
    if (error && /^[A-Za-z]{1,64}$/.test(error)) diagnostics.add(`Auth.js: ${error}`);
    return Boolean(result.url && !error && [...this.cookies.keys()].some((name) => name === "prevision.session-token" || name.startsWith("prevision.session-token.")));
  }
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

async function get<T>(browser: Browser, path: string): Promise<T> {
  const response = await browser.request(path);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  return response.json() as Promise<T>;
}

async function movement(response: Response, status = 201): Promise<MovementResult> {
  assert.equal(response.status, status);
  const result = await response.json() as MovementResult;
  assert.ok(result.movement?.id);
  assert.equal(result.replayed, status === 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  return result;
}

async function integration() {
  const source = readEnvironment();
  assertLocalDevelopmentDatabase(source);
  assert.ok(source.DIRECT_URL);
  assert.equal(new URL(source.DIRECT_URL).host, new URL(source.DATABASE_URL).host);
  await assertFreePort();
  const suffix = randomBytes(6).toString("hex");
  const databaseName = `prevision_stock_test_${suffix}`;
  assert.match(databaseName, /^prevision_stock_test_[0-9a-f]{12}$/);
  const marker = `prevision-stock-integration-${randomUUID()}`;
  const adminUrl = new URL(source.DIRECT_URL);
  const runtimeUrl = new URL(source.DATABASE_URL);
  adminUrl.pathname = runtimeUrl.pathname = `/${databaseName}`;
  const admin = new Client({ connectionString: source.DIRECT_URL, connectionTimeoutMillis: 5000 });
  const fixture = new Client({ connectionString: adminUrl.href, connectionTimeoutMillis: 5000 });
  const password = `Stock-integration-${randomBytes(20).toString("hex")}`;
  const actors = {
    ADMINISTRATOR: { id: randomUUID(), email: `stock.admin.${suffix}@example.invalid`, browser: new Browser() },
    MANAGER: { id: randomUUID(), email: `stock.manager.${suffix}@example.invalid`, browser: new Browser() },
    OPERATOR: { id: randomUUID(), email: `stock.operator.${suffix}@example.invalid`, browser: new Browser() }
  };
  const administrator = actors.ADMINISTRATOR.browser;
  const manager = actors.MANAGER.browser;
  const operator = actors.OPERATOR.browser;
  const anonymous = new Browser();
  const categoryId = randomUUID();
  const otherCategoryId = randomUUID();
  const supplierId = randomUUID();
  const inactiveSupplierId = randomUUID();
  const customerId = randomUUID();
  const inactiveCustomerId = randomUUID();
  const mainId = randomUUID();
  const raceId = randomUUID();
  const fractionId = randomUUID();
  const overflowId = randomUUID();
  const inactiveId = randomUUID();
  const keyRaceId = randomUUID();
  const roles = new Map<string, string>();
  let created = false;
  let connectedFixture = false;
  let server: ChildProcess | undefined;
  let checked = 0;
  let currentCheck = "preparo do banco descartável";

  async function check(name: string, work: () => unknown | Promise<unknown>) {
    currentCheck = name;
    await work();
    checked += 1;
  }
  const request = (type: CreateMovementInput["type"], productId = mainId, overrides: Record<string, unknown> = {}) => ({
    type, productId, quantity: "1.0000", occurredAt: new Date().toISOString(), idempotencyKey: randomUUID(),
    ...(type === "ENTRY" ? { unitCost: "1.0000", supplierId } : type === "EXIT" ? { unitPrice: "2.0000" } : { justification: "Ajuste justificado no banco descartável" }),
    ...overrides
  });
  const balance = async (id = mainId) => (await fixture.query('SELECT quantity::text,version FROM stock_balances WHERE product_id=$1', [id])).rows[0] as { quantity: string; version: number };
  const counts = async () => (await fixture.query('SELECT (SELECT count(*)::int FROM stock_movements) AS movements,(SELECT count(*)::int FROM audit_events WHERE module=\'STOCK\') AS audits')).rows[0] as { movements: number; audits: number };
  const issue = async (browser: Browser, input: ReturnType<typeof request>) => (await movement(await browser.json("/api/stock/movements", input))).movement;

  async function waitForAuthLock() {
    for (let attempt = 0; attempt < 70; attempt++) {
      const activity = await admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1 AND usename=$2 AND state='active' AND wait_event_type='Lock' AND wait_event='advisory'", [databaseName, decodeURIComponent(runtimeUrl.username)]);
      if (activity.rows[0].n > 0) return;
      await delay(50);
    }
    assert.fail("A requisição de teste não aguardou o lock controlado.");
  }

  try {
    await admin.connect();
    const identity = await admin.query('SELECT environment,database_id AS "databaseId" FROM environment_sentinel WHERE id=$1', ["primary"]);
    assertDatabaseIdentity(source, identity.rows[0] ?? null);
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    await admin.query(`COMMENT ON DATABASE "${databaseName}" IS '${marker}'`);
    await fixture.connect();
    connectedFixture = true;
    for (const name of (await readdir(resolve("prisma", "migrations"))).filter((name) => /^\d+_/.test(name)).sort()) {
      await fixture.query(await readFile(resolve("prisma", "migrations", name, "migration.sql"), "utf8"));
    }
    await fixture.query('INSERT INTO environment_sentinel(id,environment,database_id) VALUES($1,$2,$3)', ["primary", "test", marker]);
    for (const code of Object.keys(actors)) {
      const id = randomUUID();
      roles.set(code, id);
      await fixture.query('INSERT INTO roles(id,code,name,updated_at) VALUES($1,$2,$3,now())', [id, code, code]);
    }
    for (const code of PERMISSIONS) {
      const id = randomUUID();
      await fixture.query('INSERT INTO permissions(id,code) VALUES($1,$2)', [id, code]);
      for (const [role, allowed] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
        if ((allowed as readonly string[]).includes(code)) await fixture.query('INSERT INTO role_permissions(role_id,permission_id) VALUES($1,$2)', [roles.get(role), id]);
      }
    }
    const hash = await hashPassword(password);
    for (const [role, actor] of Object.entries(actors)) await fixture.query('INSERT INTO users(id,name,email,password_hash,role_id,updated_at) VALUES($1,$2,$3,$4,$5,now())', [actor.id, "Estoque de teste", actor.email, hash, roles.get(role)]);
    for (const [id, name] of [[categoryId, "Categoria de estoque"], [otherCategoryId, "Outra categoria"]]) await fixture.query('INSERT INTO categories(id,name,updated_at) VALUES($1,$2,now())', [id, name]);
    for (const [id, name, active] of [[supplierId, "Fornecedor de estoque", true], [inactiveSupplierId, "Fornecedor inativo", false]]) await fixture.query('INSERT INTO suppliers(id,name,is_active,updated_at) VALUES($1,$2,$3,now())', [id, name, active]);
    for (const [id, name, active] of [[customerId, "Cliente de estoque", true], [inactiveCustomerId, "Cliente inativo", false]]) await fixture.query('INSERT INTO customers(id,name,is_active,updated_at) VALUES($1,$2,$3,now())', [id, name, active]);
    for (const [id, sku, active, category, minimum, cost, price, barcode] of [
      [mainId, "MOV-001", true, categoryId, "3", "2.5000", "4.5000", "0001234567890"],
      [raceId, "MOV-RACE", true, categoryId, "0", "1", "2", null],
      [fractionId, "MOV-FRACTION", true, otherCategoryId, "1", "0.01", "0.02", null],
      [overflowId, "MOV-LIMIT", true, otherCategoryId, "0", "1", "2", null],
      [inactiveId, "MOV-INACTIVE", false, categoryId, "0", "1", "2", null],
      [keyRaceId, "MOV-KEY", true, categoryId, "0", "1", "2", null]
    ]) {
      await fixture.query('INSERT INTO products(id,name,sku,is_active,category_id,default_supplier_id,unit_of_measure,minimum_stock,acquisition_cost,sale_price,barcode,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())', [id, `Produto ${sku}`, sku, active, category, supplierId, "UN", minimum, cost, price, barcode]);
      await fixture.query('INSERT INTO stock_balances(product_id,updated_at) VALUES($1,now())', [id]);
    }

    currentCheck = "inicialização do servidor isolado";
    server = spawn(process.execPath, [resolve("node_modules", "next", "dist", "bin", "next"), "start", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: process.cwd(), windowsHide: true, stdio: ["ignore", "ignore", "pipe"], env: {
        ...process.env, NODE_ENV: "production", APP_ENV: "test", DATABASE_ID: marker,
        DATABASE_URL: runtimeUrl.href, DIRECT_URL: adminUrl.href, AUTH_SECRET: randomBytes(48).toString("hex"), AUTH_URL: base,
        MAIL_TRANSPORT: "local", GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "", VERCEL: "", REQUEST_IP_HEADER: "", NEXT_TELEMETRY_DISABLED: "1"
      }
    });
    server.stderr?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split(/\r?\n/)) if (/^\[auth\] [A-Za-z]{1,64}$/.test(line)) diagnostics.add(line);
    });
    let startupError = false;
    server.once("error", () => { startupError = true; });
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      if (startupError || server.exitCode !== null) break;
      try { ready = (await fetch(base + "/api/health", { signal: AbortSignal.timeout(1000) })).ok; } catch { /* Wait for the child owned by this run. */ }
      if (ready) break;
      await delay(250);
    }
    assert.ok(ready, "O servidor isolado precisa de um build atualizado.");

    await check("consultas de estoque exigem autenticação", async () => {
      for (const path of ["balances", "options", "movements", `products/${mainId}`, `movements/${randomUUID()}`]) assert.equal((await anonymous.request(`/api/stock/${path}`)).status, 401);
    });
    await check("login de administrador, gerente e operador", async () => {
      for (const actor of Object.values(actors)) assert.equal(await actor.browser.login(actor.email, password), true);
      assert.equal((await administrator.request("/estoque")).status, 200);
    });
    await check("consulta de saldo zero e opções somente ativas", async () => {
      const result = await get<StockBalances>(operator, "/api/stock/balances");
      assert.equal(result.total, 6);
      assert.equal(result.items.every((item) => item.quantity === "0.0000" && item.version === 0), true);
      assert.equal(result.summary.estimatedCost, "0.00");
      const options = await get<StockOptions>(operator, "/api/stock/options");
      assert.equal(options.suppliers.some((item) => item.id === supplierId), true);
      assert.equal(options.suppliers.some((item) => item.id === inactiveSupplierId), false);
      assert.equal(options.customers.some((item) => item.id === inactiveCustomerId), false);
    });
    await check("estoque consulta sem depender de catalog.read", async () => {
      await fixture.query('DELETE FROM role_permissions WHERE role_id=$1 AND permission_id=(SELECT id FROM permissions WHERE code=$2)', [roles.get("OPERATOR"), "catalog.read"]);
      try {
        assert.equal((await operator.request("/api/stock/options")).status, 200);
        assert.equal((await operator.request(`/api/stock/products/${mainId}`)).status, 200);
      } finally { await fixture.query('INSERT INTO role_permissions(role_id,permission_id) SELECT $1,id FROM permissions WHERE code=$2 ON CONFLICT DO NOTHING', [roles.get("OPERATOR"), "catalog.read"]); }
    });
    await check("origem e CSRF forjados impedem lançamentos", async () => {
      assert.equal((await administrator.json("/api/stock/movements", request("ENTRY"), "POST", { Origin: "https://attacker.invalid" })).status, 403);
      assert.equal((await administrator.json("/api/stock/movements", request("ENTRY"), "POST", { "X-Prevision-CSRF": "forged" })).status, 403);
    });
    await check("contrato estrito rejeita campos de saldo, autoria e tipos irrelevantes", async () => {
      for (const override of [{ quantityAfter: "999" }, { performedById: actors.ADMINISTRATOR.id }, { unitPrice: "2" }]) assert.equal((await administrator.json("/api/stock/movements", request("ENTRY", mainId, override))).status, 400);
      assert.equal((await administrator.json("/api/stock/movements", request("POSITIVE_ADJUSTMENT", mainId, { unitCost: "1" }))).status, 400);
      assert.equal((await administrator.json("/api/stock/movements", request("ENTRY", mainId, { type: "COMPENSATION" }))).status, 400);
    });
    await check("quantidades e valores rejeitam precisão inválida e formatos inexatos", async () => {
      for (const quantity of ["0", "-1", "1.00001", "1e2", "NaN", 1, "100000000000000"]) assert.equal((await administrator.json("/api/stock/movements", request("ENTRY", mainId, { quantity }))).status, 400);
      for (const unitCost of ["-1", "1.00001", "Infinity"]) assert.equal((await administrator.json("/api/stock/movements", request("ENTRY", mainId, { unitCost }))).status, 400);
    });
    await check("datas, identificadores e finalidade de entrada são validados", async () => {
      for (const override of [{ occurredAt: "2026-10-31T10:00:00" }, { occurredAt: new Date(Date.now() + 3600000).toISOString() }, { productId: "invalid" }, { idempotencyKey: "invalid" }, { supplierId: null }]) assert.equal((await administrator.json("/api/stock/movements", request("ENTRY", mainId, override))).status, 400);
      const missing = request("ENTRY") as Record<string, unknown>;
      delete missing.unitCost;
      assert.equal((await administrator.json("/api/stock/movements", missing)).status, 400);
    });
    await check("produto e partes relacionadas devem estar ativos", async () => {
      assert.equal((await administrator.json("/api/stock/movements", request("ENTRY", inactiveId))).status, 400);
      assert.equal((await administrator.json("/api/stock/movements", request("ENTRY", mainId, { supplierId: inactiveSupplierId }))).status, 400);
      assert.equal((await administrator.json("/api/stock/movements", request("EXIT", mainId, { customerId: inactiveCustomerId }))).status, 400);
      assert.equal((await administrator.json("/api/stock/movements", request("ENTRY", randomUUID()))).status, 404);
      assert.deepEqual(await counts(), { movements: 0, audits: 0 });
    });

    let entry!: StockMovementDTO;
    let exit!: StockMovementDTO;
    let exitCompensation!: StockMovementDTO;
    const entryRequest = request("ENTRY", mainId, { quantity: "10.0000", unitCost: "1.2345", occurredAt: new Date(Date.now() - 86400000).toISOString(), notes: "Entrada de teste" });
    await check("entrada do operador grava saldo, valores e autoria atomicamente", async () => {
      entry = await issue(operator, entryRequest);
      assert.equal(entry.type, "ENTRY");
      assert.equal(entry.quantityBefore, "0.0000");
      assert.equal(entry.quantityAfter, "10.0000");
      assert.equal(entry.historicalUnitCost, "1.2345");
      assert.equal(entry.historicalTotalCost, "12.35");
      assert.equal(entry.historicalUnitPrice, null);
      assert.equal(entry.performedBy.id, actors.OPERATOR.id);
      assert.equal(entry.supplier?.id, supplierId);
      assert.equal(entry.notes, "Entrada de teste");
      assert.deepEqual(await balance(), { quantity: "10.0000", version: 1 });
      const hashRow = (await fixture.query('SELECT request_hash FROM stock_movements WHERE id=$1', [entry.id])).rows[0];
      assert.match(hashRow.request_hash, /^[0-9a-f]{64}$/);
    });
    await check("repetição exata devolve a mesma entrada sem novos efeitos", async () => {
      const before = await counts();
      const result = await movement(await operator.json("/api/stock/movements", entryRequest), 200);
      assert.equal(result.movement.id, entry.id);
      assert.deepEqual(await counts(), before);
      assert.deepEqual(await balance(), { quantity: "10.0000", version: 1 });
    });
    await check("repetição normalizada mantém a mesma intenção sem duplicar efeitos", async () => {
      const before = await counts();
      const result = await movement(await operator.json("/api/stock/movements", { ...entryRequest, productId: mainId.toUpperCase(), quantity: "10", unitCost: "1.2345", notes: "  Entrada de teste  " }), 200);
      assert.equal(result.movement.id, entry.id);
      assert.deepEqual(await counts(), before);
    });
    await check("chave reutilizada com conteúdo ou autor diferente não reaplica nem vaza operação", async () => {
      const before = await counts();
      assert.equal((await operator.json("/api/stock/movements", { ...entryRequest, quantity: "11" })).status, 409);
      const response = await administrator.json("/api/stock/movements", entryRequest);
      assert.equal(response.status, 409);
      const body = await response.text();
      assert.equal(body.includes(entry.id), false);
      assert.deepEqual(await counts(), before);
    });
    await check("saída registra custo cadastrado e preço praticado com arredondamento", async () => {
      exit = await issue(operator, request("EXIT", mainId, { quantity: "3", unitPrice: "4.5678", customerId }));
      assert.equal(exit.quantityDelta, "-3.0000");
      assert.equal(exit.quantityBefore, "10.0000");
      assert.equal(exit.quantityAfter, "7.0000");
      assert.equal(exit.historicalUnitCost, "2.5000");
      assert.equal(exit.historicalTotalCost, "7.50");
      assert.equal(exit.historicalUnitPrice, "4.5678");
      assert.equal(exit.historicalTotalPrice, "13.70");
      assert.equal(exit.customer?.id, customerId);
    });
    await check("histórico financeiro não muda quando o cadastro de valores muda", async () => {
      await fixture.query('UPDATE products SET acquisition_cost=9,sale_price=20,version=version+1,updated_at=now() WHERE id=$1', [mainId]);
      const historical = await get<StockMovementDTO>(administrator, `/api/stock/movements/${exit.id}`);
      assert.equal(historical.historicalUnitCost, "2.5000");
      assert.equal(historical.historicalUnitPrice, "4.5678");
      assert.equal((await get<StockProductDTO>(administrator, `/api/stock/products/${mainId}`)).acquisitionCost, "9.0000");
      const replayed = await movement(await operator.json("/api/stock/movements", entryRequest), 200);
      assert.equal(replayed.movement.id, entry.id);
    });
    await check("compensação que causaria saldo negativo é recusada integralmente", async () => {
      const before = await counts();
      const previous = await balance();
      assert.equal((await manager.json(`/api/stock/movements/${entry.id}/compensate`, { justification: "Entrada incorreta", idempotencyKey: randomUUID() })).status, 409);
      assert.deepEqual(await balance(), previous);
      assert.deepEqual(await counts(), before);
    });
    await check("operador não pode ajustar ou compensar", async () => {
      for (const type of ["POSITIVE_ADJUSTMENT", "NEGATIVE_ADJUSTMENT"] as const) assert.equal((await operator.json("/api/stock/movements", request(type))).status, 403);
      assert.equal((await operator.json(`/api/stock/movements/${exit.id}/compensate`, { justification: "Não autorizado", idempotencyKey: randomUUID() })).status, 403);
    });
    await check("ajustes e compensações exigem justificativa", async () => {
      assert.equal((await manager.json("/api/stock/movements", request("POSITIVE_ADJUSTMENT", mainId, { justification: "  " }))).status, 400);
      assert.equal((await manager.json(`/api/stock/movements/${exit.id}/compensate`, { justification: "", idempotencyKey: randomUUID() })).status, 400);
    });
    await check("gerente registra ajuste positivo e negativo com saldos e custo atual", async () => {
      const positive = await issue(manager, request("POSITIVE_ADJUSTMENT", mainId, { quantity: "2" }));
      assert.equal(positive.quantityBefore, "7.0000");
      assert.equal(positive.quantityAfter, "9.0000");
      assert.equal(positive.historicalUnitCost, "9.0000");
      assert.equal(positive.historicalTotalCost, "18.00");
      const negative = await issue(manager, request("NEGATIVE_ADJUSTMENT"));
      assert.equal(negative.quantityDelta, "-1.0000");
      assert.equal(negative.quantityAfter, "8.0000");
      assert.ok(negative.justification);
    });
    await check("saída e ajuste acima do disponível não alteram saldo, histórico ou auditoria", async () => {
      const before = await counts();
      const previous = await balance();
      assert.equal((await operator.json("/api/stock/movements", request("EXIT", mainId, { quantity: "9" }))).status, 409);
      assert.equal((await manager.json("/api/stock/movements", request("NEGATIVE_ADJUSTMENT", mainId, { quantity: "9" }))).status, 409);
      assert.deepEqual(await balance(), previous);
      assert.deepEqual(await counts(), before);
    });
    await check("falha de auditoria reverte movimento e saldo da mesma transação", async () => {
      const before = await counts();
      const previous = await balance(raceId);
      // This fault exists only inside the random database owned by this run.
      await fixture.query("CREATE FUNCTION integration_reject_stock_audit() RETURNS trigger LANGUAGE plpgsql AS $body$ BEGIN IF NEW.module='STOCK' THEN RAISE EXCEPTION 'Controlled integration fault'; END IF; RETURN NEW; END; $body$");
      await fixture.query("CREATE TRIGGER integration_stock_audit_fault BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION integration_reject_stock_audit()");
      try {
        assert.equal((await operator.json("/api/stock/movements", request("ENTRY", raceId))).status, 503);
        assert.deepEqual(await balance(raceId), previous);
        assert.deepEqual(await counts(), before);
      } finally {
        await fixture.query("DROP TRIGGER integration_stock_audit_fault ON audit_events");
        await fixture.query("DROP FUNCTION integration_reject_stock_audit()");
      }
    });
    const compensationRequest = { justification: "Correção da saída confirmada", idempotencyKey: randomUUID() };
    await check("compensação inverte a saída e preserva valores históricos e referências", async () => {
      exitCompensation = (await movement(await manager.json(`/api/stock/movements/${exit.id}/compensate`, compensationRequest))).movement;
      assert.equal(exitCompensation.type, "COMPENSATION");
      assert.equal(exitCompensation.compensatesMovementId, exit.id);
      assert.equal(exitCompensation.quantityDelta, "3.0000");
      assert.equal(exitCompensation.quantityBefore, "8.0000");
      assert.equal(exitCompensation.quantityAfter, "11.0000");
      assert.equal(exitCompensation.historicalUnitCost, exit.historicalUnitCost);
      assert.equal(exitCompensation.historicalTotalCost, exit.historicalTotalCost);
      assert.equal(exitCompensation.historicalUnitPrice, exit.historicalUnitPrice);
      assert.equal(exitCompensation.historicalTotalPrice, exit.historicalTotalPrice);
      assert.equal(exitCompensation.customer?.id, customerId);
      assert.equal((await get<StockMovementDTO>(administrator, `/api/stock/movements/${exit.id}`)).compensationId, exitCompensation.id);
    });
    await check("compensação é idempotente e não aceita segunda correção ou cadeia", async () => {
      const before = await counts();
      const retry = await movement(await manager.json(`/api/stock/movements/${exit.id}/compensate`, compensationRequest), 200);
      assert.equal(retry.movement.id, exitCompensation.id);
      assert.equal((await manager.json(`/api/stock/movements/${exit.id}/compensate`, { ...compensationRequest, idempotencyKey: randomUUID() })).status, 409);
      assert.equal((await manager.json(`/api/stock/movements/${exitCompensation.id}/compensate`, { ...compensationRequest, idempotencyKey: randomUUID() })).status, 409);
      assert.deepEqual(await counts(), before);
    });
    await check("compensação permite corrigir produto e referências posteriormente inativos", async () => {
      await fixture.query('UPDATE products SET is_active=false,updated_at=now() WHERE id=$1', [mainId]);
      await fixture.query('UPDATE suppliers SET is_active=false,updated_at=now() WHERE id=$1', [supplierId]);
      await fixture.query('UPDATE customers SET is_active=false,updated_at=now() WHERE id=$1', [customerId]);
      try {
        const result = (await movement(await administrator.json(`/api/stock/movements/${entry.id}/compensate`, { justification: "Correção histórica após inativação", idempotencyKey: randomUUID() }))).movement;
        assert.equal(result.quantityDelta, "-10.0000");
        assert.equal(result.quantityAfter, "1.0000");
        assert.equal(result.historicalUnitCost, "1.2345");
        assert.equal(result.supplier?.id, supplierId);
        assert.equal((await get<StockProductDTO>(administrator, `/api/stock/products/${mainId}`)).isActive, false);
      } finally {
        await fixture.query('UPDATE suppliers SET is_active=true,updated_at=now() WHERE id=$1', [supplierId]);
        await fixture.query('UPDATE customers SET is_active=true,updated_at=now() WHERE id=$1', [customerId]);
      }
    });
    await check("fracionamento decimal não acumula erros binários e arredonda meio centavo para cima", async () => {
      await issue(operator, request("ENTRY", fractionId, { quantity: "0.1", unitCost: "0.01" }));
      await issue(operator, request("ENTRY", fractionId, { quantity: "0.2", unitCost: "0.01" }));
      assert.equal((await balance(fractionId)).quantity, "0.3000");
      const half = await issue(operator, request("ENTRY", fractionId, { quantity: "0.5", unitCost: "0.01" }));
      assert.equal(half.historicalTotalCost, "0.01");
      const smallest = await issue(operator, request("ENTRY", fractionId, { quantity: "0.0001", unitCost: "0.0001" }));
      assert.equal(smallest.quantityAfter, "0.8001");
      assert.equal(smallest.historicalTotalCost, "0.00");
    });
    await check("estouro do total financeiro é rejeitado antes de qualquer persistência", async () => {
      const before = await counts();
      assert.equal((await operator.json("/api/stock/movements", request("ENTRY", overflowId, { quantity: "10000000000000", unitCost: "10000" }))).status, 400);
      assert.equal((await balance(overflowId)).quantity, "0.0000");
      assert.deepEqual(await counts(), before);
    });
    await check("limite de saldo numeric é protegido sem arredondamento silencioso", async () => {
      await issue(operator, request("ENTRY", overflowId, { quantity: "99999999999999.9999", unitCost: "0" }));
      const before = await counts();
      assert.equal((await operator.json("/api/stock/movements", request("ENTRY", overflowId, { quantity: "0.0001", unitCost: "0" }))).status, 400);
      assert.equal((await balance(overflowId)).quantity, "99999999999999.9999");
      assert.deepEqual(await counts(), before);
    });
    await check("duas saídas concorrentes não produzem saldo negativo", async () => {
      await issue(operator, request("ENTRY", raceId, { quantity: "5" }));
      const responses = await Promise.all([operator, administrator].map((actor) => actor.json("/api/stock/movements", request("EXIT", raceId, { quantity: "4" }))));
      assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409]);
      assert.deepEqual(await balance(raceId), { quantity: "1.0000", version: 2 });
    });
    await check("saída permite consumir exatamente o último saldo", async () => {
      await issue(operator, request("EXIT", raceId));
      assert.equal((await balance(raceId)).quantity, "0.0000");
      assert.equal((await get<StockProductDTO>(administrator, `/api/stock/products/${raceId}`)).stockStatus, "empty");
    });
    let concurrentEntry!: StockMovementDTO;
    await check("duas confirmações simultâneas da mesma chave criam apenas uma movimentação", async () => {
      const input = request("ENTRY", keyRaceId, { quantity: "2" });
      const before = await counts();
      const responses = await Promise.all([operator.json("/api/stock/movements", input), operator.json("/api/stock/movements", input)]);
      assert.deepEqual(responses.map((response) => response.status).sort(), [200, 201]);
      const results = await Promise.all(responses.map((response) => response.json() as Promise<MovementResult>));
      assert.equal(results[0].movement.id, results[1].movement.id);
      concurrentEntry = results[0].movement;
      assert.equal((await balance(keyRaceId)).quantity, "2.0000");
      assert.equal((await counts()).movements, before.movements + 1);
      assert.equal((await counts()).audits, before.audits + 1);
    });
    await check("chave simultânea em produtos diferentes não duplica efeito", async () => {
      const key = randomUUID();
      const before = await counts();
      const responses = await Promise.all([raceId, keyRaceId].map((id) => operator.json("/api/stock/movements", request("ENTRY", id, { idempotencyKey: key }))));
      assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409]);
      assert.equal((await counts()).movements, before.movements + 1);
    });
    await check("duas compensações concorrentes do mesmo original têm um único efeito", async () => {
      const before = await counts();
      const responses = await Promise.all([administrator, manager].map((actor) => actor.json(`/api/stock/movements/${concurrentEntry.id}/compensate`, { justification: "Correção concorrente de teste", idempotencyKey: randomUUID() })));
      assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409]);
      assert.equal((await counts()).movements, before.movements + 1);
      assert.equal((await fixture.query('SELECT count(*)::int AS n FROM stock_movements WHERE compensates_movement_id=$1', [concurrentEntry.id])).rows[0].n, 1);
    });
    await check("pesquisa, filtros e paginação de saldos preservam resultados", async () => {
      const named = await get<StockBalances>(administrator, "/api/stock/balances?search=mov-001");
      assert.equal(named.total, 1);
      assert.equal(named.items[0].id, mainId);
      const barcode = await get<StockBalances>(administrator, "/api/stock/balances?search=0001234567890");
      assert.equal(barcode.items[0].id, mainId);
      assert.equal((await get<StockBalances>(administrator, "/api/stock/balances?status=inactive")).total, 2);
      assert.equal((await get<StockBalances>(administrator, `/api/stock/balances?categoryId=${otherCategoryId}`)).total, 2);
      const low = await get<StockBalances>(administrator, "/api/stock/balances?stock=low");
      assert.equal(low.items.some((item) => item.id === fractionId), true);
      assert.equal(low.items.every((item) => item.stockStatus === "low"), true);
      for (const status of ["empty", "normal"] as const) {
        const filtered = await get<StockBalances>(administrator, `/api/stock/balances?stock=${status}`);
        assert.equal(filtered.items.every((item) => item.stockStatus === status), true);
      }
      const first = await get<StockBalances>(administrator, "/api/stock/balances?page=1&pageSize=2");
      const second = await get<StockBalances>(administrator, "/api/stock/balances?page=2&pageSize=2");
      assert.equal(first.total, 6);
      assert.equal(first.totalPages, 3);
      assert.equal(new Set([...first.items, ...second.items].map((item) => item.id)).size, 4);
    });
    await check("estimativas financeiras do estoque usam filtro e valores atuais explícitos", async () => {
      const result = await get<StockBalances>(administrator, "/api/stock/balances?search=MOV-001");
      assert.equal(result.summary.products, 1);
      assert.equal(result.summary.estimatedCost, "9.00");
      assert.equal(result.summary.potentialSale, "20.00");
      assert.equal(result.summary.estimatedMargin, "11.00");
      assert.equal(result.items[0].estimatedCost, "9.00");
    });
    await check("histórico filtra produto, tipo e período e mantém detalhes", async () => {
      const history = await get<StockList<StockMovementDTO>>(administrator, `/api/stock/movements?productId=${mainId}&pageSize=100`);
      assert.equal(history.total, 6);
      assert.equal(history.items.every((item) => item.productId === mainId), true);
      const entries = await get<StockList<StockMovementDTO>>(administrator, "/api/stock/movements?type=ENTRY&pageSize=100");
      assert.equal(entries.items.every((item) => item.type === "ENTRY"), true);
      const old = await get<StockList<StockMovementDTO>>(administrator, `/api/stock/movements?productId=${mainId}&to=${encodeURIComponent(new Date(Date.now() - 3600000).toISOString())}`);
      assert.equal(old.total, 1);
      assert.equal(old.items[0].id, entry.id);
      const recent = await get<StockList<StockMovementDTO>>(administrator, `/api/stock/movements?productId=${mainId}&from=${encodeURIComponent(new Date(Date.now() - 3600000).toISOString())}`);
      assert.equal(recent.total, 5);
      assert.equal((await get<StockList<StockMovementDTO>>(administrator, "/api/stock/movements?search=MOV-001")).total, 6);
    });
    await check("consultas rejeitam filtros desconhecidos, repetidos e datas inválidas", async () => {
      for (const path of ["balances?page=0", "balances?pageSize=101", "balances?page=1&page=2", "balances?page=&page=2", "balances?page=&page=", "balances?unexpected=1", "balances?categoryId=invalid", "movements?page=&page=2", "movements?page=&page=", "movements?type=INVALID", "movements?from=not-a-date", "movements?from=2026-10-31T00:00:00Z&to=2026-10-30T00:00:00Z"]) assert.equal((await administrator.request(`/api/stock/${path}`)).status, 400);
      assert.equal((await get<StockBalances>(administrator, `/api/stock/balances?search=${encodeURIComponent("' OR 1=1 --")}`)).total, 0);
      assert.equal((await administrator.request(`/api/stock/movements/${randomUUID()}`)).status, 404);
    });
    await check("movimentações confirmadas não oferecem edição ou exclusão HTTP", async () => {
      for (const method of ["PATCH", "DELETE"]) assert.equal((await administrator.json(`/api/stock/movements/${entry.id}`, {}, method)).status, 405);
    });
    await check("PostgreSQL impede reescrita e exclusão do histórico confirmado", async () => {
      for (const query of ['UPDATE stock_movements SET notes=$2 WHERE id=$1', 'DELETE FROM stock_movements WHERE id=$1']) {
        let refused = false;
        try { await fixture.query(query, query.startsWith("UPDATE") ? [entry.id, "Alteração proibida"] : [entry.id]); }
        catch (error) { refused = typeof error === "object" && error !== null && "code" in error && error.code === "55000"; }
        assert.equal(refused, true);
      }
      assert.equal((await get<StockMovementDTO>(administrator, `/api/stock/movements/${entry.id}`)).notes, "Entrada de teste");
    });
    await check("leitura de estoque não concede permissão de escrita", async () => {
      await fixture.query('DELETE FROM role_permissions WHERE role_id=$1 AND permission_id=(SELECT id FROM permissions WHERE code=$2)', [roles.get("OPERATOR"), "stock.write"]);
      try {
        assert.equal((await operator.request("/api/stock/balances")).status, 200);
        assert.equal((await operator.json("/api/stock/movements", request("ENTRY", raceId))).status, 403);
        assert.equal((await operator.json("/api/stock/movements", entryRequest)).status, 403);
      } finally { await fixture.query('INSERT INTO role_permissions(role_id,permission_id) SELECT $1,id FROM permissions WHERE code=$2 ON CONFLICT DO NOTHING', [roles.get("OPERATOR"), "stock.write"]); }
    });
    await check("stock.read é exigido separadamente nas consultas", async () => {
      await fixture.query('DELETE FROM role_permissions WHERE role_id=$1 AND permission_id=(SELECT id FROM permissions WHERE code=$2)', [roles.get("OPERATOR"), "stock.read"]);
      try { assert.equal((await operator.request("/api/stock/balances")).status, 403); }
      finally { await fixture.query('INSERT INTO role_permissions(role_id,permission_id) SELECT $1,id FROM permissions WHERE code=$2 ON CONFLICT DO NOTHING', [roles.get("OPERATOR"), "stock.read"]); }
    });
    await check("mudança de perfil durante espera pelo lock impede ajuste", async () => {
      const input = request("POSITIVE_ADJUSTMENT", raceId);
      let transactionOpen = false;
      let pending: Promise<Response> | undefined;
      try {
        await fixture.query("BEGIN"); transactionOpen = true;
        await fixture.query("SELECT pg_advisory_xact_lock(2026103002)");
        pending = manager.json("/api/stock/movements", input);
        void pending.catch(() => {});
        await waitForAuthLock();
        await fixture.query('UPDATE users SET role_id=$2,updated_at=now() WHERE id=$1', [actors.MANAGER.id, roles.get("OPERATOR")]);
        await fixture.query("COMMIT"); transactionOpen = false;
        assert.equal((await pending).status, 403);
        assert.equal((await fixture.query('SELECT count(*)::int AS n FROM stock_movements WHERE idempotency_key=$1', [input.idempotencyKey])).rows[0].n, 0);
      } finally {
        if (transactionOpen) await fixture.query("ROLLBACK").catch(() => {});
        if (pending) await pending.catch(() => {});
      }
    });
    await check("revogação de sessão durante espera pelo lock impede lançamento", async () => {
      const input = request("ENTRY", raceId);
      let transactionOpen = false;
      let pending: Promise<Response> | undefined;
      try {
        await fixture.query("BEGIN"); transactionOpen = true;
        await fixture.query("SELECT pg_advisory_xact_lock(2026103002)");
        pending = operator.json("/api/stock/movements", input);
        void pending.catch(() => {});
        await waitForAuthLock();
        await fixture.query('UPDATE users SET session_version=session_version+1,updated_at=now() WHERE id=$1', [actors.OPERATOR.id]);
        await fixture.query('UPDATE login_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [actors.OPERATOR.id]);
        await fixture.query("COMMIT"); transactionOpen = false;
        assert.equal((await pending).status, 401);
        assert.equal((await fixture.query('SELECT count(*)::int AS n FROM stock_movements WHERE idempotency_key=$1', [input.idempotencyKey])).rows[0].n, 0);
      } finally {
        if (transactionOpen) await fixture.query("ROLLBACK").catch(() => {});
        if (pending) await pending.catch(() => {});
      }
    });
    await check("saldo, sequência, versões e razão de movimentações permanecem reconciliados", async () => {
      const mismatch = await fixture.query('SELECT count(*)::int AS n FROM stock_balances b WHERE b.quantity <> COALESCE((SELECT sum(m.quantity_delta) FROM stock_movements m WHERE m.product_id=b.product_id),0) OR b.version<>(SELECT count(*) FROM stock_movements m WHERE m.product_id=b.product_id)');
      assert.equal(mismatch.rows[0].n, 0);
      const invalid = await fixture.query('SELECT count(*)::int AS n FROM stock_movements WHERE quantity_before+quantity_delta<>quantity_after OR quantity_before<0 OR quantity_after<0');
      assert.equal(invalid.rows[0].n, 0);
      const chain = await fixture.query<{ product_id: string; timestamp: string; quantity_before: string; quantity_after: string }>('SELECT product_id,created_at::text AS timestamp,quantity_before::text,quantity_after::text FROM stock_movements ORDER BY product_id,created_at');
      const products = new Map<string, Map<string, typeof chain.rows>>();
      for (const row of chain.rows) {
        const groups = products.get(row.product_id) ?? new Map<string, typeof chain.rows>();
        const group = groups.get(row.timestamp) ?? [];
        group.push(row); groups.set(row.timestamp, group); products.set(row.product_id, groups);
      }
      for (const groups of products.values()) {
        let previous: typeof chain.rows | undefined;
        for (const group of groups.values()) {
          // JS timestamps can tie. UUIDv4 does not establish a causal order,
          // so compare adjacent snapshots only when both groups are unique.
          if (group.length === 1 && !previous) assert.equal(group[0].quantity_before, "0.0000");
          if (group.length === 1 && previous?.length === 1) assert.equal(group[0].quantity_before, previous[0].quantity_after);
          previous = group;
        }
      }
    });
    await check("auditoria identifica cada operação sem senhas, tokens ou credenciais", async () => {
      const rows = await fixture.query("SELECT action,module,entity_id,operation_id,actor_id,previous_values,new_values FROM audit_events WHERE module='STOCK'");
      const stored = await fixture.query('SELECT id,operation_id FROM stock_movements');
      assert.equal(rows.rows.length, stored.rows.length);
      assert.equal(stored.rows.every((record) => rows.rows.some((audit) => audit.entity_id === record.id && audit.operation_id === record.operation_id)), true);
      assert.equal(rows.rows.every((row) => Object.values(actors).some((actor) => actor.id === row.actor_id)), true);
      const serialized = JSON.stringify(rows.rows);
      assert.doesNotMatch(serialized, /passwordHash|password_hash|tokenHash|token_hash|access_token|refresh_token|request_hash/);
      assert.equal(serialized.includes(password), false);
    });
    console.info(`${checked} verificações de estoque aprovadas em banco e servidor descartáveis: HTTP, permissões, decimais, históricos, compensações, idempotência, auditoria e concorrência.`);
  } catch (error) {
    // Assertion/driver details may contain private data. Emit only a fixed case
    // label and primitive numeric/boolean status differences.
    console.error(`Integração de estoque interrompida em: ${currentCheck}. Dados sensíveis foram omitidos.`);
    if (error instanceof assert.AssertionError && ["number", "boolean"].includes(typeof error.actual) && ["number", "boolean"].includes(typeof error.expected)) console.error(`Resultado recebido: ${String(error.actual)}; esperado: ${String(error.expected)}.`);
    for (const diagnostic of diagnostics) console.error(diagnostic);
    process.exitCode = 1;
  } finally {
    await stopServer(server);
    if (connectedFixture) await fixture.end().catch(() => {});
    if (created) {
      const result = await admin.query("SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=$1", [databaseName]).catch(() => null);
      if (result?.rows[0]?.marker === marker && /^prevision_stock_test_[0-9a-f]{12}$/.test(databaseName)) {
        await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`).catch(() => { console.error("Não foi possível remover o banco descartável criado por esta execução."); process.exitCode = 1; });
      } else { console.error("Marcador do banco descartável divergente; limpeza interrompida."); process.exitCode = 1; }
    }
    await admin.end().catch(() => {});
  }
}

integration().catch(() => {
  console.error("Não foi possível preparar a integração local de estoque. Verifique o banco local, a porta 3012 e o build; segredos foram omitidos.");
  process.exitCode = 1;
});
