import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "pg";
import { config } from "dotenv";
import type { NotificationList, NotificationSummary, NoticeResult, NotificationDTO } from "../../src/lib/notifications/types.ts";
import type { UserPreferenceDTO } from "../../src/lib/preferences/types.ts";
import type { InventoryMutationResult } from "../../src/lib/inventory/types.ts";
import { assertDatabaseIdentity, assertLocalDevelopmentDatabase, readEnvironment } from "../../src/server/config/environment.ts";
import { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS } from "../../src/server/authorization/permissions.ts";
import { hashPassword } from "../../src/server/security/password.ts";

config({ path: ".env", quiet: true });
const port = 3018; const base = `http://127.0.0.1:${port}`;
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
  assert.equal(new URL(source.DATABASE_URL).host, new URL(source.DIRECT_URL).host); await freePort();
  const suffix = randomBytes(6).toString("hex"); const databaseName = `prevision_notifications_test_${suffix}`;
  assert.match(databaseName, /^prevision_notifications_test_[0-9a-f]{12}$/u);
  const marker = `prevision-notifications-integration-${randomUUID()}`;
  const adminUrl = new URL(source.DIRECT_URL); const runtimeUrl = new URL(source.DATABASE_URL); adminUrl.pathname = runtimeUrl.pathname = `/${databaseName}`;
  const admin = new Client({ connectionString: source.DIRECT_URL, connectionTimeoutMillis: 5000 });
  const fixture = new Client({ connectionString: adminUrl.href, connectionTimeoutMillis: 5000 });
  const password = `Notifications-${randomBytes(20).toString("hex")}`;
  const actors = {
    ADMINISTRATOR: { id: randomUUID(), email: `notifications.admin.${suffix}@example.invalid`, browser: new Browser() },
    MANAGER: { id: randomUUID(), email: `notifications.manager.${suffix}@example.invalid`, browser: new Browser() },
    OPERATOR: { id: randomUUID(), email: `notifications.operator.${suffix}@example.invalid`, browser: new Browser() }
  };
  const administrator = actors.ADMINISTRATOR.browser; const operator = actors.OPERATOR.browser; const manager = actors.MANAGER.browser; const anonymous = new Browser();
  const roles = new Map<string, string>(); const categoryId = randomUUID(); const supplierId = randomUUID();
  const historicalProductId = randomUUID(); const historicalMovementId = randomUUID(); const historicalInventoryId = randomUUID(); const shortageId = randomUUID();
  let created = false; let connected = false; let server: ChildProcess | undefined; let checked = 0; let currentCheck = "preparo do banco descartável";
  const check = async (name: string, work: () => unknown | Promise<unknown>) => { currentCheck = name; await work(); checked++; };
  const list = (browser = administrator, query = "") => browser.request(`/api/notifications${query ? `?${query}` : ""}`).then((value) => response<NotificationList>(value));
  const summary = (browser = administrator) => browser.request("/api/notifications/summary").then((value) => response<NotificationSummary>(value));
  const countKind = async (kind: string) => (await fixture.query('SELECT count(*)::int AS n FROM notifications WHERE kind=$1', [kind])).rows[0].n as number;
  const notice = async (key = randomUUID(), title = "Aviso administrativo") => response<NoticeResult>(await administrator.json("/api/notifications/notices", { title, message: "Informação publicada para os usuários do ambiente.", idempotencyKey: key }), 201);
  const movement = async (productId: string, type: string, quantity: string, key = randomUUID(), expectedStatus = 201, occurredAt = new Date(Date.now() - 60000).toISOString()) => response<{ movement: { id: string }; replayed: boolean }>(await administrator.json("/api/stock/movements", { productId, type, quantity, occurredAt, idempotencyKey: key, ...(type === "ENTRY" ? { supplierId, unitCost: "1.0000" } : type === "EXIT" ? { unitPrice: "2.0000" } : { justification: "Ajuste de teste da central" }) }), expectedStatus);
  try {
    await admin.connect(); const identity = await admin.query('SELECT environment,database_id AS "databaseId" FROM environment_sentinel WHERE id=$1', ["primary"]); assertDatabaseIdentity(source, identity.rows[0] ?? null);
    await admin.query(`CREATE DATABASE "${databaseName}"`); created = true;
    await admin.query(`COMMENT ON DATABASE "${databaseName}" IS '${marker}'`); await fixture.connect(); connected = true;
    const migrations = (await readdir(resolve("prisma", "migrations"))).filter((name) => /^\d+_/.test(name)).sort();
    const notificationMigration = migrations.find((name) => name.startsWith("202611010010_")); assert.ok(notificationMigration);
    for (const name of migrations.filter((name) => name < notificationMigration)) await fixture.query(await readFile(resolve("prisma", "migrations", name, "migration.sql"), "utf8"));
    await fixture.query('INSERT INTO environment_sentinel(id,environment,database_id) VALUES($1,$2,$3)', ["primary", "test", marker]);
    for (const role of Object.keys(actors)) { const id = randomUUID(); roles.set(role, id); await fixture.query('INSERT INTO roles(id,code,name,updated_at) VALUES($1,$2,$3,now())', [id, role, role]); }
    for (const code of PERMISSIONS) {
      const id = randomUUID(); await fixture.query('INSERT INTO permissions(id,code) VALUES($1,$2)', [id, code]);
      for (const [role, defaults] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) if ((defaults as readonly string[]).includes(code)) await fixture.query('INSERT INTO role_permissions(role_id,permission_id) VALUES($1,$2)', [roles.get(role), id]);
    }
    const hash = await hashPassword(password);
    for (const [role, actor] of Object.entries(actors)) await fixture.query('INSERT INTO users(id,name,email,password_hash,role_id,updated_at) VALUES($1,$2,$3,$4,$5,now())', [actor.id, `Responsável ${role}`, actor.email, hash, roles.get(role)]);
    await fixture.query('INSERT INTO categories(id,name,updated_at) VALUES($1,$2,now())', [categoryId, "Categoria da central"]);
    await fixture.query('INSERT INTO suppliers(id,name,updated_at) VALUES($1,$2,now())', [supplierId, "Fornecedor da central"]);
    await fixture.query("INSERT INTO products(id,sku,name,category_id,minimum_stock,updated_at) VALUES($1,'OLD-NORMAL','Produto histórico',$3,2,now()),($2,'OLD-LOW','Condição existente',$3,2,now())", [historicalProductId, shortageId, categoryId]);
    await fixture.query('INSERT INTO stock_balances(product_id,quantity,updated_at) VALUES($1,10,now()),($2,1,now())', [historicalProductId, shortageId]);
    await fixture.query("INSERT INTO stock_movements(id,product_id,type,quantity_delta,quantity_before,quantity_after,historical_unit_cost,historical_total_cost,performed_by_id,occurred_at,created_at,operation_id,idempotency_key,justification) VALUES($1,$2,'POSITIVE_ADJUSTMENT',10,0,10,0,0,$3,now()-interval '1 day',now()-interval '1 day',$4,$5,'Fixture histórica')", [historicalMovementId, historicalProductId, actors.ADMINISTRATOR.id, randomUUID(), randomUUID()]);
    await fixture.query("INSERT INTO inventories(id,title,opened_at,created_by_id) VALUES($1,'Conferência histórica',now()-interval '1 day',$2)", [historicalInventoryId, actors.ADMINISTRATOR.id]);
    await fixture.query("INSERT INTO inventory_items(inventory_id,product_id,name,sku,unit_of_measure,category_name,baseline_quantity,baseline_version,counted_quantity,counted_by_id,counted_at) VALUES($1,$2,'Produto histórico','OLD-NORMAL','UN','Categoria da central',10,0,10,$3,now()-interval '1 day')", [historicalInventoryId, historicalProductId, actors.ADMINISTRATOR.id]);
    await fixture.query("UPDATE inventories SET status='COMPLETED',completed_at=now()-interval '12 hours',completed_by_id=$2,version=1 WHERE id=$1", [historicalInventoryId, actors.ADMINISTRATOR.id]);
    for (const name of migrations.filter((name) => name >= notificationMigration)) await fixture.query(await readFile(resolve("prisma", "migrations", name, "migration.sql"), "utf8"));
    await check("migration inicializa somente faltas atuais sem inventar eventos históricos", async () => {
      const items = await fixture.query('SELECT entity_id,kind,message FROM notifications'); assert.equal(items.rowCount, 1); assert.equal(items.rows[0].entity_id, shortageId); assert.equal(items.rows[0].kind, "STOCK_LOW"); assert.ok(items.rows[0].message.includes("Condição existente"));
      assert.equal(await countKind("STOCK_MOVEMENT"), 0); assert.equal(await countKind("INVENTORY_COMPLETED"), 0);
    });
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
    await check("consultas de notificações e preferências exigem autenticação", async () => {
      for (const path of ["/api/notifications", "/api/notifications/summary", "/api/preferences"]) { const result = await anonymous.request(path); assert.equal(result.status, 401); assert.equal(result.headers.get("cache-control"), "no-store"); }
    });
    await check("login dos perfis locais de teste", async () => { for (const actor of Object.values(actors)) assert.equal(await actor.browser.login(actor.email, password), true); });
    await check("leituras e preferências recusam escrita sem CSRF", async () => {
      for (const [path, method, body] of [["/api/notifications/read-all", "POST", { through: new Date().toISOString() }], ["/api/preferences", "PATCH", { theme: "dark", expectedVersion: 0 }]] as const) {
        const result = await administrator.request(path, { method, headers: { "Content-Type": "application/json", Origin: base }, body: JSON.stringify(body) }); assert.equal(result.status, 403); assert.equal(result.headers.get("cache-control"), "no-store");
      }
    });
    let initial!: NotificationDTO;
    await check("lista e resumo trazem notificações legíveis e links internos", async () => {
      const data = await list(); const counts = await summary(); assert.equal(data.total, 1); assert.equal(counts.unreadCount, 1); initial = data.items[0]; assert.equal(initial.href, `/estoque?productId=${shortageId}`); assert.equal(initial.readAt, null); assert.equal(Object.hasOwn(initial, "eventKey"), false); assert.match(data.asOf, /Z$/);
      const linked = await administrator.request(initial.href!); assert.equal(linked.status, 200); assert.ok((await linked.text()).includes("Produto da notificação"));
    });
    await check("leitura individual e concorrente preserva data e não lê para outro usuário", async () => {
      const results = await Promise.all([1, 2].map(async () => response<NotificationDTO>(await administrator.json(`/api/notifications/${initial.id}/read`, {}))));
      assert.ok(results[0].readAt); assert.equal(results[0].readAt, results[1].readAt); assert.equal((await summary()).unreadCount, 0); assert.equal((await summary(operator)).unreadCount, 1);
      assert.equal((await fixture.query('SELECT count(*)::int AS n FROM notification_reads WHERE notification_id=$1 AND user_id=$2', [initial.id, actors.ADMINISTRATOR.id])).rows[0].n, 1);
    });
    await check("filtros são estritos e pesquisa não expande curinga fornecido", async () => {
      for (const query of ["read=invalid", "kind=INVALID", "page=0", "pageSize=51", "read=read&read=unread", "from=2026-11-01", "userId=other"]) assert.equal((await administrator.request(`/api/notifications?${query}`)).status, 400);
      assert.equal((await list(administrator, "search=%25")).total, 0); assert.equal((await list(administrator, "read=read")).total, 1); assert.equal((await list(administrator, "read=unread")).total, 0);
    });
    const product = (await response<{ item: { id: string } }>(await administrator.json("/api/catalog/products", { name: "Produto da central", sku: "NOTIF-CURRENT", categoryId, defaultSupplierId: supplierId, minimumStock: "5.0000", acquisitionCost: "1.0000", salePrice: "2.0000" }), 201)).item;
    await check("criação e transição empty/low geram somente mudanças de condição", async () => {
      const before = await countKind("STOCK_LOW"); await movement(product.id, "ENTRY", "3.0000"); assert.equal(await countKind("STOCK_LOW"), before + 1);
      const total = (await summary()).total; await movement(product.id, "EXIT", "1.0000"); assert.equal((await summary()).total, total);
      await movement(product.id, "ENTRY", "10.0000"); assert.equal((await summary()).total, total);
      const key = randomUUID(); const occurredAt = new Date(Date.now() - 60000).toISOString();
      await movement(product.id, "EXIT", "12.0000", key, 201, occurredAt); const after = (await summary()).total;
      await movement(product.id, "EXIT", "12.0000", key, 200, occurredAt); assert.equal((await summary()).total, after);
      assert.equal((await fixture.query("SELECT count(*)::int AS n FROM notifications WHERE entity_id=$1 AND kind='STOCK_EMPTY'", [product.id])).rows[0].n, 2);
    });
    let adjustmentId = "";
    await check("ajustes e compensações relevantes geram eventos únicos com link do lançamento", async () => {
      const before = await countKind("STOCK_MOVEMENT"); await movement(product.id, "POSITIVE_ADJUSTMENT", "6.0000"); const adjusted = await movement(product.id, "NEGATIVE_ADJUSTMENT", "2.0000"); adjustmentId = adjusted.movement.id;
      assert.equal(await countKind("STOCK_MOVEMENT"), before + 2);
      const key = randomUUID(); const body = { justification: "Compensação de teste", idempotencyKey: key };
      await response(await administrator.json(`/api/stock/movements/${adjustmentId}/compensate`, body), 201); await response(await administrator.json(`/api/stock/movements/${adjustmentId}/compensate`, body));
      assert.equal(await countKind("STOCK_MOVEMENT"), before + 3);
      const data = await list(administrator, "kind=STOCK_MOVEMENT"); assert.ok(data.items.some((item) => item.href === `/estoque?movementId=${adjustmentId}`));
    });
    await check("inventário concluído agrupa divergências e evita evento por ajuste interno", async () => {
      const opened = await response<InventoryMutationResult>(await administrator.json("/api/inventories", { title: "Conferência da central", scope: "products", productIds: [product.id], idempotencyKey: randomUUID() }), 201);
      const counted = await response<InventoryMutationResult>(await administrator.json(`/api/inventories/${opened.inventory.id}/counts`, { expectedVersion: opened.inventory.version, items: [{ productId: product.id, countedQuantity: "7.0000", justification: "Conferência de teste" }], idempotencyKey: randomUUID() }, "PATCH"));
      const before = await countKind("STOCK_MOVEMENT"); const key = randomUUID(); const body = { expectedVersion: counted.inventory.version, idempotencyKey: key };
      const completed = await response<InventoryMutationResult>(await administrator.json(`/api/inventories/${opened.inventory.id}/complete`, body));
      await response(await administrator.json(`/api/inventories/${opened.inventory.id}/complete`, body));
      assert.equal(await countKind("STOCK_MOVEMENT"), before); assert.equal(await countKind("INVENTORY_COMPLETED"), 1); assert.equal(await countKind("INVENTORY_DIVERGENCE"), 1);
      assert.equal((await list(administrator, "kind=INVENTORY_DIVERGENCE")).items[0].href, `/inventarios?id=${completed.inventory.id}`);
    });
    await check("rollback de uma alteração de saldo também desfaz a notificação", async () => {
      const before = (await summary()).total; await fixture.query("BEGIN");
      try { await fixture.query('UPDATE stock_balances SET quantity=0,version=version+1,updated_at=now() WHERE product_id=$1', [product.id]); assert.equal((await fixture.query('SELECT count(*)::int AS n FROM notifications')).rows[0].n, before + 1); }
      finally { await fixture.query("ROLLBACK"); }
      assert.equal((await summary()).total, before);
    });
    await check("gerente e operador não publicam avisos", async () => {
      for (const browser of [manager, operator]) assert.equal((await browser.json("/api/notifications/notices", { title: "Recusado", message: "Somente administrador", idempotencyKey: randomUUID() })).status, 403);
    });
    let firstNotice!: NoticeResult;
    await check("aviso administrativo é público aos autenticados, idempotente e auditado sem corpo", async () => {
      const key = randomUUID(); const body = { title: "Aviso de teste", message: "INTERNAL_BODY_WITHOUT_AUDIT", idempotencyKey: key };
      const results = await Promise.all([1, 2].map(() => administrator.json("/api/notifications/notices", body))); assert.deepEqual(results.map((item) => item.status).sort(), [200, 201]);
      firstNotice = await results[0].json() as NoticeResult; assert.equal(firstNotice.notification.href, null);
      assert.equal((await fixture.query("SELECT count(*)::int AS n FROM notifications WHERE event_key=$1", [`notice:${key}`])).rows[0].n, 1);
      const events = await fixture.query("SELECT new_values,origin FROM audit_events WHERE entity_type='Notification' AND entity_id=$1", [firstNotice.notification.id]); assert.equal(events.rowCount, 1); assert.equal(events.rows[0].origin, "notifications.notice.create"); assert.equal(JSON.stringify(events.rows).includes(body.message), false);
      assert.equal((await administrator.json("/api/notifications/notices", { ...body, message: "Outro texto" })).status, 409);
      assert.ok((await list(operator, "kind=ADMIN_NOTICE")).items.some((item) => item.id === firstNotice.notification.id));
    });
    await check("marcar todas respeita o corte temporal e o usuário, mantendo novos avisos não lidos", async () => {
      const through = (await summary()).asOf; await delay(5); const later = await notice();
      const marked = await response<{ markedCount: number }>(await administrator.json("/api/notifications/read-all", { through })); assert.ok(marked.markedCount > 0);
      assert.equal((await list(administrator, "read=unread")).items.some((item) => item.id === later.notification.id), true);
      assert.equal((await fixture.query('SELECT count(*)::int AS n FROM notification_reads WHERE notification_id=$1 AND user_id=$2', [later.notification.id, actors.ADMINISTRATOR.id])).rows[0].n, 0);
      assert.equal((await response<{ markedCount: number }>(await administrator.json("/api/notifications/read-all", { through }))).markedCount, 0);
      assert.ok((await summary(operator)).unreadCount > 1);
    });
    await check("revogar consulta de estoque remove conteúdo, contadores e possibilidade de leitura", async () => {
      await fixture.query('DELETE FROM role_permissions WHERE role_id=$1 AND permission_id=(SELECT id FROM permissions WHERE code=$2)', [roles.get("OPERATOR"), "stock.read"]);
      const count = await countKind("ADMIN_NOTICE"); const counts = await summary(operator); assert.equal(counts.total, count); assert.equal(counts.unreadCount, count);
      const data = await list(operator); assert.equal(data.total, count); assert.ok(data.items.every((item) => item.kind === "ADMIN_NOTICE" && item.href === null));
      assert.equal((await list(operator, "search=NOTIF-CURRENT")).total, 0); assert.equal((await operator.json(`/api/notifications/${initial.id}/read`, {})).status, 404);
      await response(await operator.json("/api/notifications/read-all", { through: counts.asOf }));
      assert.equal((await fixture.query('SELECT count(*)::int AS n FROM notification_reads r JOIN notifications n ON n.id=r.notification_id WHERE r.user_id=$1 AND n.required_permission=$2', [actors.OPERATOR.id, "stock.read"])).rows[0].n, 0);
      await fixture.query('INSERT INTO role_permissions(role_id,permission_id) SELECT $1,id FROM permissions WHERE code=$2', [roles.get("OPERATOR"), "stock.read"]);
      assert.ok((await summary(operator)).unreadCount > 0);
    });
    await check("histórico de notificações e leituras é imutável no banco", async () => {
      for (const statement of ['UPDATE notifications SET title=title WHERE id=$1', 'DELETE FROM notifications WHERE id=$1']) await assert.rejects(fixture.query(statement, [initial.id]), (error: unknown) => (error as { code?: string }).code === "55000");
      for (const statement of ['UPDATE notification_reads SET read_at=read_at WHERE notification_id=$1', 'DELETE FROM notification_reads WHERE notification_id=$1']) await assert.rejects(fixture.query(statement, [initial.id]), (error: unknown) => (error as { code?: string }).code === "55000");
    });
    await check("preferência começa no sistema, persiste por usuário e detecta edição concorrente", async () => {
      assert.deepEqual(await response<UserPreferenceDTO>(await administrator.request("/api/preferences")), { theme: "system", version: 0 });
      assert.deepEqual(await response<UserPreferenceDTO>(await administrator.json("/api/preferences", { theme: "dark", expectedVersion: 0 }, "PATCH")), { theme: "dark", version: 1 });
      assert.deepEqual(await response<UserPreferenceDTO>(await operator.request("/api/preferences")), { theme: "system", version: 0 });
      assert.equal((await administrator.json("/api/preferences", { theme: "light", expectedVersion: 0 }, "PATCH")).status, 409);
      assert.deepEqual(await response<UserPreferenceDTO>(await administrator.request("/api/preferences")), { theme: "dark", version: 1 });
    });
    await check("preferências recusam tema inválido, dono externo e versões arbitrárias", async () => {
      for (const body of [{ theme: "other", expectedVersion: 1 }, { theme: "light", expectedVersion: 1, userId: actors.OPERATOR.id }, { theme: "light", expectedVersion: -1 }]) assert.equal((await administrator.json("/api/preferences", body, "PATCH")).status, 400);
      assert.equal((await administrator.json(`/api/notifications/${initial.id}/read`, { userId: actors.OPERATOR.id })).status, 400);
    });
    await check("gravações concorrentes do tema não substituem silenciosamente a preferência", async () => {
      const results = await Promise.all(["light", "system"].map((theme) => administrator.json("/api/preferences", { theme, expectedVersion: 1 }, "PATCH")));
      assert.deepEqual(results.map((item) => item.status).sort(), [200, 409]);
      const saved = await response<UserPreferenceDTO>(await administrator.request("/api/preferences")); assert.equal(saved.version, 2); assert.ok(["light", "system"].includes(saved.theme));
    });
    await check("sessão revogada não consulta nem modifica notificações ou preferências", async () => {
      await fixture.query('UPDATE users SET session_version=session_version+1,updated_at=now() WHERE id=$1', [actors.OPERATOR.id]);
      assert.equal((await operator.request("/api/notifications/summary")).status, 401); assert.equal((await operator.request("/api/preferences")).status, 401);
    });
    console.info(`${checked} verificações de notificações e preferências aprovadas em banco e servidor descartáveis: histórico, leitura individual, permissões, avisos, idempotência, triggers, rollback e tema.`);
  } catch (error) {
    console.error(`Integração de notificações interrompida em: ${currentCheck}. Dados privados foram omitidos.`);
    if (error instanceof assert.AssertionError && ["number", "boolean"].includes(typeof error.actual) && ["number", "boolean"].includes(typeof error.expected)) console.error(`Resultado recebido: ${String(error.actual)}; esperado: ${String(error.expected)}.`);
    process.exitCode = 1;
  } finally {
    await stopServer(server); if (connected) await fixture.end().catch(() => {});
    if (created) {
      const result = await admin.query("SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=$1", [databaseName]).catch(() => null);
      if (result?.rows[0]?.marker === marker && /^prevision_notifications_test_[0-9a-f]{12}$/u.test(databaseName)) await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`).catch(() => { console.error("Não foi possível remover o banco descartável desta execução."); process.exitCode = 1; });
      else { console.error("Marcador divergente; limpeza interrompida."); process.exitCode = 1; }
    }
    await admin.end().catch(() => {});
  }
}
integration().catch(() => { console.error("Não foi possível preparar a integração de notificações. Confira banco local, porta 3018 e build; detalhes privados omitidos."); process.exitCode = 1; });
