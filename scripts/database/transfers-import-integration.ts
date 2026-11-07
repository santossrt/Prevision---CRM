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
import type { ImportPreviewDTO, ImportResult } from "../../src/lib/transfers/types.ts";
import { assertDatabaseIdentity, assertLocalDevelopmentDatabase, readEnvironment } from "../../src/server/config/environment.ts";
import { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS } from "../../src/server/authorization/permissions.ts";
import { hashPassword } from "../../src/server/security/password.ts";

config({ path: ".env", quiet: true });
const port = 3016; const base = `http://127.0.0.1:${port}`;
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
  async csrf() { await this.request("/login"); return this.cookies.get("prevision.csrf") ?? ""; }
  async json(path: string, body: unknown) { return this.request(path, { method: "POST", headers: { "Content-Type": "application/json", Origin: base, "X-Prevision-CSRF": await this.csrf() }, body: JSON.stringify(body) }); }
  async upload(content: string | Buffer, name = "produtos.csv", validCsrf = true) {
    const form = new FormData(); form.set("file", new Blob([typeof content === "string" ? content : new Uint8Array(content)]), name);
    return this.request("/api/transfers/imports/preview", { method: "POST", headers: { Origin: base, "X-Prevision-CSRF": validCsrf ? await this.csrf() : "invalid" }, body: form });
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
async function stop(server: ChildProcess | undefined) {
  if (!server || server.exitCode !== null) return; server.kill();
  await Promise.race([new Promise<void>((accept) => server.once("exit", () => accept())), delay(5000)]);
  if (server.exitCode === null) { server.kill("SIGKILL"); await delay(500); }
}
async function integration() {
  const source = readEnvironment(); assertLocalDevelopmentDatabase(source); assert.ok(source.DIRECT_URL);
  assert.equal(new URL(source.DATABASE_URL).host, new URL(source.DIRECT_URL).host); await freePort();
  const suffix = randomBytes(6).toString("hex"); const databaseName = `prevision_import_test_${suffix}`;
  assert.match(databaseName, /^prevision_import_test_[0-9a-f]{12}$/u); const marker = `prevision-import-integration-${randomUUID()}`;
  const adminUrl = new URL(source.DIRECT_URL); const runtimeUrl = new URL(source.DATABASE_URL); adminUrl.pathname = runtimeUrl.pathname = `/${databaseName}`;
  const admin = new Client({ connectionString: source.DIRECT_URL, connectionTimeoutMillis: 5000 });
  const fixture = new Client({ connectionString: adminUrl.href, connectionTimeoutMillis: 5000 });
  const password = `Import-${randomBytes(20).toString("hex")}`;
  const actors = {
    ADMINISTRATOR: { id: randomUUID(), email: `import.admin.${suffix}@example.invalid`, browser: new Browser() },
    MANAGER: { id: randomUUID(), email: `import.reader.${suffix}@example.invalid`, browser: new Browser() },
    OPERATOR: { id: randomUUID(), email: `import.other.${suffix}@example.invalid`, browser: new Browser() }
  };
  const administrator = actors.ADMINISTRATOR.browser; const other = actors.OPERATOR.browser; const reader = actors.MANAGER.browser; const anonymous = new Browser();
  const categoryId = randomUUID(); const supplierId = randomUUID(); const roles = new Map<string, string>();
  let created = false; let connected = false; let server: ChildProcess | undefined; let checked = 0; let currentCheck = "preparo do banco descartável";
  const counts = async () => (await fixture.query('SELECT (SELECT count(*)::int FROM products) AS products,(SELECT count(*)::int FROM stock_movements) AS movements,(SELECT count(*)::int FROM product_imports WHERE status=\'COMPLETED\') AS imports')).rows[0] as { products: number; movements: number; imports: number };
  const check = async (name: string, work: () => unknown | Promise<unknown>) => { currentCheck = name; await fixture.query("DELETE FROM rate_limit_buckets"); await work(); checked++; };
  const csv = (sku: string, barcode = "", extra = "") => `Nome;SKU;Categoria;Código de barras;Custo de aquisição;Preço de venda${extra ? ";" + extra : ""}\r\nProduto ${sku};${sku};Casa;${barcode};1,2500;2,5000`;
  async function preview(content: string | Buffer, name = "produtos.csv", browser = administrator) {
    const response = await browser.upload(content, name); assert.equal(response.status, 201); assert.equal(response.headers.get("cache-control"), "no-store"); return response.json() as Promise<ImportPreviewDTO>;
  }
  async function confirm(job: ImportPreviewDTO, browser = administrator, key = randomUUID(), status = 201) {
    const response = await browser.json(`/api/transfers/imports/${job.id}/confirm`, { idempotencyKey: key }); assert.equal(response.status, status); return response.json() as Promise<ImportResult>;
  }
  try {
    await admin.connect(); const identity = await admin.query('SELECT environment,database_id AS "databaseId" FROM environment_sentinel WHERE id=$1', ["primary"]); assertDatabaseIdentity(source, identity.rows[0] ?? null);
    await admin.query(`CREATE DATABASE "${databaseName}"`); created = true; await admin.query(`COMMENT ON DATABASE "${databaseName}" IS '${marker}'`);
    await fixture.connect(); connected = true;
    for (const name of (await readdir(resolve("prisma", "migrations"))).filter((name) => /^\d+_/u.test(name)).sort()) await fixture.query(await readFile(resolve("prisma", "migrations", name, "migration.sql"), "utf8"));
    await fixture.query('INSERT INTO environment_sentinel(id,environment,database_id) VALUES($1,$2,$3)', ["primary", "test", marker]);
    for (const code of Object.keys(actors)) { const roleId = randomUUID(); roles.set(code, roleId); await fixture.query('INSERT INTO roles(id,code,name,updated_at) VALUES($1,$2,$3,now())', [roleId, code, code]); }
    for (const code of PERMISSIONS) {
      const permissionId = randomUUID(); await fixture.query('INSERT INTO permissions(id,code) VALUES($1,$2)', [permissionId, code]);
      for (const [role, defaults] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) if ((role === "MANAGER" ? ["catalog.read"] : defaults as readonly string[]).includes(code)) await fixture.query('INSERT INTO role_permissions(role_id,permission_id) VALUES($1,$2)', [roles.get(role), permissionId]);
    }
    const passwordHash = await hashPassword(password);
    for (const [role, actor] of Object.entries(actors)) await fixture.query('INSERT INTO users(id,name,email,password_hash,role_id,updated_at) VALUES($1,$2,$3,$4,$5,now())', [actor.id, role, actor.email, passwordHash, roles.get(role)]);
    await fixture.query('INSERT INTO categories(id,name,updated_at) VALUES($1,$2,now())', [categoryId, "Casa"]);
    await fixture.query('INSERT INTO suppliers(id,name,tax_id,updated_at) VALUES($1,$2,$3,now())', [supplierId, "Fornecedor", "AB123"]);
    server = spawn(process.execPath, [resolve("node_modules", "next", "dist", "bin", "next"), "start", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: process.cwd(), windowsHide: true, stdio: ["ignore", "ignore", "ignore"], env: { ...process.env, NODE_ENV: "production", APP_ENV: "test", DATABASE_ID: marker, DATABASE_URL: runtimeUrl.href, DIRECT_URL: adminUrl.href, AUTH_SECRET: randomBytes(48).toString("hex"), AUTH_URL: base, MAIL_TRANSPORT: "local", GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "", VERCEL: "", REQUEST_IP_HEADER: "", NEXT_TELEMETRY_DISABLED: "1" } });
    let ready = false; for (let attempt = 0; attempt < 100; attempt++) { if (server.exitCode !== null) break; try { ready = (await fetch(base + "/api/health", { signal: AbortSignal.timeout(1000) })).ok; } catch { /* await own child */ } if (ready) break; await delay(250); } assert.equal(ready, true);
    await check("rotas exigem sessão e logins de teste funcionam", async () => {
      assert.equal((await anonymous.request("/api/transfers/imports/template?format=csv")).status, 401);
      assert.equal((await anonymous.upload(csv("ANON"))).status, 401);
      for (const actor of Object.values(actors)) assert.equal(await actor.browser.login(actor.email, password), true);
    });
    await check("permissão de escrita e CSRF são obrigatórios", async () => {
      assert.equal((await reader.upload(csv("DENIED"))).status, 403);
      assert.equal((await administrator.upload(csv("CSRF"), "produtos.csv", false)).status, 403);
      assert.equal((await reader.request("/api/transfers/imports/template?format=csv")).status, 403);
    });
    await check("modelos CSV e XLSX não contêm produtos fictícios", async () => {
      const text = await administrator.request("/api/transfers/imports/template?format=csv"); assert.equal(text.status, 200); assert.ok((await text.text()).includes("Nome;SKU;Código de barras"));
      const response = await administrator.request("/api/transfers/imports/template?format=xlsx"); assert.equal(response.status, 200); const book = new ExcelJS.Workbook(); await book.xlsx.load(Buffer.from(await response.arrayBuffer()) as unknown as ExcelJS.Buffer); assert.equal(book.getWorksheet("Produtos")?.rowCount, 1);
      assert.equal((await administrator.request("/api/transfers/imports/template?format=csv&format=xlsx")).status, 400);
    });
    await check("upload recusa formato, tamanho e coluna de saldo", async () => {
      assert.equal((await administrator.upload("invalid", "teste.xls")).status, 400);
      assert.equal((await administrator.upload(Buffer.alloc(2 * 1024 * 1024 + 1), "teste.csv")).status, 400);
      assert.equal((await administrator.upload(Buffer.from([0xff, 0xfe, 0x80]), "teste.csv")).status, 400);
      assert.equal((await administrator.upload("Nome;SKU;Categoria;Quantidade\nP;A;Casa;99")).status, 400);
    });
    let first: ImportPreviewDTO;
    await check("prévia CSV preserva zeros e não cria produtos", async () => {
      first = await preview(csv("IM-01", "00000123")); assert.equal(first.canConfirm, true); assert.equal(first.rows[0].data.barcode, "00000123"); assert.equal(first.rows[0].data.acquisitionCost, "1.2500"); assert.equal((await counts()).products, 0);
    });
    await check("a prévia pertence somente ao responsável", async () => {
      assert.equal((await other.request(`/api/transfers/imports/${first.id}`)).status, 404);
      assert.equal((await other.json(`/api/transfers/imports/${first.id}/confirm`, { idempotencyKey: randomUUID() })).status, 404);
    });
    await check("confirmação cria saldo zero, valores iniciais, alerta e auditoria", async () => {
      const result = await confirm(first); assert.equal(result.import.createdCount, 1); assert.equal(result.replayed, false);
      const data = await fixture.query("SELECT p.id,b.quantity::text,(SELECT count(*)::int FROM product_value_history h WHERE h.product_id=p.id) AS history,a.kind FROM products p JOIN stock_balances b ON b.product_id=p.id JOIN stock_alerts a ON a.product_id=p.id WHERE p.sku=$1", ["IM-01"]);
      assert.equal(data.rows[0].quantity, "0.0000"); assert.equal(data.rows[0].history, 2); assert.equal(data.rows[0].kind, "EMPTY"); assert.equal((await counts()).movements, 0);
      assert.equal((await fixture.query("SELECT count(*)::int AS n FROM audit_events WHERE action='IMPORT' AND entity_id=$1", [first.id])).rows[0].n, 1);
    });
    await check("replay e reenvio semântico não duplicam produtos ou importações", async () => {
      const before = await counts(); const result = await confirm(first, administrator, randomUUID(), 200); assert.equal(result.replayed, true);
      const repeated = await preview('Categoria,SKU,Nome,Código de barras,Preço de venda,Custo de aquisição\nCasa,im-01,Produto IM-01,00000123,2.5,1.25');
      assert.equal(repeated.status, "COMPLETED"); assert.equal(repeated.id, first.id); assert.deepEqual(await counts(), before);
    });
    await check("linhas inválidas e duplicadas bloqueiam o lote inteiro", async () => {
      const job = await preview('Nome;SKU;Categoria;Código de barras;Custo de aquisição\nVálido;GOOD-BLOCKED;Casa;NEW-1;1\nInválido;BAD-INPUT;Ausente;NEW-INVALID;abc\nDuplicado A;DUP;Casa;NEW-2;1\nDuplicado B;DUP;Casa;NEW-2;1\nExistente;IM-01;Casa;00000123;1');
      assert.equal(job.rowCount, 5); assert.equal(job.errorCount, 4); assert.equal(job.canConfirm, false);
      const duplicates = job.rows.filter((row) => row.data.sku === "DUP"); assert.equal(duplicates.length, 2);
      for (const row of duplicates) for (const column of ["sku", "barcode"]) assert.ok(row.errors.some((issue) => issue.column === column && issue.message.includes("mais de uma vez")));
      const before = await counts();
      assert.equal((await administrator.json(`/api/transfers/imports/${job.id}/confirm`, { idempotencyKey: randomUUID() })).status, 400); assert.deepEqual(await counts(), before);
    });
    await check("XLSX suporta texto exato e valores numéricos de custo", async () => {
      const book = new ExcelJS.Workbook(); book.addWorksheet("Produtos").addRows([["Nome", "SKU", "Categoria", "Código de barras", "Custo de aquisição"], ["Excel", "IM-XLSX", "Casa", "0000000088", 2.125]]);
      const job = await preview(Buffer.from(await book.xlsx.writeBuffer()), "produtos.xlsx"); assert.equal(job.errorCount, 0); assert.equal(job.rows[0].data.barcode, "0000000088"); await confirm(job);
    });
    await check("XLSX identifica código numérico e fórmula sem executar", async () => {
      const book = new ExcelJS.Workbook(); book.addWorksheet("Produtos").addRows([["Nome", "SKU", "Categoria", "Código de barras"], ["Excel", "IM-FORMULA", "Casa", 123], [{ formula: "1+1", result: 2 }, "IM-FORMULA2", "Casa", "999"]]);
      const job = await preview(Buffer.from(await book.xlsx.writeBuffer()), "produtos.xlsx"); assert.equal(job.errorCount, 2); assert.equal(job.canConfirm, false);
    });
    await check("referência alterada exige nova prévia", async () => {
      const content = csv("IM-REF"); const job = await preview(content); await fixture.query('UPDATE categories SET version=version+1,updated_at=now() WHERE id=$1', [categoryId]); const before = await counts();
      assert.equal((await administrator.json(`/api/transfers/imports/${job.id}/confirm`, { idempotencyKey: randomUUID() })).status, 409); assert.deepEqual(await counts(), before);
      const fresh = await preview(content); assert.notEqual(fresh.id, job.id); await confirm(fresh);
    });
    await check("prévia expirada tem resposta de resolução estável", async () => {
      const sourceJob = await preview(csv("IM-EXPIRED")); const expiredId = randomUUID();
      await fixture.query("INSERT INTO product_imports(id,owner_id,file_name,format,data_hash,payload,row_count,error_count,created_at,expires_at,operation_id) SELECT $1,owner_id,file_name,format,data_hash,payload,row_count,error_count,now()-interval '2 hours',now()-interval '1 hour',$2 FROM product_imports WHERE id=$3", [expiredId, randomUUID(), sourceJob.id]);
      const expiredRead = await administrator.request(`/api/transfers/imports/${expiredId}`);
      assert.equal(expiredRead.status, 409); assert.equal(expiredRead.headers.get("cache-control"), "no-store");
      assert.equal((await expiredRead.json() as { code: string }).code, "IMPORT_PREVIEW_EXPIRED");
      const response = await administrator.json(`/api/transfers/imports/${expiredId}/confirm`, { idempotencyKey: randomUUID() }); assert.equal(response.status, 409); assert.equal((await response.json() as { code: string }).code, "IMPORT_PREVIEW_EXPIRED");
    });
    await check("confirmações concorrentes da mesma prévia são idempotentes", async () => {
      const job = await preview(csv("IM-RACE")); const key = randomUUID(); const before = await counts();
      const responses = await Promise.all([administrator.json(`/api/transfers/imports/${job.id}/confirm`, { idempotencyKey: key }), administrator.json(`/api/transfers/imports/${job.id}/confirm`, { idempotencyKey: key })]);
      assert.deepEqual(responses.map((response) => response.status).sort(), [200, 201]); assert.equal((await counts()).products, before.products + 1);
    });
    await check("duas prévias do mesmo arquivo gravam apenas uma importação", async () => {
      const content = csv("IM-TWO"); const firstJob = await preview(content); const secondJob = await preview(content); const before = await counts();
      const responses = await Promise.all([administrator.json(`/api/transfers/imports/${firstJob.id}/confirm`, { idempotencyKey: randomUUID() }), administrator.json(`/api/transfers/imports/${secondJob.id}/confirm`, { idempotencyKey: randomUUID() })]);
      assert.deepEqual(responses.map((response) => response.status).sort(), [200, 201]); assert.equal((await counts()).products, before.products + 1);
    });
    await check("falha final de auditoria reverte todo o lote", async () => {
      const job = await preview('Nome;SKU;Categoria\nA;IM-ROLL-A;Casa\nB;IM-ROLL-B;Casa'); const before = await counts();
      await fixture.query("CREATE FUNCTION reject_import_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='IMPORT' THEN RAISE EXCEPTION 'controlled import failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_import_test BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_import_test()");
      try { assert.equal((await administrator.json(`/api/transfers/imports/${job.id}/confirm`, { idempotencyKey: randomUUID() })).status, 503); assert.deepEqual(await counts(), before); assert.equal((await fixture.query('SELECT count(*)::int AS n FROM products WHERE sku IN ($1,$2)', ["IM-ROLL-A", "IM-ROLL-B"])).rows[0].n, 0); }
      finally { await fixture.query("DROP TRIGGER reject_import_test ON audit_events; DROP FUNCTION reject_import_test()"); }
      await confirm(job);
    });
    await check("duplicidade criada após prévia reverte produtos anteriores do lote", async () => {
      const job = await preview('Nome;SKU;Categoria\nA;IM-LATE-A;Casa\nB;IM-LATE-B;Casa');
      assert.equal((await other.json("/api/catalog/products", { name: "B concorrente", sku: "IM-LATE-B", categoryId })).status, 201); const before = await counts();
      assert.equal((await administrator.json(`/api/transfers/imports/${job.id}/confirm`, { idempotencyKey: randomUUID() })).status, 409); assert.deepEqual(await counts(), before); assert.equal((await fixture.query('SELECT count(*)::int AS n FROM products WHERE sku=$1', ["IM-LATE-A"])).rows[0].n, 0);
    });
    await check("histórico concluído não pode ser reescrito no SQL", async () => {
      await fixture.query("BEGIN"); try { let code = ""; try { await fixture.query('UPDATE product_imports SET file_name=$1 WHERE id=$2', ["changed.csv", first.id]); } catch (error) { code = String((error as { code?: string }).code); } assert.equal(code, "55000"); } finally { await fixture.query("ROLLBACK"); }
    });
    await check("permissão revogada durante espera pelo lock impede confirmação", async () => {
      const job = await preview(csv("IM-REVOKED"), "produtos.csv", other); await other.csrf(); await fixture.query("BEGIN"); await fixture.query("SELECT pg_advisory_xact_lock(2026103002)");
      let transaction = true; let pending: Promise<Response> | undefined;
      try {
        pending = other.json(`/api/transfers/imports/${job.id}/confirm`, { idempotencyKey: randomUUID() }); let waiting = false;
        for (let attempt = 0; attempt < 100; attempt++) { waiting = (await admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock' AND wait_event='advisory'", [databaseName])).rows[0].n > 0; if (waiting) break; await delay(50); }
        assert.equal(waiting, true); await fixture.query("DELETE FROM role_permissions WHERE role_id=$1 AND permission_id=(SELECT id FROM permissions WHERE code='catalog.write')", [roles.get("OPERATOR")]); await fixture.query("COMMIT"); transaction = false;
        assert.equal((await pending).status, 403); assert.equal((await fixture.query('SELECT count(*)::int AS n FROM products WHERE sku=$1', ["IM-REVOKED"])).rows[0].n, 0);
      } finally { if (transaction) await fixture.query("ROLLBACK").catch(() => {}); await pending?.catch(() => {}); }
    });
    await check("limite de tentativas protege o processamento do upload", async () => {
      for (let index = 0; index < 21; index++) assert.equal((await administrator.json("/api/transfers/imports/preview", {})).status, index < 20 ? 400 : 429);
    });
    console.info(`${checked} verificações de importação aprovadas em banco e servidor descartáveis: CSV/XLSX, prévia, permissões, saldo zero, duplicidades, expiração, idempotência, rollback e concorrência.`);
  } catch (error) {
    console.error(`Integração de importação interrompida em: ${currentCheck}. Dados privados foram omitidos.`);
    if (error instanceof assert.AssertionError && ["number", "boolean"].includes(typeof error.actual) && ["number", "boolean"].includes(typeof error.expected)) console.error(`Resultado recebido: ${String(error.actual)}; esperado: ${String(error.expected)}.`);
    process.exitCode = 1;
  } finally {
    await stop(server); if (connected) await fixture.end().catch(() => {});
    if (created) { const state = await admin.query("SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=$1", [databaseName]).catch(() => null); if (state?.rows[0]?.marker === marker && /^prevision_import_test_[0-9a-f]{12}$/u.test(databaseName)) await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`).catch(() => { console.error("Não foi possível remover o banco descartável desta execução."); process.exitCode = 1; }); else { console.error("Marcador divergente; limpeza interrompida."); process.exitCode = 1; } }
    await admin.end().catch(() => {});
  }
}
integration().catch(() => { console.error("Não foi possível preparar a integração de importação. Confira o banco local, porta 3016 e build; detalhes privados omitidos."); process.exitCode = 1; });
