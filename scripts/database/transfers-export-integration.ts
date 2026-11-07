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
import type { ReportKind, ReportPreviewDTO } from "../../src/lib/transfers/types.ts";
import type { ProductDTO } from "../../src/lib/catalog/types.ts";
import type { InventoryMutationResult } from "../../src/lib/inventory/types.ts";
import { assertDatabaseIdentity, assertLocalDevelopmentDatabase, readEnvironment } from "../../src/server/config/environment.ts";
import { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS } from "../../src/server/authorization/permissions.ts";
import { hashPassword } from "../../src/server/security/password.ts";

config({ path: ".env", quiet: true });
const port = 3017; const base = `http://127.0.0.1:${port}`;
class Browser {
  cookies = new Map<string, string>();
  async request(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    if (this.cookies.size) headers.set("cookie", [...this.cookies].map(([key, value]) => `${key}=${value}`).join("; "));
    const response = await fetch(new URL(path, base), { ...init, headers, redirect: "manual", signal: AbortSignal.timeout(30000) });
    for (const entry of response.headers.getSetCookie()) {
      const [pair, ...attributes] = entry.split(";"); const index = pair.indexOf("="); const name = pair.slice(0, index); const value = pair.slice(index + 1);
      if (!value || attributes.some((part) => /^\s*max-age=0$/i.test(part))) this.cookies.delete(name); else this.cookies.set(name, value);
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
async function integration() {
  const source = readEnvironment(); assertLocalDevelopmentDatabase(source); assert.ok(source.DIRECT_URL);
  assert.equal(new URL(source.DIRECT_URL).host, new URL(source.DATABASE_URL).host); await freePort();
  const suffix = randomBytes(6).toString("hex"); const databaseName = `prevision_exports_test_${suffix}`;
  assert.match(databaseName, /^prevision_exports_test_[0-9a-f]{12}$/);
  const marker = `prevision-exports-integration-${randomUUID()}`;
  const adminUrl = new URL(source.DIRECT_URL); const runtimeUrl = new URL(source.DATABASE_URL); adminUrl.pathname = runtimeUrl.pathname = `/${databaseName}`;
  const admin = new Client({ connectionString: source.DIRECT_URL, connectionTimeoutMillis: 5000 });
  const fixture = new Client({ connectionString: adminUrl.href, connectionTimeoutMillis: 5000 });
  const password = `Exports-integration-${randomBytes(20).toString("hex")}`;
  const actors = {
    ADMINISTRATOR: { id: randomUUID(), email: `exports.admin.${suffix}@example.invalid`, browser: new Browser() },
    MANAGER: { id: randomUUID(), email: `exports.manager.${suffix}@example.invalid`, browser: new Browser() },
    OPERATOR: { id: randomUUID(), email: `exports.operator.${suffix}@example.invalid`, browser: new Browser() }
  };
  const administrator = actors.ADMINISTRATOR.browser; const operator = actors.OPERATOR.browser; const manager = actors.MANAGER.browser; const anonymous = new Browser();
  const roles = new Map<string, string>();
  const categoryId = randomUUID(); const supplierId = randomUUID(); const privacyId = randomUUID();
  let created = false; let connected = false; let server: ChildProcess | undefined; let checked = 0; let currentCheck = "preparo do banco descartável";
  const check = async (name: string, work: () => unknown | Promise<unknown>) => { currentCheck = name; await work(); checked++; };
  const preview = async (kind: ReportKind, filters: Record<string, string> = {}, browser = administrator) => response<ReportPreviewDTO>(await browser.json("/api/transfers/exports/preview", { kind, filters }), 201);
  const download = (id: string, format: string, browser = administrator) => browser.request(`/api/transfers/exports/${id}/download?format=${format}`);
  const product = async (name: string, sku: string, barcode: string | null, minimumStock = "0.0000") => (await response<{ item: ProductDTO }>(await administrator.json("/api/catalog/products", { name, sku, barcode, categoryId, defaultSupplierId: supplierId, minimumStock, acquisitionCost: "2.3456", salePrice: "5.1234" }), 201)).item;
  const movement = async (type: "ENTRY" | "EXIT", productId: string, quantity: string) => response<{ movement: { id: string }; replayed: boolean }>(await administrator.json("/api/stock/movements", { type, productId, quantity, occurredAt: new Date(Date.now() - 3600000).toISOString(), idempotencyKey: randomUUID(), ...(type === "ENTRY" ? { supplierId, unitCost: "1.2345" } : { unitPrice: "9.8765" }) }), 201);
  try {
    await admin.connect(); const identity = await admin.query('SELECT environment,database_id AS "databaseId" FROM environment_sentinel WHERE id=$1', ["primary"]); assertDatabaseIdentity(source, identity.rows[0] ?? null);
    await admin.query(`CREATE DATABASE "${databaseName}"`); created = true;
    await admin.query(`COMMENT ON DATABASE "${databaseName}" IS '${marker}'`); await fixture.connect(); connected = true;
    for (const name of (await readdir(resolve("prisma", "migrations"))).filter((name) => /^\d+_/.test(name)).sort()) await fixture.query(await readFile(resolve("prisma", "migrations", name, "migration.sql"), "utf8"));
    await fixture.query('INSERT INTO environment_sentinel(id,environment,database_id) VALUES($1,$2,$3)', ["primary", "test", marker]);
    for (const role of Object.keys(actors)) { const id = randomUUID(); roles.set(role, id); await fixture.query('INSERT INTO roles(id,code,name,updated_at) VALUES($1,$2,$3,now())', [id, role, role]); }
    for (const code of PERMISSIONS) {
      const id = randomUUID(); await fixture.query('INSERT INTO permissions(id,code) VALUES($1,$2)', [id, code]);
      for (const [role, defaults] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) if ((defaults as readonly string[]).includes(code)) await fixture.query('INSERT INTO role_permissions(role_id,permission_id) VALUES($1,$2)', [roles.get(role), id]);
    }
    const hash = await hashPassword(password);
    for (const [role, actor] of Object.entries(actors)) await fixture.query('INSERT INTO users(id,name,email,password_hash,role_id,updated_at) VALUES($1,$2,$3,$4,$5,now())', [actor.id, `Responsável ${role}`, actor.email, hash, roles.get(role)]);
    await fixture.query('INSERT INTO categories(id,name,updated_at) VALUES($1,$2,now())', [categoryId, "Categoria de exportação"]);
    await fixture.query('INSERT INTO suppliers(id,name,updated_at) VALUES($1,$2,now())', [supplierId, "Fornecedor de exportação"]);
    currentCheck = "inicialização do servidor isolado";
    server = spawn(process.execPath, [resolve("node_modules", "next", "dist", "bin", "next"), "start", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: process.cwd(), windowsHide: true, stdio: "ignore", env: { ...process.env, NODE_ENV: "production", APP_ENV: "test", DATABASE_ID: marker, DATABASE_URL: runtimeUrl.href, DIRECT_URL: adminUrl.href, AUTH_SECRET: randomBytes(48).toString("hex"), AUTH_URL: base, MAIL_TRANSPORT: "local", GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "", VERCEL: "", REQUEST_IP_HEADER: "", NEXT_TELEMETRY_DISABLED: "1" }
    });
    let ready = false; let startupError = false; server.once("error", () => { startupError = true; });
    for (let attempt = 0; attempt < 80; attempt++) {
      if (startupError || server.exitCode !== null) break;
      try { ready = (await fetch(base + "/api/health", { signal: AbortSignal.timeout(1000) })).ok; } catch { /* own child startup */ }
      if (ready) break; await delay(250);
    }
    assert.ok(ready, "O servidor isolado precisa de build atualizado.");
    await check("consultas e downloads exigem autenticação", async () => { assert.equal((await anonymous.request(`/api/transfers/exports/${privacyId}`)).status, 401); assert.equal((await download(privacyId, "pdf", anonymous)).status, 401); });
    await check("login dos perfis locais de teste", async () => { for (const actor of Object.values(actors)) assert.equal(await actor.browser.login(actor.email, password), true); });
    await check("prévia exige CSRF e rejeita origem adulterada", async () => {
      assert.equal((await administrator.request("/api/transfers/exports/preview", { method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: JSON.stringify({ kind: "products", filters: {} }) })).status, 403);
    });
    const first = await product('=HYPERLINK("https://example.invalid")', "EXPORT-A", "00001234567890", "5.0000");
    const low = await product("Café, Açúcar e Óleo", "EXPORT-B", "AbC0001", "2.0000");
    const empty = await product("Produto sem estoque", "EXPORT-C", "00000003");
    const exact = await product("Precisão máxima", "EXPORT-D", "00000004");
    const entry = await movement("ENTRY", first.id, "10.1250"); await movement("EXIT", first.id, "1.0000"); await movement("ENTRY", low.id, "2.0000"); await movement("ENTRY", exact.id, "99999999999999.9999");
    await fixture.query('INSERT INTO audit_events(id,actor_id,action,module,entity_type,entity_id,operation_id,origin,previous_values,new_values) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [privacyId, actors.ADMINISTRATOR.id, "UPDATE", "USERS", "FixturePrivacy", privacyId, randomUUID(), "https://bad.invalid?token=PRIVATE_ORIGIN_VALUE", { name: "Nome permitido", passwordHash: "PRIVATE_PASSWORD_VALUE", token: "PRIVATE_TOKEN_VALUE", category: { secret: "PRIVATE_NESTED_VALUE", name: "Categoria permitida" } }, { isActive: true }]);
    let catalog!: ReportPreviewDTO;
    await check("prévia de produtos usa dados reais e textos exatos", async () => {
      catalog = await preview("products"); assert.equal(catalog.rowCount, 4); assert.equal(catalog.rows.find((row) => row.sku === "EXPORT-A")?.barcode, "00001234567890"); assert.equal(catalog.rows.find((row) => row.sku === "EXPORT-D")?.quantity, "99999999999999.9999");
      assert.equal(catalog.generatedBy.id, actors.ADMINISTRATOR.id); assert.equal(new Date(catalog.expiresAt).getTime() - new Date(catalog.generatedAt).getTime(), 1800000);
    });
    await check("prévia é privada mesmo entre usuários autorizados", async () => { assert.equal((await operator.request(`/api/transfers/exports/${catalog.id}`)).status, 404); assert.equal((await download(catalog.id, "xlsx", manager)).status, 404); });
    await check("prévia congela valores anteriores a alterações do catálogo", async () => {
      await response(await administrator.json(`/api/catalog/products/${first.id}`, { expectedVersion: first.version, salePrice: "99.1234" }, "PATCH"));
      const frozen = await response<ReportPreviewDTO>(await administrator.request(`/api/transfers/exports/${catalog.id}`)); assert.equal(frozen.rows.find((row) => row.sku === "EXPORT-A")?.price, "5.1234");
    });
    await check("Excel contém prévia completa com strings sem execução de fórmula", async () => {
      const file = await download(catalog.id, "xlsx"); assert.equal(file.status, 200); assert.equal(file.headers.get("cache-control"), "no-store"); assert.equal(file.headers.get("x-content-type-options"), "nosniff"); assert.match(file.headers.get("content-disposition") ?? "", /^attachment; filename="prevision-products-\d{4}-\d{2}-\d{2}\.xlsx"$/);
      const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(await file.arrayBuffer()); const sheet = workbook.getWorksheet("Dados")!;
      assert.equal(sheet.rowCount, catalog.rowCount + 1);
      const skuIndex = catalog.columns.findIndex(({ key }) => key === "sku") + 1; const barcodeIndex = catalog.columns.findIndex(({ key }) => key === "barcode") + 1; const nameIndex = catalog.columns.findIndex(({ key }) => key === "name") + 1;
      const firstRow = [...Array(sheet.rowCount - 1)].map((_, index) => sheet.getRow(index + 2)).find((row) => row.getCell(skuIndex).value === "EXPORT-A")!;
      assert.equal(firstRow.getCell(barcodeIndex).value, "00001234567890"); assert.equal(firstRow.getCell(nameIndex).type, ExcelJS.ValueType.String); assert.equal(firstRow.getCell(nameIndex).value, first.name);
      assert.equal(workbook.getWorksheet("Informações")?.getCell("B3").value, catalog.generatedAt);
    });
    await check("PDF é gerado localmente com fonte Unicode empacotada", async () => {
      const file = await download(catalog.id, "pdf"); assert.equal(file.status, 200); assert.equal(file.headers.get("content-type"), "application/pdf"); const bytes = Buffer.from(await file.arrayBuffer()); assert.equal(bytes.subarray(0, 5).toString(), "%PDF-"); assert.equal(bytes.includes(Buffer.from("Roboto")), true);
    });
    await check("formatos e filtros ambíguos são rejeitados", async () => {
      for (const query of ["format=csv", "format=pdf&format=xlsx", "format=&format=pdf", "format=pdf&path=file"]) assert.equal((await administrator.request(`/api/transfers/exports/${catalog.id}/download?${query}`)).status, 400);
      for (const body of [{ kind: "curva_abc", filters: {} }, { kind: "entries", filters: { type: "EXIT" } }, { kind: "products", filters: { actorId: privacyId } }, { kind: "movements", filters: { from: "2026-10-01" } }]) assert.equal((await administrator.json("/api/transfers/exports/preview", body)).status, 400);
    });
    await check("relatórios de estoque calculam estimativas e distinguem condições", async () => {
      const stock = await preview("stock", { search: "EXPORT-B" }); assert.equal(stock.rowCount, 1); assert.equal(stock.rows[0].estimatedCost, "4.69"); assert.equal(stock.rows[0].potentialSale, "10.25");
      const lowReport = await preview("low_stock"); assert.equal(lowReport.rowCount, 1); assert.equal(lowReport.rows[0].sku, low.sku);
      const emptyReport = await preview("empty_stock"); assert.equal(emptyReport.rowCount, 1); assert.equal(emptyReport.rows[0].sku, empty.sku);
    });
    await check("entradas e saídas preservam valores históricos e datas UTC", async () => {
      const entries = await preview("entries", { productId: first.id }); assert.equal(entries.rowCount, 1); assert.equal(entries.rows[0].unitCost, "1.2345"); assert.equal(entries.rows[0].totalCost, "12.50"); assert.match(entries.rows[0].occurredAt!, /Z$/);
      const exits = await preview("exits", { productId: first.id }); assert.equal(exits.rowCount, 1); assert.equal(exits.rows[0].unitPrice, "9.8765"); assert.equal(exits.rows[0].unitCost, "2.3456");
      const history = await preview("movements", { productId: first.id, type: "EXIT" }); assert.equal(history.rowCount, 1); assert.equal(history.rows[0].type, "Saída");
    });
    await check("período e pesquisa usam filtros sem expandir curinga fornecido", async () => {
      const emptyWindow = await preview("entries", { from: "2000-01-01T00:00:00Z", to: "2000-01-02T00:00:00Z" }); assert.equal(emptyWindow.rowCount, 0);
      assert.equal((await preview("products", { search: "%" })).rowCount, 0);
      const pdf = await download(emptyWindow.id, "pdf"); assert.equal(pdf.status, 200); assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), "%PDF-");
    });
    const opened = await response<InventoryMutationResult>(await administrator.json("/api/inventories", { title: "Conferência exportável", scope: "products", productIds: [first.id], idempotencyKey: randomUUID() }), 201);
    const counted = await response<InventoryMutationResult>(await administrator.json(`/api/inventories/${opened.inventory.id}/counts`, { expectedVersion: opened.inventory.version, items: [{ productId: first.id, countedQuantity: "10.0000", justification: "Conferência física de teste" }], idempotencyKey: randomUUID() }, "PATCH"));
    const completed = await response<InventoryMutationResult>(await administrator.json(`/api/inventories/${opened.inventory.id}/complete`, { expectedVersion: counted.inventory.version, idempotencyKey: randomUUID() }));
    await check("inventários exportam cada item e seu ajuste vinculado", async () => {
      const report = await preview("inventories", { inventoryId: completed.inventory.id, status: "COMPLETED" }); assert.equal(report.rowCount, 1); assert.equal(report.rows[0].baseline, "9.1250"); assert.equal(report.rows[0].counted, "10.0000"); assert.equal(report.rows[0].difference, "0.8750"); assert.equal(report.rows[0].movementId, completed.inventory.items[0].movementId);
    });
    await check("ajustes incluem o efeito da confirmação do inventário", async () => { const report = await preview("adjustments", { productId: first.id }); assert.equal(report.rowCount, 1); assert.equal(report.rows[0].delta, "0.8750"); });
    await check("auditoria exporta somente campos e origens permitidos", async () => {
      const report = await preview("audit", { entityId: privacyId }); assert.equal(report.rowCount, 1); const serialized = JSON.stringify(report);
      for (const value of ["PRIVATE_PASSWORD_VALUE", "PRIVATE_TOKEN_VALUE", "PRIVATE_NESTED_VALUE", "PRIVATE_ORIGIN_VALUE", "passwordHash"]) assert.equal(serialized.includes(value), false);
      assert.equal(report.rows[0].origin, null); assert.equal(serialized.includes("Nome permitido"), true);
      assert.equal(report.rows[0].previous?.includes("Nome: Nome permitido"), true);
      assert.equal(report.rows[0].next, "Ativo: Sim");
      assert.equal(report.columns.find(({ key }) => key === "previous")?.label, "Valores anteriores");
      assert.equal(report.columns.find(({ key }) => key === "next")?.label, "Valores registrados");
      const file = await download(report.id, "xlsx"); assert.equal(file.status, 200); await file.arrayBuffer();
      const pdf = await download(report.id, "pdf"); assert.equal(pdf.status, 200); assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), "%PDF-");
    });
    await check("busca não infere segredos de origem ou snapshots da auditoria", async () => { assert.equal((await preview("audit", { search: "PRIVATE_ORIGIN_VALUE" })).rowCount, 0); assert.equal((await preview("audit", { search: "PRIVATE_TOKEN_VALUE" })).rowCount, 0); });
    await check("operador não consegue prévia de auditoria", async () => { assert.equal((await operator.json("/api/transfers/exports/preview", { kind: "audit", filters: {} })).status, 403); });
    const owned = await preview("products", { search: "EXPORT-A" }, operator);
    await check("remoção da permissão da fonte bloqueia um download já preparado", async () => {
      await fixture.query('DELETE FROM role_permissions WHERE role_id=$1 AND permission_id=(SELECT id FROM permissions WHERE code=$2)', [roles.get("OPERATOR"), "catalog.read"]);
      assert.equal((await download(owned.id, "xlsx", operator)).status, 403);
      await fixture.query('INSERT INTO role_permissions(role_id,permission_id) SELECT $1,id FROM permissions WHERE code=$2', [roles.get("OPERATOR"), "catalog.read"]);
    });
    await check("reports.read é exigida mesmo com permissão da fonte", async () => {
      await fixture.query('DELETE FROM role_permissions WHERE role_id=$1 AND permission_id=(SELECT id FROM permissions WHERE code=$2)', [roles.get("OPERATOR"), "reports.read"]);
      assert.equal((await operator.json("/api/transfers/exports/preview", { kind: "stock", filters: {} })).status, 403); assert.equal((await download(owned.id, "pdf", operator)).status, 403);
      await fixture.query('INSERT INTO role_permissions(role_id,permission_id) SELECT $1,id FROM permissions WHERE code=$2', [roles.get("OPERATOR"), "reports.read"]);
    });
    await check("expiração é aplicada em toda consulta e download", async () => {
      const expired = await preview("products", { search: "EXPORT-C" });
      // Administrative fixture only: temporarily suspend append-only trigger to
      // emulate elapsed time without altering the production guard definition.
      await fixture.query("BEGIN");
      try { await fixture.query('ALTER TABLE report_exports DISABLE TRIGGER report_exports_append_only'); await fixture.query('UPDATE report_exports SET created_at=now()-interval \'2 hours\',expires_at=now()-interval \'1 hour\' WHERE id=$1', [expired.id]); await fixture.query('ALTER TABLE report_exports ENABLE TRIGGER report_exports_append_only'); await fixture.query("COMMIT"); }
      catch (error) { await fixture.query("ROLLBACK"); throw error; }
      assert.equal((await administrator.request(`/api/transfers/exports/${expired.id}`)).status, 409); assert.equal((await download(expired.id, "pdf")).status, 409);
    });
    await check("snapshot e downloads são auditados sem conteúdo do arquivo", async () => {
      const events = await fixture.query("SELECT origin,new_values FROM audit_events WHERE entity_type='ReportExport' AND entity_id=$1 ORDER BY created_at", [catalog.id]); assert.ok(events.rows.length >= 3);
      assert.equal(JSON.stringify(events.rows).includes(first.name), false);
      assert.equal(events.rows.some((row) => row.origin === "transfers.export.download"), true);
    });
    await check("prévia rejeita mais de mil linhas sem truncamento ou snapshot parcial", async () => {
      await fixture.query("INSERT INTO products(id,sku,name,category_id,updated_at) SELECT gen_random_uuid(),'CAP-'||i::text,'CAP-'||i::text,$1,now() FROM generate_series(1,1001) i", [categoryId]);
      await fixture.query("INSERT INTO stock_balances(product_id,quantity,updated_at) SELECT id,0,now() FROM products WHERE sku LIKE 'CAP-%'");
      const before = (await fixture.query('SELECT count(*)::int AS n FROM report_exports')).rows[0].n;
      assert.equal((await administrator.json("/api/transfers/exports/preview", { kind: "products", filters: { search: "CAP-" } })).status, 400);
      assert.equal((await fixture.query('SELECT count(*)::int AS n FROM report_exports')).rows[0].n, before);
    });
    await check("exportar não cria movimentação nem altera inventários", async () => { assert.equal((await fixture.query('SELECT count(*)::int AS n FROM stock_movements')).rows[0].n, 5); assert.equal((await fixture.query('SELECT count(*)::int AS n FROM inventories')).rows[0].n, 1); });
    console.info(`${checked} verificações de exportação aprovadas em banco e servidor descartáveis: snapshots, Excel, PDF, filtros, precisão, permissões e privacidade.`);
  } catch (error) {
    console.error(`Integração de exportação interrompida em: ${currentCheck}. Dados privados foram omitidos.`);
    if (error instanceof assert.AssertionError && ["number", "boolean"].includes(typeof error.actual) && ["number", "boolean"].includes(typeof error.expected)) console.error(`Resultado recebido: ${String(error.actual)}; esperado: ${String(error.expected)}.`);
    process.exitCode = 1;
  } finally {
    await stopServer(server); if (connected) await fixture.end().catch(() => {});
    if (created) {
      const result = await admin.query("SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=$1", [databaseName]).catch(() => null);
      if (result?.rows[0]?.marker === marker && /^prevision_exports_test_[0-9a-f]{12}$/.test(databaseName)) await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`).catch(() => { console.error("Não foi possível remover o banco descartável desta execução."); process.exitCode = 1; });
      else { console.error("Marcador divergente; limpeza interrompida."); process.exitCode = 1; }
    }
    await admin.end().catch(() => {});
  }
}
integration().catch(() => { console.error("Não foi possível preparar a integração de exportação. Confira banco local, porta3017 e build; detalhes privados omitidos."); process.exitCode = 1; });
