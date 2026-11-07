import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "pg";
import { config } from "dotenv";
import ExcelJS from "exceljs";
import type { AnalysisDTO } from "../../src/lib/analyses/types.ts";
import type { ReportPreviewDTO } from "../../src/lib/transfers/types.ts";
import { assertDatabaseIdentity, assertLocalDevelopmentDatabase, readEnvironment } from "../../src/server/config/environment.ts";
import { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS } from "../../src/server/authorization/permissions.ts";
import { hashPassword } from "../../src/server/security/password.ts";
import { fixed, movementTotal, scaled4 } from "../../src/server/stock/calculations.ts";

config({ path: ".env", quiet: true });
const port = 3020; const base = `http://127.0.0.1:${port}`;
class Browser {
  cookies = new Map<string, string>();
  async request(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    if (this.cookies.size) headers.set("cookie", [...this.cookies].map(([key, value]) => `${key}=${value}`).join("; "));
    const response = await fetch(new URL(path, base), { ...init, headers, redirect: "manual", signal: AbortSignal.timeout(45000) });
    for (const entry of response.headers.getSetCookie()) {
      const [pair, ...attributes] = entry.split(";"); const separator = pair.indexOf("="); const name = pair.slice(0, separator); const value = pair.slice(separator + 1);
      if (!value || attributes.some((part) => /^\s*max-age=0$/iu.test(part))) this.cookies.delete(name); else this.cookies.set(name, value);
    }
    return response;
  }
  async json(path: string, body: unknown, method = "POST") {
    await this.request("/login");
    return this.request(path, { method, headers: { "Content-Type": "application/json", Origin: base, "X-Prevision-CSRF": this.cookies.get("prevision.csrf") ?? "" }, body: JSON.stringify(body) });
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
const addDays = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
const filters = { from: "2026-10-01", to: "2026-10-30", thresholdA: "80.00", thresholdB: "95.00", horizonDays: "30", status: "all" };
interface FixtureProduct { id: string; sku: string; quantity: string }
async function integration() {
  const source = readEnvironment(); assertLocalDevelopmentDatabase(source); assert.ok(source.DIRECT_URL);
  assert.equal(new URL(source.DATABASE_URL).host, new URL(source.DIRECT_URL).host); await freePort();
  const suffix = randomBytes(6).toString("hex"); const databaseName = `prevision_analyses_test_${suffix}`;
  assert.match(databaseName, /^prevision_analyses_test_[0-9a-f]{12}$/u); const marker = `prevision-analyses-integration-${randomUUID()}`;
  const adminUrl = new URL(source.DIRECT_URL); const runtimeUrl = new URL(source.DATABASE_URL); adminUrl.pathname = runtimeUrl.pathname = `/${databaseName}`;
  const admin = new Client({ connectionString: source.DIRECT_URL, connectionTimeoutMillis: 5000 });
  const fixture = new Client({ connectionString: adminUrl.href, connectionTimeoutMillis: 5000 });
  const password = `Analyses-${randomBytes(20).toString("hex")}`;
  const actors = Object.fromEntries(["ADMINISTRATOR", "MANAGER", "OPERATOR"].map((role) => [role, { id: randomUUID(), email: `analyses.${role.toLowerCase()}.${suffix}@example.invalid`, browser: new Browser() }]));
  const administrator = actors.ADMINISTRATOR.browser; const operator = actors.OPERATOR.browser; const manager = actors.MANAGER.browser; const anonymous = new Browser();
  const roles = new Map<string, string>(); const categoryId = randomUUID(); const supplierId = randomUUID();
  const products = new Map<string, FixtureProduct>();
  let created = false; let connected = false; let server: ChildProcess | undefined; let checked = 0; let currentCheck = "preparo do banco descartável";
  const check = async (name: string, work: () => unknown | Promise<unknown>) => { currentCheck = name; await work(); checked++; };
  const analyses = (search = "", extra: Record<string, string> = {}, browser = administrator) => browser.request(`/api/analyses?${new URLSearchParams({ ...filters, search, ...extra })}`).then((value) => response<AnalysisDTO>(value));
  const forecast = async (sku: string, extra: Record<string, string> = {}) => {
    const data = await analyses(sku, extra); const item = data.replenishment.products.find((row) => row.sku === sku); assert.ok(item); return { data, item };
  };
  const makeProduct = async (sku: string, options: { unit?: string; cost?: string; minimum?: string; safety?: string; lead?: number | null; supplier?: boolean; active?: boolean; createdAt?: string } = {}) => {
    const product = { id: randomUUID(), sku, quantity: "0.0000" }; products.set(sku, product);
    const createdAt = options.createdAt ?? "2026-09-01T03:00:00Z"; const cost = options.cost ?? "999.0000";
    await fixture.query('INSERT INTO products(id,sku,name,category_id,unit_of_measure,acquisition_cost,sale_price,is_active,minimum_stock,safety_stock,replenishment_lead_time_days,default_supplier_id,created_at,updated_at) VALUES($1,$2,$2,$3,$4,$5,$5,$6,$7,$8,$9,$10,$11,$11)', [product.id, sku, categoryId, options.unit ?? "UN", cost, options.active ?? true, options.minimum ?? "0.0000", options.safety ?? "0.0000", options.lead ?? null, options.supplier ? supplierId : null, createdAt]);
    await fixture.query('INSERT INTO stock_balances(product_id,quantity,updated_at) VALUES($1,0,now())', [product.id]);
    for (const type of ["ACQUISITION_COST", "SALE_PRICE"]) await fixture.query('INSERT INTO product_value_history(id,product_id,type,new_value,changed_by_id,operation_id,effective_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$7)', [randomUUID(), product.id, type, cost, actors.ADMINISTRATOR.id, randomUUID(), createdAt]);
    return product;
  };
  const movement = async (product: FixtureProduct, type: "ENTRY" | "EXIT" | "COMPENSATION", delta: string, occurredAt: string, cost = "1.0000", compensatesId: string | null = null) => {
    const id = randomUUID(); const after = fixed(scaled4(product.quantity) + scaled4(delta), 4); const absolute = delta.replace(/^-/, "");
    await fixture.query(`INSERT INTO stock_movements(id,product_id,type,quantity_delta,quantity_before,quantity_after,historical_unit_cost,historical_total_cost,historical_unit_price,historical_total_price,performed_by_id,occurred_at,created_at,operation_id,idempotency_key,justification,compensates_movement_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,$13,$14,$15,$16)`, [id, product.id, type, delta, product.quantity, after, cost, movementTotal(absolute, cost), type === "EXIT" || type === "COMPENSATION" ? cost : null, type === "EXIT" || type === "COMPENSATION" ? movementTotal(absolute, cost) : null, actors.ADMINISTRATOR.id, occurredAt, randomUUID(), `analyses-fixture:${id}`, type === "COMPENSATION" ? "Compensação descartável de conferência" : null, compensatesId]);
    await fixture.query('UPDATE stock_balances SET quantity=$2,version=version+1,updated_at=now() WHERE product_id=$1', [product.id, after]); product.quantity = after; return id;
  };
  const consumption = async (sku: string, amount: string, cost = "1.0000") => {
    const product = await makeProduct(sku); await movement(product, "ENTRY", "100.0000", "2026-09-30T13:00:00Z", cost); await movement(product, "EXIT", `-${amount}`, "2026-10-05T13:00:00Z", cost); return product;
  };
  const forecastProduct = async (sku: string, options: Parameters<typeof makeProduct>[1] = {}) => {
    const product = await makeProduct(sku, { minimum: "30.0000", safety: "10.0000", lead: 5, ...options });
    await movement(product, "ENTRY", "110.0000", options.createdAt ? "2026-10-15T13:00:00Z" : "2026-09-30T13:00:00Z", "2.0000");
    await movement(product, "EXIT", "-30.0000", options.createdAt ? "2026-10-20T13:00:00Z" : "2026-10-05T13:00:00Z", "2.0000");
    await movement(product, "EXIT", "-30.0000", "2026-10-25T13:00:00Z", "2.0000"); return product;
  };
  const snapshot = async (kind: "abc" | "replenishment", search: string, browser = administrator) => response<ReportPreviewDTO>(await browser.json("/api/transfers/exports/preview", { kind, filters: { ...filters, search } }), 201);
  const download = (id: string, format: "xlsx" | "pdf", browser = administrator) => browser.request(`/api/transfers/exports/${id}/download?format=${format}`);
  try {
    await admin.connect(); const identity = await admin.query('SELECT environment,database_id AS "databaseId" FROM environment_sentinel WHERE id=$1', ["primary"]); assertDatabaseIdentity(source, identity.rows[0] ?? null);
    await admin.query(`CREATE DATABASE "${databaseName}"`); created = true; await admin.query(`COMMENT ON DATABASE "${databaseName}" IS '${marker}'`);
    await fixture.connect(); connected = true;
    for (const name of (await readdir(resolve("prisma", "migrations"))).filter((name) => /^\d+_/.test(name)).sort()) await fixture.query(await readFile(resolve("prisma", "migrations", name, "migration.sql"), "utf8"));
    await fixture.query('INSERT INTO environment_sentinel(id,environment,database_id) VALUES($1,$2,$3)', ["primary", "test", marker]);
    for (const role of Object.keys(actors)) { const id = randomUUID(); roles.set(role, id); await fixture.query('INSERT INTO roles(id,code,name,updated_at) VALUES($1,$2,$3,now())', [id, role, role]); }
    for (const code of PERMISSIONS) {
      const id = randomUUID(); await fixture.query('INSERT INTO permissions(id,code) VALUES($1,$2)', [id, code]);
      for (const [role, defaults] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) if ((defaults as readonly string[]).includes(code)) await fixture.query('INSERT INTO role_permissions(role_id,permission_id) SELECT $1,$2', [roles.get(role), id]);
    }
    const hash = await hashPassword(password);
    for (const [role, actor] of Object.entries(actors)) await fixture.query('INSERT INTO users(id,name,email,password_hash,role_id,updated_at) VALUES($1,$2,$3,$4,$5,now())', [actor.id, `Conferência ${role}`, actor.email, hash, roles.get(role)]);
    await fixture.query('INSERT INTO categories(id,name,updated_at) VALUES($1,$2,now())', [categoryId, "Análises descartáveis"]);
    await fixture.query('INSERT INTO suppliers(id,name,replenishment_lead_time_days,updated_at) VALUES($1,$2,$3,now())', [supplierId, "Fornecedor de conferência", 5]);
    currentCheck = "fixtures de Curva ABC e previsão";
    for (const [sku, amount] of [["ABC-A", "80.0000"], ["ABC-B", "15.0000"], ["ABC-C", "5.0000"]]) await consumption(sku, amount);
    await makeProduct("ABC-ZERO"); await consumption("ABC-FREE", "5.0000", "0.0000");
    for (const suffix of ["A", "B", "C", "D"]) await consumption(`TIE-${suffix}`, "25.0000");
    for (const [sku, amount] of [["DOM-A", "97.0000"], ["DOM-B", "2.0000"], ["DOM-C", "1.0000"]]) await consumption(sku, amount);
    await forecastProduct("FC-BASIC"); await forecastProduct("FC-SUPPLIER", { lead: null, supplier: true }); await forecastProduct("FC-ZERO-LEAD", { lead: 0, supplier: true });
    await forecastProduct("FC-MISSING", { lead: null }); await forecastProduct("FC-RECENT", { createdAt: "2026-10-15T03:00:00Z" });
    await forecastProduct("FC-INACTIVE", { active: false }); const changed = await forecastProduct("FC-UNIT", { unit: "KG" });
    await fixture.query('INSERT INTO audit_events(id,actor_id,action,module,entity_type,entity_id,operation_id,previous_values,new_values,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [randomUUID(), actors.ADMINISTRATOR.id, "UPDATE", "PRODUCTS", "Product", changed.id, randomUUID(), { unitOfMeasure: "UN" }, { unitOfMeasure: "KG" }, "2026-11-02T13:00:00Z"]);
    const noExit = await makeProduct("FC-NONE", { lead: 5, minimum: "100.0000" }); await movement(noExit, "ENTRY", "50.0000", "2026-09-30T13:00:00Z");
    const oneExit = await makeProduct("FC-ONE", { lead: 5 }); await movement(oneExit, "ENTRY", "110.0000", "2026-09-30T13:00:00Z"); await movement(oneExit, "EXIT", "-60.0000", "2026-10-05T13:00:00Z", "2.0000");
    await forecastProduct("FC-MINIMUM", { lead: 0, minimum: "100.0000", safety: "0.0000" });
    const fractional = await makeProduct("FC-FRACTION", { cost: "0.0000", lead: 1 }); await movement(fractional, "ENTRY", "0.0002", "2026-09-30T13:00:00Z", "0.0000"); await movement(fractional, "EXIT", "-0.0001", "2026-10-05T13:00:00Z", "0.0000"); await movement(fractional, "EXIT", "-0.0001", "2026-10-20T13:00:00Z", "0.0000");
    const huge = await makeProduct("FC-HUGE", { lead: 1 }); await movement(huge, "ENTRY", "99999999999999.9999", "2026-09-30T13:00:00Z", "0.0001"); await movement(huge, "EXIT", "-0.0001", "2026-10-05T13:00:00Z"); await movement(huge, "EXIT", "-0.0001", "2026-10-20T13:00:00Z");
    const reversal = await makeProduct("REV-OUTSIDE", { lead: 5 }); await movement(reversal, "ENTRY", "20.0000", "2026-09-20T13:00:00Z", "2.0000"); const oldExit = await movement(reversal, "EXIT", "-10.0000", "2026-09-29T13:00:00Z", "2.0000"); await movement(reversal, "COMPENSATION", "10.0000", "2026-10-05T13:00:00Z", "2.0000", oldExit);
    const net = await makeProduct("NET-COMP", { lead: 5 }); await movement(net, "ENTRY", "100.0000", "2026-09-30T13:00:00Z", "2.0000"); const firstExit = await movement(net, "EXIT", "-20.0000", "2026-10-05T13:00:00Z", "2.0000"); await movement(net, "EXIT", "-20.0000", "2026-10-20T13:00:00Z", "2.0000"); await movement(net, "COMPENSATION", "20.0000", "2026-10-25T13:00:00Z", "2.0000", firstExit);
    const tz = await makeProduct("TZ-CUTOFF"); await movement(tz, "ENTRY", "100.0000", "2026-09-30T13:00:00Z"); await movement(tz, "EXIT", "-1.0000", "2026-10-10T02:59:59.999Z", "2.0000"); await movement(tz, "EXIT", "-2.0000", "2026-10-10T03:00:00Z", "2.0000");
    currentCheck = "inicialização do servidor isolado";
    server = spawn(process.execPath, [resolve("node_modules", "next", "dist", "bin", "next"), "start", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: process.cwd(), windowsHide: true, stdio: "ignore", env: { ...process.env, NODE_ENV: "production", APP_ENV: "test", DATABASE_ID: marker, DATABASE_URL: runtimeUrl.href, DIRECT_URL: adminUrl.href, AUTH_SECRET: randomBytes(48).toString("hex"), AUTH_URL: base, MAIL_TRANSPORT: "local", GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "", VERCEL: "", REQUEST_IP_HEADER: "", NEXT_TELEMETRY_DISABLED: "1" }
    });
    let ready = false; let startupError = false; server.once("error", () => { startupError = true; });
    for (let attempt = 0; attempt < 80; attempt++) { if (startupError || server.exitCode !== null) break; try { ready = (await fetch(base + "/api/health", { signal: AbortSignal.timeout(1000) })).ok; } catch { /* owned child startup */ } if (ready) break; await delay(250); }
    assert.ok(ready, "O servidor isolado precisa de build atualizado.");
    await check("consulta e exportação exigem autenticação", async () => { const denied = await anonymous.request("/api/analyses"); assert.equal(denied.status, 401); assert.equal(denied.headers.get("cache-control"), "no-store"); });
    await check("perfis autorizados entram e consultam as análises", async () => { for (const actor of Object.values(actors)) assert.equal(await actor.browser.login(actor.email, password), true); await analyses("ABC-", {}, operator); });
    const abc = await analyses("ABC-");
    await check("ABC usa custos históricos, percentuais e limiares exatos", async () => {
      assert.equal(abc.abc.totalConsumptionCost, "100.00"); const positive = abc.abc.products.filter((row) => row.classification !== null);
      assert.deepEqual(positive.map((row) => [row.sku, row.consumptionCost, row.share, row.cumulativeShare, row.classification]), [["ABC-A", "80.00", "80.00", "80.00", "A"], ["ABC-B", "15.00", "15.00", "95.00", "B"], ["ABC-C", "5.00", "5.00", "100.00", "C"]]);
      assert.ok(abc.abc.products.filter((row) => ["ABC-FREE", "ABC-ZERO"].includes(row.sku)).every((row) => row.classification === null && row.consumptionCost === "0.00"));
    });
    await check("critérios configuráveis mudam a classificação sem alterar o consumo", async () => { const custom = await analyses("ABC-", { thresholdA: "50", thresholdB: "99" }); assert.equal(custom.abc.totalConsumptionCost, "100.00"); assert.equal(custom.abc.products.find((row) => row.sku === "ABC-C")?.classification, "B"); assert.equal(custom.filters.thresholdA, "50.00"); });
    await check("empates financeiros recebem a mesma classe e produto dominante começa em A", async () => { const ties = await analyses("TIE-"); assert.ok(ties.abc.products.every((row) => row.classification === "A" && row.share === "25.00")); const dominant = await analyses("DOM-"); assert.equal(dominant.abc.products[0].share, "97.00"); assert.equal(dominant.abc.products[0].classification, "A"); });
    await check("compensações usam seu próprio período e consumo negativo é sinalizado", async () => { const reversed = await analyses("REV-"); const row = reversed.abc.products[0]; assert.equal(row.grossExitCost, "0.00"); assert.equal(row.reversedExitCost, "20.00"); assert.equal(row.consumptionCost, "0.00"); assert.equal(row.netQuantity, "0.0000"); assert.equal(row.clamped, true); assert.equal(row.classification, null); const net = await analyses("NET-"); assert.equal(net.abc.products[0].consumptionCost, "40.00"); assert.equal(net.replenishment.products[0].averageDaily, "0.66666667"); });
    await check("previsão utiliza razão exata, saldo atual, prazo, mínimo e segurança", async () => {
      const { data, item } = await forecast("FC-BASIC"); assert.equal(item.quantity, "50.0000"); assert.equal(item.observedDays, 30); assert.equal(item.positiveExitDays, 2); assert.equal(item.averageDaily, "2.00000000"); assert.equal(item.daysUntilStockout, "25.00"); assert.equal(item.reorderPoint, "30.0000"); assert.equal(item.recommendedQuantity, "30.0000"); assert.equal(item.estimatedStockoutDate, addDays(data.asOfDate, 25)); assert.equal(item.estimatedReorderDate, addDays(data.asOfDate, 10)); assert.equal(item.status, "OK");
    });
    await check("prazo do produto prevalece e zero é válido; fornecedor oferece fallback", async () => { const fallback = (await forecast("FC-SUPPLIER")).item; assert.equal(fallback.leadTimeDays, 5); assert.equal(fallback.leadTimeSource, "supplier"); assert.equal(fallback.recommendedQuantity, "30.0000"); const zero = (await forecast("FC-ZERO-LEAD")).item; assert.equal(zero.leadTimeDays, 0); assert.equal(zero.leadTimeSource, "product"); assert.equal(zero.recommendedQuantity, "20.0000"); });
    await check("ausência de prazo não inventa recomendação ou data de compra", async () => { const item = (await forecast("FC-MISSING")).item; assert.equal(item.status, "MISSING_LEAD_TIME"); assert.equal(item.averageDaily, "2.00000000"); assert.equal(item.daysUntilStockout, "25.00"); assert.equal(item.recommendedQuantity, null); assert.equal(item.estimatedReorderDate, null); });
    await check("histórico recente ou com um único dia de saída não gera estimativa", async () => { const recent = (await forecast("FC-RECENT")).item; assert.equal(recent.observedDays, 16); assert.equal(recent.status, "INSUFFICIENT_HISTORY"); assert.equal(recent.averageDaily, null); const one = (await forecast("FC-ONE")).item; assert.equal(one.positiveExitDays, 1); assert.equal(one.status, "INSUFFICIENT_HISTORY"); assert.equal(one.recommendedQuantity, null); });
    await check("sem consumo mantém lacuna de mínimo sem produzir datas fictícias", async () => { const item = (await forecast("FC-NONE")).item; assert.equal(item.status, "NO_CONSUMPTION"); assert.equal(item.minimumGap, "50.0000"); assert.equal(item.averageDaily, null); assert.equal(item.estimatedStockoutDate, null); assert.equal(item.recommendedQuantity, null); });
    await check("produto inativo e unidade alterada não recebem previsão", async () => { assert.equal((await forecast("FC-INACTIVE")).item.status, "INACTIVE"); const data = await analyses("FC-UNIT"); assert.equal(data.replenishment.products[0].status, "UNIT_CHANGED"); assert.equal(data.replenishment.products[0].averageDaily, null); assert.equal(data.abc.products[0].unitChanged, true); assert.equal(data.abc.products[0].netQuantity, null); assert.equal(data.abc.products[0].consumptionCost, "120.00"); });
    await check("mínimo prevalece e quantidades minúsculas são arredondadas para cima", async () => { const minimum = (await forecast("FC-MINIMUM", { horizonDays: "1" })).item; assert.equal(minimum.reorderPoint, "100.0000"); assert.equal(minimum.recommendedQuantity, "50.0000"); assert.equal(minimum.status, "REORDER"); const small = await forecast("FC-FRACTION", { horizonDays: "1" }); assert.equal(small.item.recommendedQuantity, "0.0001"); assert.equal(small.item.reorderPoint, "0.0001"); assert.equal(small.item.estimatedReorderDate, small.data.asOfDate); });
    await check("cobertura enorme conserva precisão e limita datas sem overflow", async () => { const item = (await forecast("FC-HUGE")).item; assert.equal(item.quantity, "99999999999999.9997"); assert.equal(item.averageDaily, "0.00000667"); assert.equal(item.daysUntilStockout, "14999999999999999955.00"); assert.equal(item.dateLimited, true); assert.equal(item.estimatedStockoutDate, null); assert.equal(item.estimatedReorderDate, null); });
    await check("corte diário usa o calendário de São Paulo", async () => { const ninth = await analyses("TZ-", { from: "2026-10-09", to: "2026-10-09" }); const tenth = await analyses("TZ-", { from: "2026-10-10", to: "2026-10-10" }); assert.equal(ninth.abc.totalConsumptionCost, "2.00"); assert.equal(tenth.abc.totalConsumptionCost, "4.00"); assert.equal(tenth.criteria.timeZone, "America/Sao_Paulo"); });
    await check("pesquisa literal, situação e resultado vazio preservam o universo consultado", async () => { const literal = await analyses("%"); assert.equal(literal.abc.products.length, 0); assert.equal(literal.abc.totalConsumptionCost, "0.00"); const inactive = await analyses("FC-", { status: "inactive" }); assert.equal(inactive.abc.products.length, 1); assert.equal(inactive.abc.products[0].sku, "FC-INACTIVE"); });
    await check("filtros incompletos, limiares inválidos e períodos futuros são recusados", async () => { for (const query of ["from=2026-10-01", "from=2026-02-30&to=2026-03-01", "from=2026-10-30&to=2026-10-01", "from=2026-10-01&from=2026-10-02&to=2026-10-30", "from=2024-01-01&to=2026-01-01", "from=2999-01-01&to=2999-01-02", "thresholdA=95&thresholdB=80", "thresholdA=0", "thresholdB=100", "horizonDays=0", "stock=unknown"]) assert.equal((await administrator.request(`/api/analyses?${query}`)).status, 400); });
    await check("padrão e página de análises apresentam critérios sem gravar operações", async () => { const defaults = await response<AnalysisDTO>(await administrator.request("/api/analyses")); assert.equal(defaults.criteria.periodDays, 90); assert.equal(defaults.criteria.minimumHistoryDays, 30); assert.equal(defaults.criteria.minimumPositiveExitDays, 2); const page = await administrator.request("/analises"); assert.equal(page.status, 200); const html = await page.text(); assert.ok(html.includes("ABC")); assert.ok(html.includes("/estoque")); });
    const abcSnapshot = await snapshot("abc", "ABC-"); const forecastSnapshot = await snapshot("replenishment", "FC-");
    const indicatorSnapshot = await response<ReportPreviewDTO>(await administrator.json("/api/transfers/exports/preview", { kind: "indicators", filters: { from: filters.from, to: filters.to } }), 201);
    await check("indicadores compartilham os dados do dashboard e a prévia privada", async () => {
      const dashboard = await response<{ current: { products: number; estimatedCost: string }; period: { from: string; to: string } }>(await administrator.request(`/api/dashboard?${new URLSearchParams({ from: filters.from, to: filters.to })}`));
      assert.equal(indicatorSnapshot.kind, "indicators");
      assert.equal(indicatorSnapshot.rows.find((row) => row.metric === "Produtos cadastrados")?.value, String(dashboard.current.products));
      assert.equal(indicatorSnapshot.rows.find((row) => row.metric === "Custo estimado")?.value, dashboard.current.estimatedCost);
      assert.deepEqual(indicatorSnapshot.filters, { from: filters.from, to: filters.to });
      assert.equal((await manager.request(`/api/transfers/exports/${indicatorSnapshot.id}`)).status, 404);
    });
    await check("exportação congela os resultados e critérios e permanece privada", async () => {
      assert.equal(abcSnapshot.kind, "abc"); assert.equal(abcSnapshot.filters.thresholdA, "80.00"); assert.equal(abcSnapshot.rowCount, abc.abc.products.length);
      assert.ok(abcSnapshot.rows.some((row) => row.sku === "ABC-A")); assert.ok(forecastSnapshot.rows.some((row) => row.sku === "FC-MISSING"));
      assert.equal((await manager.request(`/api/transfers/exports/${abcSnapshot.id}`)).status, 404);
      const saved = structuredClone(abcSnapshot.rows);
      await fixture.query('UPDATE products SET name=$2,version=version+1,updated_at=now() WHERE id=$1', [products.get("ABC-A")!.id, "NOME POSTERIOR À PRÉVIA"]);
      const reread = await response<ReportPreviewDTO>(await administrator.request(`/api/transfers/exports/${abcSnapshot.id}`));
      assert.deepEqual(reread.rows, saved);
    });
    await check("Excel e PDF reais preservam os snapshots de ABC, reposição e indicadores", async () => {
      for (const report of [abcSnapshot, forecastSnapshot, indicatorSnapshot]) {
        const xlsx = await download(report.id, "xlsx"); assert.equal(xlsx.status, 200); assert.equal(xlsx.headers.get("cache-control"), "no-store"); const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(await xlsx.arrayBuffer()); const sheet = workbook.getWorksheet("Dados")!; assert.equal(sheet.rowCount, report.rowCount + 1);
        sheet.eachRow((row) => row.eachCell((cell) => { if (cell.value !== null) assert.equal(cell.type, ExcelJS.ValueType.String); }));
        const pdf = await download(report.id, "pdf"); assert.equal(pdf.status, 200); assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), "%PDF-");
      }
    });
    await check("consulta não altera produtos, movimentos ou preferências", async () => { const statement = 'SELECT (SELECT count(*)::int FROM products) AS products,(SELECT count(*)::int FROM stock_movements) AS movements,(SELECT count(*)::int FROM audit_events) AS audits,(SELECT count(*)::int FROM user_preferences) AS preferences'; const before = (await fixture.query(statement)).rows[0]; await analyses("ABC-"); const after = (await fixture.query(statement)).rows[0]; assert.deepEqual(after, before); });
    const operatorSnapshot = await snapshot("abc", "ABC-", operator);
    await check("revogar cada permissão bloqueia análise e exportação já preparada", async () => {
      for (const permission of ["reports.read", "stock.read"]) {
        await fixture.query('DELETE FROM role_permissions WHERE role_id=$1 AND permission_id=(SELECT id FROM permissions WHERE code=$2)', [roles.get("OPERATOR"), permission]);
        const denied = await operator.request("/api/analyses"); assert.equal(denied.status, 403); assert.equal(denied.headers.get("cache-control"), "no-store"); assert.equal((await denied.text()).includes("ABC-A"), false); assert.equal((await download(operatorSnapshot.id, "xlsx", operator)).status, 403);
        await fixture.query('INSERT INTO role_permissions(role_id,permission_id) SELECT $1,id FROM permissions WHERE code=$2', [roles.get("OPERATOR"), permission]);
      }
    });
    await check("coorte acima do limite é recusada sem classificar uma amostra", async () => { await fixture.query("INSERT INTO products(id,sku,name,category_id,created_at,updated_at) SELECT gen_random_uuid(),'LIMIT-'||i::text,'LIMIT-'||i::text,$1,now(),now() FROM generate_series(1,1001) i", [categoryId]); await fixture.query("INSERT INTO stock_balances(product_id,quantity,updated_at) SELECT id,0,now() FROM products WHERE sku LIKE 'LIMIT-%'"); assert.equal((await administrator.request(`/api/analyses?${new URLSearchParams({ ...filters, search: "LIMIT-" })}`)).status, 400); });
    await check("sessão revogada não consulta nem exporta análises", async () => { await fixture.query('UPDATE users SET session_version=session_version+1,updated_at=now() WHERE id=$1', [actors.OPERATOR.id]); assert.equal((await operator.request("/api/analyses")).status, 401); assert.equal((await download(operatorSnapshot.id, "pdf", operator)).status, 401); });
    console.info(`${checked} verificações de análises avançadas aprovadas em banco e servidor descartáveis: ABC, consumo, previsão, critérios, precisão, exportações e permissões.`);
  } catch (error) {
    console.error(`Integração de análises interrompida em: ${currentCheck}. Dados privados foram omitidos.`);
    if (error instanceof Error) {
      const position = /analyses-integration\.ts:(\d+):(\d+)/u.exec(error.stack ?? "");
      if (position) console.error(`Local da verificação: linha ${position[1]}, coluna ${position[2]}.`);
    }
    if (error instanceof assert.AssertionError && ["number", "boolean"].includes(typeof error.actual) && ["number", "boolean"].includes(typeof error.expected)) console.error(`Resultado recebido: ${String(error.actual)}; esperado: ${String(error.expected)}.`);
    process.exitCode = 1;
  } finally {
    await stopServer(server); if (connected) await fixture.end().catch(() => {});
    if (created) {
      const result = await admin.query("SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=$1", [databaseName]).catch(() => null);
      if (result?.rows[0]?.marker === marker && /^prevision_analyses_test_[0-9a-f]{12}$/u.test(databaseName)) await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`).catch(() => { console.error("Não foi possível remover o banco descartável desta execução."); process.exitCode = 1; });
      else { console.error("Marcador divergente; limpeza interrompida."); process.exitCode = 1; }
    }
    await admin.end().catch(() => {});
  }
}
integration().catch(() => { console.error("Não foi possível preparar a integração de análises. Confira banco local, porta 3020 e build; detalhes privados omitidos."); process.exitCode = 1; });
