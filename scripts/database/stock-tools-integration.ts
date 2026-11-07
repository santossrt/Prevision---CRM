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
import type { StockAlertsList, StockAlertSummary } from "../../src/lib/stock/alerts-types.ts";

config({ path: ".env", quiet: true });

const port = 3013;
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
  const databaseName = `prevision_stock_tools_test_${suffix}`;
  assert.match(databaseName, /^prevision_stock_tools_test_[0-9a-f]{12}$/);
  const marker = `prevision-stock-tools-${randomUUID()}`;
  const adminUrl = new URL(source.DIRECT_URL);
  const runtimeUrl = new URL(source.DATABASE_URL);
  adminUrl.pathname = runtimeUrl.pathname = `/${databaseName}`;
  const admin = new Client({ connectionString: source.DIRECT_URL, connectionTimeoutMillis: 5000 });
  const fixture = new Client({ connectionString: adminUrl.href, connectionTimeoutMillis: 5000 });
  const password = `Stock-tools-${randomBytes(20).toString("hex")}`;
  const actors = {
    ADMINISTRATOR: { id: randomUUID(), email: `tools.admin.${suffix}@example.invalid`, browser: new Browser() },
    OPERATOR: { id: randomUUID(), email: `tools.operator.${suffix}@example.invalid`, browser: new Browser() }
  };
  const administrator = actors.ADMINISTRATOR.browser;
  const operator = actors.OPERATOR.browser;
  const anonymous = new Browser();
  const categoryId = randomUUID();
  const otherCategoryId = randomUUID();
  const supplierId = randomUUID();
  const mainId = randomUUID();
  const alphaId = randomUUID();
  const inactiveId = randomUUID();
  const legacyId = randomUUID();
  const raceId = randomUUID();
  const roles = new Map<string, string>();
  let created = false;
  let connectedFixture = false;
  let server: ChildProcess | undefined;
  let checked = 0;
  let currentCheck = "preparo do banco descartável";
  let initialEntry: ReturnType<typeof request> | undefined;

  async function check(name: string, work: () => unknown | Promise<unknown>) {
    currentCheck = name;
    await work();
    checked++;
  }
  function request(type: CreateMovementInput["type"], quantity: string, productId: string = mainId) {
    return { type, productId, quantity, occurredAt: new Date().toISOString(), idempotencyKey: randomUUID(),
      ...(type === "ENTRY" ? { unitCost: "1.0000", supplierId }
        : type === "EXIT" ? { unitPrice: "2.0000" } : { justification: "Ajuste no banco descartável" }) };
  }
  const issue = async (input: ReturnType<typeof request>) => (await movement(await administrator.json("/api/stock/movements", input))).movement;
  const alert = async (productId: string = mainId) => (await fixture.query<{ productId: string; kind: string; opened: string; changed: string; resolved: string | null }>(
    'SELECT product_id AS "productId",kind,opened_at::text AS opened,changed_at::text AS changed,resolved_at::text AS resolved FROM stock_alerts WHERE product_id=$1', [productId]
  )).rows[0] ?? null;
  const stock = async (productId: string = mainId) => (await fixture.query('SELECT quantity::text FROM stock_balances WHERE product_id=$1', [productId])).rows[0].quantity as string;
  async function product(response: Response, expected: number) {
    assert.equal(response.status, expected);
    const body = await response.json() as { item: { id: string; version: number; sku: string } };
    assert.ok(body.item?.id);
    return body.item;
  }
  async function edit(productId: string, fields: Record<string, unknown>) {
    const current = await product(await administrator.request(`/api/catalog/products/${productId}`), 200);
    return product(await administrator.json(`/api/catalog/products/${productId}`, { expectedVersion: current.version, ...fields }, "PATCH"), 200);
  }
  async function waitForProductLock() {
    for (let attempt = 0; attempt < 80; attempt++) {
      const waiting = await admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1 AND state='active' AND wait_event_type='Lock' AND wait_event='advisory'", [databaseName]);
      if (waiting.rows[0].n) return;
      await delay(25);
    }
    assert.fail("A sincronização não aguardou o lock de produto controlado.");
  }

  try {
    await admin.connect();
    const identity = await admin.query('SELECT environment,database_id AS "databaseId" FROM environment_sentinel WHERE id=$1', ["primary"]);
    assertDatabaseIdentity(source, identity.rows[0] ?? null);
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    await admin.query(`COMMENT ON DATABASE "${databaseName}" IS '${marker}'`);
    await fixture.connect(); connectedFixture = true;
    let legacySeeded = false;
    for (const name of (await readdir(resolve("prisma", "migrations"))).filter((name) => /^\d+_/.test(name)).sort()) {
      if (name === "202610310007_stock_alerts") {
        await fixture.query('INSERT INTO categories(id,name,updated_at) VALUES($1,$2,now())', [categoryId, "Categoria de alertas"]);
        await fixture.query('INSERT INTO products(id,name,sku,barcode,category_id,updated_at) VALUES($1,$2,$3,$4,$5,now())', [legacyId, "Produto legado", "TOOLS-LEGACY", "0001112223334", categoryId]);
        await fixture.query('INSERT INTO stock_balances(product_id,updated_at) VALUES($1,now())', [legacyId]);
        legacySeeded = true;
      }
      await fixture.query(await readFile(resolve("prisma", "migrations", name, "migration.sql"), "utf8"));
    }
    assert.equal(legacySeeded, true);
    await fixture.query('INSERT INTO environment_sentinel(id,environment,database_id) VALUES($1,$2,$3)', ["primary", "test", marker]);
    for (const code of Object.keys(DEFAULT_ROLE_PERMISSIONS)) {
      const id = randomUUID(); roles.set(code, id);
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
    for (const [role, actor] of Object.entries(actors)) await fixture.query('INSERT INTO users(id,name,email,password_hash,role_id,updated_at) VALUES($1,$2,$3,$4,$5,now())', [actor.id, "Ferramentas de teste", actor.email, hash, roles.get(role)]);
    await fixture.query('INSERT INTO categories(id,name,updated_at) VALUES($1,$2,now())', [otherCategoryId, "Outra categoria"]);
    await fixture.query('INSERT INTO suppliers(id,name,updated_at) VALUES($1,$2,now())', [supplierId, "Fornecedor descartável"]);
    for (const [id, sku, barcode, active, minimum, quantity, category] of [
      [mainId, "TOOLS-001", "0001234567890", true, "3", "0", categoryId],
      [alphaId, "TOOLS-ALPHA", "AbC-01", true, "0", "0", otherCategoryId],
      [inactiveId, "TOOLS-INACTIVE", "0007778889990", false, "3", "0", categoryId],
      [raceId, "TOOLS-RACE", null, true, "2", "6", otherCategoryId]
    ]) {
      await fixture.query('INSERT INTO products(id,name,sku,barcode,is_active,category_id,minimum_stock,acquisition_cost,sale_price,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,1,2,now())', [id, `Produto ${sku}`, sku, barcode, active, category, minimum]);
      await fixture.query('INSERT INTO stock_balances(product_id,quantity,updated_at) VALUES($1,$2,now())', [id, quantity]);
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
    let startupError = false; server.once("error", () => { startupError = true; });
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      if (startupError || server.exitCode !== null) break;
      try { ready = (await fetch(base + "/api/health", { signal: AbortSignal.timeout(1000) })).ok; } catch { /* Wait only for our child. */ }
      if (ready) break;
      await delay(250);
    }
    assert.ok(ready, "O servidor isolado precisa de um build atualizado.");

    await check("consultas de código e alertas exigem sessão", async () => {
      for (const path of ["/api/stock/barcode?code=0001234567890", "/api/stock/alerts", "/api/stock/alerts/summary"]) assert.equal((await anonymous.request(path)).status, 401);
    });
    await check("login de administrador e operador", async () => {
      for (const actor of Object.values(actors)) assert.equal(await actor.browser.login(actor.email, password), true);
    });
    await check("migration inicializa alerta de produto legado sem movimentar estoque", async () => {
      assert.equal((await alert(legacyId))?.kind, "EMPTY");
      assert.equal(await stock(legacyId), "0.0000");
      assert.equal((await fixture.query('SELECT count(*)::int AS n FROM stock_movements')).rows[0].n, 0);
    });
    await check("código exato preserva zeros e devolve o contrato do produto", async () => {
      const found = await get<StockProductDTO>(operator, "/api/stock/barcode?code=0001234567890");
      assert.equal(found.id, mainId); assert.equal(found.barcode, "0001234567890");
      assert.equal(found.quantity, "0.0000"); assert.equal(found.isActive, true);
    });
    await check("lookup não confunde código com SKU, parcial ou número sem zeros", async () => {
      for (const code of ["1234567890", "000123", "TOOLS-001", "inexistente"]) assert.equal((await operator.request(`/api/stock/barcode?${new URLSearchParams({ code })}`)).status, 404);
    });
    await check("códigos alfanuméricos preservam maiúsculas e minúsculas", async () => {
      assert.equal((await get<StockProductDTO>(operator, "/api/stock/barcode?code=AbC-01")).id, alphaId);
      assert.equal((await operator.request("/api/stock/barcode?code=abc-01")).status, 404);
    });
    await check("produto inativo é identificado sem autorizar nova movimentação", async () => {
      const inactive = await get<StockProductDTO>(operator, "/api/stock/barcode?code=0007778889990");
      assert.equal(inactive.id, inactiveId); assert.equal(inactive.isActive, false);
      assert.equal((await administrator.json("/api/stock/movements", request("ENTRY", "1", inactiveId))).status, 400);
    });
    await check("lookup valida código, campos desconhecidos e parâmetros repetidos", async () => {
      for (const query of ["", "code=", "code=%00", "code=a%20b", "code=a&code=b", "code=&code=a", "code=a&unknown=1"]) assert.equal((await operator.request(`/api/stock/barcode?${query}`)).status, 400);
    });
    await check("consulta autorizada não depende de catalog.read", async () => {
      await fixture.query('DELETE FROM role_permissions WHERE role_id=$1 AND permission_id IN (SELECT id FROM permissions WHERE code=$2)', [roles.get("OPERATOR"), "catalog.read"]);
      try {
        assert.equal((await operator.request("/api/catalog/products")).status, 403);
        assert.equal((await get<StockProductDTO>(operator, "/api/stock/barcode?code=AbC-01")).id, alphaId);
        assert.equal((await get<StockAlertSummary>(operator, "/api/stock/alerts/summary")).total, 3);
      } finally { await fixture.query('INSERT INTO role_permissions(role_id,permission_id) SELECT $1,id FROM permissions WHERE code=$2', [roles.get("OPERATOR"), "catalog.read"]); }
    });
    await check("resumo e lista distinguem estoque vazio e baixo sem incluir inativos", async () => {
      assert.deepEqual(await get<StockAlertSummary>(operator, "/api/stock/alerts/summary"), { empty: 3, low: 0, total: 3 });
      const result = await get<StockAlertsList>(operator, "/api/stock/alerts?pageSize=2");
      assert.equal(result.total, 3); assert.equal(result.items.length, 2); assert.equal(result.totalPages, 2);
      assert.equal(result.items.some((item) => item.productId === inactiveId), false);
      assert.equal(await alert(inactiveId), null);
    });
    await check("filtros da lista não alteram o resumo global", async () => {
      const result = await get<StockAlertsList>(operator, `/api/stock/alerts?kind=EMPTY&categoryId=${otherCategoryId}&search=ALPHA`);
      assert.equal(result.total, 1); assert.equal(result.items[0].productId, alphaId);
      assert.deepEqual(result.summary, { empty: 3, low: 0, total: 3 });
      assert.equal((await get<StockAlertsList>(operator, "/api/stock/alerts?kind=LOW")).total, 0);
    });
    await check("consulta de alertas rejeita filtros inválidos e repetidos", async () => {
      for (const query of ["kind=normal", "categoryId=invalid", "page=0", "pageSize=101", "page=1&page=2", "page=&page=2", "page=&page=", "unknown=1"]) assert.equal((await operator.request(`/api/stock/alerts?${query}`)).status, 400);
    });
    await check("cadastro cria saldo zero e seu alerta na mesma operação", async () => {
      const createdProduct = await product(await administrator.json("/api/catalog/products", { name: "Produto criado pela API", sku: "TOOLS-NEW", barcode: "0009990009990", categoryId, minimumStock: "0" }), 201);
      assert.equal((await alert(createdProduct.id))?.kind, "EMPTY");
      assert.equal((await get<StockProductDTO>(operator, "/api/stock/barcode?code=0009990009990")).id, createdProduct.id);
    });
    await check("cadastro rejeita código duplicado sem criar produto ou alerta extra", async () => {
      const before = (await fixture.query('SELECT count(*)::int AS n FROM stock_alerts')).rows[0].n;
      assert.equal((await administrator.json("/api/catalog/products", { name: "Código duplicado", sku: "TOOLS-DUP", barcode: "0001234567890", categoryId })).status, 409);
      assert.equal((await fixture.query('SELECT count(*)::int AS n FROM stock_alerts')).rows[0].n, before);
    });
    await check("entrada no mínimo exato muda EMPTY para LOW", async () => {
      initialEntry = request("ENTRY", "3"); await issue(initialEntry);
      assert.equal(await stock(), "3.0000"); assert.equal((await alert())?.kind, "LOW");
      const result = await get<StockAlertsList>(operator, "/api/stock/alerts?kind=LOW");
      assert.equal(result.items.some((item) => item.productId === mainId && item.quantity === "3.0000" && item.minimumStock === "3.0000"), true);
    });
    await check("movimentações na mesma faixa atualizam quantidade sem duplicar aviso", async () => {
      const before = await alert(); await issue(request("EXIT", "1"));
      assert.deepEqual(await alert(), before);
      assert.equal((await get<StockAlertsList>(operator, "/api/stock/alerts?search=TOOLS-001")).items[0].quantity, "2.0000");
      assert.equal((await fixture.query('SELECT count(*)::int AS n FROM stock_alerts WHERE product_id=$1', [mainId])).rows[0].n, 1);
    });
    await check("replay da entrada não modifica alerta nem saldo", async () => {
      assert.ok(initialEntry);
      const before = await alert();
      await movement(await administrator.json("/api/stock/movements", initialEntry), 200);
      assert.deepEqual(await alert(), before); assert.equal(await stock(), "2.0000");
    });
    await check("saída do último saldo muda LOW para EMPTY", async () => {
      const before = await alert(); await issue(request("EXIT", "2"));
      const current = await alert(); assert.equal(current?.kind, "EMPTY"); assert.equal(current?.resolved, null);
      assert.notEqual(current?.changed, before?.changed);
    });
    await check("mínimo zero mantém aviso de produto vazio sem novo timestamp", async () => {
      const before = await alert(); await edit(mainId, { minimumStock: "0" });
      assert.deepEqual(await alert(), before);
    });
    await check("reposição acima do mínimo resolve o aviso e o remove da lista", async () => {
      await issue(request("ENTRY", "3")); assert.notEqual((await alert())?.resolved, null);
      assert.equal((await get<StockAlertsList>(operator, "/api/stock/alerts?search=TOOLS-001")).total, 0);
    });
    await check("alterar mínimo resolve e reabre a mesma linha de alerta", async () => {
      const before = await alert();
      await edit(mainId, { minimumStock: "3" }); assert.equal((await alert())?.kind, "LOW"); assert.equal((await alert())?.resolved, null);
      assert.notEqual((await alert())?.opened, before?.opened);
      await edit(mainId, { minimumStock: "2" }); assert.notEqual((await alert())?.resolved, null);
      await edit(mainId, { minimumStock: "3" }); assert.equal((await alert())?.resolved, null);
      assert.equal((await fixture.query('SELECT count(*)::int AS n FROM stock_alerts WHERE product_id=$1', [mainId])).rows[0].n, 1);
    });
    await check("inativação resolve e reativação reabre uma condição ainda baixa", async () => {
      await edit(mainId, { isActive: false }); assert.notEqual((await alert())?.resolved, null);
      assert.equal((await get<StockAlertsList>(operator, "/api/stock/alerts?search=TOOLS-001")).total, 0);
      await edit(mainId, { isActive: true }); assert.equal((await alert())?.resolved, null); assert.equal((await alert())?.kind, "LOW");
    });
    await check("compensação atualiza alertas com o efeito inverso do estoque", async () => {
      const entry = await issue(request("ENTRY", "2")); assert.notEqual((await alert())?.resolved, null);
      await movement(await administrator.json(`/api/stock/movements/${entry.id}/compensate`, { justification: "Correção da entrada", idempotencyKey: randomUUID() }));
      assert.equal(await stock(), "3.0000"); assert.equal((await alert())?.kind, "LOW"); assert.equal((await alert())?.resolved, null);
    });
    await check("ajustes positivos e negativos sincronizam a condição", async () => {
      const before = await alert(); await issue(request("NEGATIVE_ADJUSTMENT", "1")); assert.deepEqual(await alert(), before);
      await issue(request("POSITIVE_ADJUSTMENT", "2")); assert.equal(await stock(), "4.0000"); assert.notEqual((await alert())?.resolved, null);
    });
    await check("falha da auditoria reverte movimento, saldo e transição do alerta", async () => {
      const before = await alert(); const quantity = await stock(); const input = request("EXIT", "2");
      await fixture.query("CREATE FUNCTION integration_reject_tools_audit() RETURNS trigger LANGUAGE plpgsql AS $body$ BEGIN IF NEW.module='STOCK' THEN RAISE EXCEPTION 'Controlled test fault'; END IF; RETURN NEW; END; $body$");
      await fixture.query("CREATE TRIGGER integration_reject_tools_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION integration_reject_tools_audit()");
      try {
        assert.equal((await administrator.json("/api/stock/movements", input)).status, 503);
        assert.deepEqual(await alert(), before); assert.equal(await stock(), quantity);
        assert.equal((await fixture.query('SELECT count(*)::int AS n FROM stock_movements WHERE idempotency_key=$1', [input.idempotencyKey])).rows[0].n, 0);
      } finally {
        await fixture.query("DROP TRIGGER integration_reject_tools_audit ON audit_events");
        await fixture.query("DROP FUNCTION integration_reject_tools_audit()");
      }
    });
    await check("tentativa recusada por saldo insuficiente não altera aviso", async () => {
      const before = await alert(); assert.equal((await administrator.json("/api/stock/movements", request("EXIT", "999"))).status, 409);
      assert.deepEqual(await alert(), before);
    });
    await check("duas confirmações da mesma chave não duplicam estoque ou alerta", async () => {
      const input = request("ENTRY", "1"); const before = await alert();
      const responses = await Promise.all([administrator.json("/api/stock/movements", input), administrator.json("/api/stock/movements", input)]);
      assert.deepEqual(responses.map((response) => response.status).sort(), [200, 201]);
      assert.equal(await stock(), "5.0000"); assert.deepEqual(await alert(), before);
    });
    await check("saídas concorrentes deixam um único alerta no estado final", async () => {
      await Promise.all([issue(request("EXIT", "1")), issue(request("EXIT", "1"))]);
      assert.equal(await stock(), "3.0000"); assert.equal((await alert())?.kind, "LOW"); assert.equal((await alert())?.resolved, null);
      assert.equal((await fixture.query('SELECT count(*)::int AS n FROM stock_alerts WHERE product_id=$1', [mainId])).rows[0].n, 1);
    });
    await check("limites fracionários são comparados sem perda de precisão", async () => {
      const fraction = await product(await administrator.json("/api/catalog/products", { name: "Produto fracionado", sku: "TOOLS-FRACTION", categoryId, minimumStock: "0.0002" }), 201);
      await issue(request("ENTRY", "0.0002", fraction.id)); assert.equal((await alert(fraction.id))?.kind, "LOW");
      const before = await alert(fraction.id); await issue(request("EXIT", "0.0001", fraction.id)); assert.deepEqual(await alert(fraction.id), before);
      await issue(request("ENTRY", "0.0002", fraction.id)); assert.notEqual((await alert(fraction.id))?.resolved, null);
    });
    await check("atualizações cruzadas de mínimo e quantidade preservam condição final", async () => {
      const concurrent = new Client({ connectionString: adminUrl.href, connectionTimeoutMillis: 5000 });
      await concurrent.connect(); let transactionOpen = false; let pending: Promise<unknown> | undefined;
      try {
        await fixture.query("BEGIN"); transactionOpen = true;
        await fixture.query('UPDATE products SET minimum_stock=10,updated_at=now() WHERE id=$1', [raceId]);
        pending = concurrent.query('UPDATE stock_balances SET quantity=11,updated_at=now() WHERE product_id=$1', [raceId]); void pending.catch(() => {});
        await waitForProductLock(); await fixture.query("COMMIT"); transactionOpen = false; await pending; pending = undefined;
        assert.notEqual((await alert(raceId))?.resolved, null);
        await fixture.query("BEGIN"); transactionOpen = true;
        await fixture.query('UPDATE stock_balances SET quantity=9,updated_at=now() WHERE product_id=$1', [raceId]);
        pending = concurrent.query('UPDATE products SET minimum_stock=2,updated_at=now() WHERE id=$1', [raceId]); void pending.catch(() => {});
        await waitForProductLock(); await fixture.query("COMMIT"); transactionOpen = false; await pending; pending = undefined;
        assert.notEqual((await alert(raceId))?.resolved, null);
      } finally {
        if (transactionOpen) await fixture.query("ROLLBACK").catch(() => {});
        if (pending) await pending.catch(() => {});
        await concurrent.end();
      }
    });
    await check("stock.read é exigida para código, alertas e resumo", async () => {
      await fixture.query('DELETE FROM role_permissions WHERE role_id=$1 AND permission_id IN (SELECT id FROM permissions WHERE code=$2)', [roles.get("OPERATOR"), "stock.read"]);
      try {
        for (const path of ["/api/stock/barcode?code=AbC-01", "/api/stock/alerts", "/api/stock/alerts/summary"]) assert.equal((await operator.request(path)).status, 403);
      } finally { await fixture.query('INSERT INTO role_permissions(role_id,permission_id) SELECT $1,id FROM permissions WHERE code=$2', [roles.get("OPERATOR"), "stock.read"]); }
    });
    await check("resumo corresponde aos estados reais sem linhas duplicadas ou obsoletas", async () => {
      const expected = await fixture.query("SELECT count(*) FILTER (WHERE b.quantity=0)::int AS empty,count(*) FILTER (WHERE b.quantity>0 AND b.quantity<=p.minimum_stock)::int AS low,count(*)::int AS total FROM products p JOIN stock_balances b ON b.product_id=p.id WHERE p.is_active AND (b.quantity=0 OR b.quantity<=p.minimum_stock)");
      assert.deepEqual(await get<StockAlertSummary>(operator, "/api/stock/alerts/summary"), expected.rows[0]);
      const mismatch = await fixture.query("SELECT count(*)::int AS n FROM products p JOIN stock_balances b ON b.product_id=p.id LEFT JOIN stock_alerts a ON a.product_id=p.id WHERE (p.is_active AND (b.quantity=0 OR b.quantity<=p.minimum_stock)) IS DISTINCT FROM (a.product_id IS NOT NULL AND a.resolved_at IS NULL)");
      assert.equal(mismatch.rows[0].n, 0);
    });
    await check("DTO de alertas não expõe dados privados ou configuração", async () => {
      const response = await get<StockAlertsList>(operator, "/api/stock/alerts?pageSize=100");
      for (const item of response.items) assert.deepEqual(Object.keys(item).sort(), ["productId", "name", "sku", "barcode", "unitOfMeasure", "quantity", "minimumStock", "kind", "openedAt", "changedAt"].sort());
      const serialized = JSON.stringify(response);
      assert.doesNotMatch(serialized, /passwordHash|password_hash|tokenHash|token_hash|AUTH_SECRET|DATABASE_URL/);
      assert.equal(serialized.includes(password), false);
    });
    console.info(`${checked} verificações de código de barras e alertas aprovadas em banco e servidor descartáveis: lookup exato, permissões, sincronização, deduplicação, rollback e concorrência.`);
  } catch (error) {
    console.error(`Integração de código e alertas interrompida em: ${currentCheck}. Dados sensíveis foram omitidos.`);
    if (error instanceof assert.AssertionError && ["number", "boolean"].includes(typeof error.actual) && ["number", "boolean"].includes(typeof error.expected)) console.error(`Resultado recebido: ${String(error.actual)}; esperado: ${String(error.expected)}.`);
    for (const diagnostic of diagnostics) console.error(diagnostic);
    process.exitCode = 1;
  } finally {
    await stopServer(server);
    if (connectedFixture) await fixture.end().catch(() => {});
    if (created) {
      const resource = await admin.query("SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=$1", [databaseName]).catch(() => null);
      if (resource?.rows[0]?.marker === marker && /^prevision_stock_tools_test_[0-9a-f]{12}$/.test(databaseName)) {
        await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`).catch(() => { console.error("Não foi possível remover o banco descartável criado por esta execução."); process.exitCode = 1; });
      } else { console.error("Marcador divergente; limpeza do banco descartável interrompida."); process.exitCode = 1; }
    }
    await admin.end().catch(() => {});
  }
}

integration().catch(() => {
  console.error("Não foi possível preparar a integração local de código e alertas. Verifique o banco, a porta 3013 e o build; segredos foram omitidos.");
  process.exitCode = 1;
});


