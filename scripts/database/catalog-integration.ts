import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "pg";
import { config } from "dotenv";
import type { CatalogList, CatalogRecord, CategoryDTO, CustomerDTO, ProductDTO, ProductValueDTO, SupplierDTO } from "../../src/lib/catalog/types.ts";
import { assertDatabaseIdentity, assertLocalDevelopmentDatabase, readEnvironment } from "../../src/server/config/environment.ts";
import { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS } from "../../src/server/authorization/permissions.ts";
import { hashPassword } from "../../src/server/security/password.ts";

config({ path: ".env", quiet: true });

const port = 3011;
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
    assert.ok(csrf, "A página deve fornecer a proteção CSRF.");
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
    return Boolean(result.url && !error && [...this.cookies.keys()].some((key) => key === "prevision.session-token" || key.startsWith("prevision.session-token.")));
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

async function item<T extends CatalogRecord>(response: Response, status: number): Promise<T> {
  assert.equal(response.status, status);
  const result = await response.json() as { item: T };
  assert.ok(result.item?.id);
  assert.equal(typeof result.item.version, "number");
  return result.item;
}

async function list<T>(browser: Browser, path: string): Promise<CatalogList<T>> {
  const response = await browser.request(path);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const result = await response.json() as CatalogList<T>;
  assert.ok(Array.isArray(result.items));
  assert.equal(typeof result.total, "number");
  return result;
}

async function integration() {
  const source = readEnvironment();
  assertLocalDevelopmentDatabase(source);
  assert.ok(source.DIRECT_URL);
  assert.equal(new URL(source.DIRECT_URL).host, new URL(source.DATABASE_URL).host);
  await assertFreePort();
  const suffix = randomBytes(6).toString("hex");
  const databaseName = `prevision_catalog_test_${suffix}`;
  assert.match(databaseName, /^prevision_catalog_test_[0-9a-f]{12}$/);
  const marker = `prevision-catalog-integration-${randomUUID()}`;
  const adminUrl = new URL(source.DIRECT_URL);
  const runtimeUrl = new URL(source.DATABASE_URL);
  adminUrl.pathname = runtimeUrl.pathname = `/${databaseName}`;
  const admin = new Client({ connectionString: source.DIRECT_URL, connectionTimeoutMillis: 5000 });
  const fixture = new Client({ connectionString: adminUrl.href, connectionTimeoutMillis: 5000 });
  const password = `Catalog-integration-${randomBytes(20).toString("hex")}`;
  const administratorId = randomUUID();
  const operatorId = randomUUID();
  const readerId = randomUUID();
  const adminEmail = `catalog.admin.${suffix}@example.invalid`;
  const operatorEmail = `catalog.operator.${suffix}@example.invalid`;
  const readerEmail = `catalog.reader.${suffix}@example.invalid`;
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

  try {
    await admin.connect();
    const identity = await admin.query('SELECT environment, database_id AS "databaseId" FROM environment_sentinel WHERE id=$1', ["primary"]);
    assertDatabaseIdentity(source, identity.rows[0] ?? null);
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    await admin.query(`COMMENT ON DATABASE "${databaseName}" IS '${marker}'`);
    await fixture.connect();
    connectedFixture = true;
    for (const name of (await readdir(resolve("prisma", "migrations"))).filter((name) => /^\d+_/.test(name)).sort()) {
      await fixture.query(await readFile(resolve("prisma", "migrations", name, "migration.sql"), "utf8"));
    }
    await fixture.query('INSERT INTO environment_sentinel(id,environment,database_id) VALUES ($1,$2,$3)', ["primary", "test", marker]);
    const roles = new Map<string, string>();
    for (const code of ["ADMINISTRATOR", "OPERATOR", "MANAGER"] as const) {
      const id = randomUUID();
      roles.set(code, id);
      await fixture.query('INSERT INTO roles(id,code,name,updated_at) VALUES($1,$2,$3,now())', [id, code, code]);
    }
    for (const code of PERMISSIONS) {
      const id = randomUUID();
      await fixture.query('INSERT INTO permissions(id,code) VALUES($1,$2)', [id, code]);
      for (const [role, allowed] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
        const grant = role === "MANAGER" ? code === "catalog.read" : (allowed as readonly string[]).includes(code);
        if (grant) await fixture.query('INSERT INTO role_permissions(role_id,permission_id) VALUES($1,$2)', [roles.get(role), id]);
      }
    }
    const hash = await hashPassword(password);
    for (const [id, email, role] of [[administratorId, adminEmail, "ADMINISTRATOR"], [operatorId, operatorEmail, "OPERATOR"], [readerId, readerEmail, "MANAGER"]]) {
      await fixture.query('INSERT INTO users(id,name,email,password_hash,role_id,updated_at) VALUES($1,$2,$3,$4,$5,now())', [id, "Catálogo de teste", email, hash, roles.get(role)]);
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
      try { ready = (await fetch(base + "/api/health", { signal: AbortSignal.timeout(1000) })).ok; } catch { /* wait for the owned child */ }
      if (ready) break;
      await delay(250);
    }
    assert.ok(ready, "O servidor isolado precisa de um build atualizado.");
    const anonymous = new Browser();
    const administrator = new Browser();
    const operator = new Browser();
    const reader = new Browser();
    await check("catálogo exige autenticação", async () => {
      for (const kind of ["products", "categories", "suppliers", "customers"]) assert.equal((await anonymous.request(`/api/catalog/${kind}`)).status, 401);
    });
    await check("login dos perfis de catálogo", async () => {
      assert.equal(await administrator.login(adminEmail, password), true);
      assert.equal(await operator.login(operatorEmail, password), true);
      assert.equal(await reader.login(readerEmail, password), true);
    });
    await check("páginas protegidas dos quatro cadastros", async () => {
      for (const route of ["produtos", "categorias", "fornecedores", "clientes"]) assert.equal((await administrator.request(`/${route}`)).status, 200);
    });
    await check("perfil de leitura consulta sem escrever", async () => {
      assert.equal((await reader.request("/api/catalog/products")).status, 200);
      assert.equal((await reader.json("/api/catalog/categories", { name: "Não autorizado" })).status, 403);
    });
    await check("cadastros rejeitam origem e CSRF forjados", async () => {
      assert.equal((await administrator.json("/api/catalog/categories", { name: "Origem forjada" }, "POST", { Origin: "https://attacker.invalid" })).status, 403);
      assert.equal((await administrator.json("/api/catalog/categories", { name: "CSRF forjado" }, "POST", { "X-Prevision-CSRF": "forged" })).status, 403);
    });

    let category!: CategoryDTO;
    let inactiveCategory!: CategoryDTO;
    let supplier!: SupplierDTO;
    let inactiveSupplier!: SupplierDTO;
    let customer!: CustomerDTO;
    let product!: ProductDTO;
    await check("criação de categoria normaliza nome e inicia versão", async () => {
      category = await item(await administrator.json("/api/catalog/categories", { name: "  Eletrônicos   de teste  ", description: "Categoria descartável" }), 201);
      assert.equal(category.name, "Eletrônicos de teste");
      assert.equal(category.version, 0);
    });
    await check("categoria rejeita duplicidade sem diferenciar maiúsculas", async () => assert.equal((await administrator.json("/api/catalog/categories", { name: "eletrônicos de teste" })).status, 409));
    await check("cadastro rejeita nome vazio e campo desconhecido", async () => {
      assert.equal((await administrator.json("/api/catalog/categories", { name: "   " })).status, 400);
      assert.equal((await administrator.json("/api/catalog/categories", { name: "Inválido", internalSecret: "not-allowed" })).status, 400);
    });
    await check("categoria inativa e opção de catálogo", async () => {
      inactiveCategory = await item(await administrator.json("/api/catalog/categories", { name: "Categoria inativa", isActive: false }), 201);
      assert.equal(inactiveCategory.isActive, false);
    });
    await check("fornecedor normaliza documento e contato", async () => {
      supplier = await item(await administrator.json("/api/catalog/suppliers", { name: "Fornecedor teste", taxId: "12.345.678/0001-90", email: " CONTATO@EXAMPLE.INVALID ", phone: "+55 11 99999-0000", address: "Endereço fictício", replenishmentLeadTimeDays: 5 }), 201);
      assert.equal(supplier.taxId, "12345678000190");
      assert.equal(supplier.email, "contato@example.invalid");
      assert.equal(supplier.replenishmentLeadTimeDays, 5);
    });
    await check("fornecedor rejeita documento duplicado e prazo negativo", async () => {
      assert.equal((await administrator.json("/api/catalog/suppliers", { name: "Outro fornecedor", taxId: "12345678000190" })).status, 409);
      assert.equal((await administrator.json("/api/catalog/suppliers", { name: "Prazo inválido", replenishmentLeadTimeDays: -1 })).status, 400);
      inactiveSupplier = await item(await administrator.json("/api/catalog/suppliers", { name: "Fornecedor inativo", isActive: false }), 201);
    });
    await check("cliente aceita documento alfanumérico e contato opcional", async () => {
      customer = await item(await administrator.json("/api/catalog/customers", { name: "Cliente teste", taxId: "AB.CDE.123/0001-XY", email: "CLIENTE@EXAMPLE.INVALID", phone: "11 90000-0000" }), 201);
      assert.equal(customer.taxId, "ABCDE1230001XY");
      assert.equal(customer.email, "cliente@example.invalid");
    });
    await check("cliente rejeita duplicidade e e-mail inválido", async () => {
      assert.equal((await administrator.json("/api/catalog/customers", { name: "Duplicado", taxId: "abcde1230001xy" })).status, 409);
      assert.equal((await administrator.json("/api/catalog/customers", { name: "E-mail inválido", email: "not-an-email" })).status, 400);
    });
    await check("edição, inativação e reativação de cliente preservam o registro", async () => {
      customer = await item(await administrator.json(`/api/catalog/customers/${customer.id}`, { expectedVersion: customer.version, address: "Novo endereço fictício", isActive: false }, "PATCH"), 200);
      assert.equal(customer.isActive, false);
      const inactive = await list<CustomerDTO>(administrator, "/api/catalog/customers?status=inactive&search=Cliente");
      assert.equal(inactive.items[0]?.id, customer.id);
      customer = await item(await administrator.json(`/api/catalog/customers/${customer.id}`, { expectedVersion: customer.version, isActive: true }, "PATCH"), 200);
      assert.equal(customer.isActive, true);
    });
    await check("opções preservam a situação de categorias e fornecedores para os filtros", async () => {
      const response = await administrator.request("/api/catalog/options");
      assert.equal(response.status, 200);
      const options = await response.json() as { categories: { id: string; isActive: boolean }[]; suppliers: { id: string; isActive: boolean }[] };
      assert.equal(options.categories.find((entry) => entry.id === category.id)?.isActive, true);
      assert.equal(options.suppliers.find((entry) => entry.id === supplier.id)?.isActive, true);
      assert.equal(options.categories.find((entry) => entry.id === inactiveCategory.id)?.isActive, false);
      assert.equal(options.suppliers.find((entry) => entry.id === inactiveSupplier.id)?.isActive, false);
    });
    await check("pesquisa por documento aceita a pontuação e normaliza letras", async () => {
      const suppliers = await list<SupplierDTO>(administrator, `/api/catalog/suppliers?search=${encodeURIComponent("12.345.678/0001-90")}`);
      assert.equal(suppliers.total, 1);
      assert.equal(suppliers.items[0]?.id, supplier.id);
      const customers = await list<CustomerDTO>(administrator, `/api/catalog/customers?search=${encodeURIComponent("ab.cde.123/0001-xy")}`);
      assert.equal(customers.total, 1);
      assert.equal(customers.items[0]?.id, customer.id);
    });
    await check("consulta individual valida identificador e ausência de registro", async () => {
      for (const [kind, record] of [["categories", category], ["suppliers", supplier], ["customers", customer]] as const) {
        assert.equal((await item(await administrator.request(`/api/catalog/${kind}/${record.id}`), 200)).id, record.id);
        assert.equal((await administrator.request(`/api/catalog/${kind}/invalid-id`)).status, 400);
        assert.equal((await administrator.request(`/api/catalog/${kind}/${randomUUID()}`)).status, 404);
      }
    });
    await check("perfil de leitura não pode editar nem inativar cadastros existentes", async () => {
      assert.equal((await reader.json(`/api/catalog/categories/${category.id}`, { expectedVersion: category.version, isActive: false }, "PATCH")).status, 403);
      assert.equal((await reader.json(`/api/catalog/suppliers/${supplier.id}`, { expectedVersion: supplier.version, name: "Não autorizado" }, "PATCH")).status, 403);
      assert.equal((await reader.json(`/api/catalog/customers/${customer.id}`, { expectedVersion: customer.version, isActive: false }, "PATCH")).status, 403);
      const unchanged = await item<CategoryDTO>(await administrator.request(`/api/catalog/categories/${category.id}`), 200);
      assert.equal(unchanged.version, category.version);
      assert.equal(unchanged.isActive, true);
    });
    await check("documentos vazios permanecem opcionais sem duplicidade artificial", async () => {
      for (const name of ["Contato opcional A", "Contato opcional B"]) {
        const contact = await item<CustomerDTO>(await administrator.json("/api/catalog/customers", { name, taxId: "", email: "", phone: "", address: "" }), 201);
        assert.equal(contact.taxId, null);
        assert.equal(contact.email, null);
        assert.equal(contact.phone, null);
        assert.equal(contact.address, null);
      }
    });

    const productInput = () => ({ name: "Produto de teste", sku: "  prd-001  ", barcode: " 0001234567890 ", categoryId: category.id, defaultSupplierId: supplier.id, unitOfMeasure: "UN", minimumStock: "5.0000", safetyStock: "2.0000", acquisitionCost: "10.1234", salePrice: "19.9000", replenishmentLeadTimeDays: 3 });
    await check("produto cria saldo zero e mantém precisão decimal", async () => {
      product = await item(await administrator.json("/api/catalog/products", productInput()), 201);
      assert.equal(product.sku, "PRD-001");
      assert.equal(product.barcode, "0001234567890");
      assert.equal(product.quantity, "0.0000");
      assert.equal(product.acquisitionCost, "10.1234");
      assert.equal(product.salePrice, "19.9000");
      assert.equal(product.stockStatus, "empty");
      const balances = await fixture.query('SELECT quantity::text,version FROM stock_balances WHERE product_id=$1', [product.id]);
      assert.equal(balances.rows.length, 1);
      assert.equal(balances.rows[0].quantity, "0.0000");
      assert.equal(balances.rows[0].version, 0);
    });
    await check("produto reserva SKU e código de barras únicos", async () => {
      assert.equal((await administrator.json("/api/catalog/products", { ...productInput(), barcode: "other-code" })).status, 409);
      assert.equal((await administrator.json("/api/catalog/products", { ...productInput(), sku: "PRD-DUPLICATE" })).status, 409);
    });
    await check("decimais inválidos são recusados antes de arredondar", async () => {
      for (const value of ["-1.0000", "NaN", "Infinity", "100000000000000.0000", "1.00001", 19.9]) {
        assert.equal((await administrator.json("/api/catalog/products", { ...productInput(), sku: "PRD-INVALID", barcode: null, acquisitionCost: value })).status, 400);
      }
    });
    await check("cadastro não permite informar estoque ou campos internos", async () => {
      assert.equal((await administrator.json("/api/catalog/products", { ...productInput(), sku: "PRD-NOSTOCK", barcode: null, quantity: "50.0000" })).status, 400);
      assert.equal((await administrator.json(`/api/catalog/products/${product.id}`, { expectedVersion: product.version, quantity: "50.0000" }, "PATCH")).status, 400);
      assert.equal((await administrator.json(`/api/catalog/products/${product.id}`, { expectedVersion: product.version, stockBalance: { quantity: "50.0000" } }, "PATCH")).status, 400);
    });
    await check("novos produtos exigem referências existentes e ativas", async () => {
      for (const reference of [{ categoryId: randomUUID() }, { categoryId: inactiveCategory.id }, { defaultSupplierId: inactiveSupplier.id }]) {
        assert.equal((await administrator.json("/api/catalog/products", { ...productInput(), sku: "PRD-BADREF", barcode: null, ...reference })).status, 400);
      }
    });
    await check("histórico inicial registra custo e preço com autoria", async () => {
      const history = await list<ProductValueDTO>(administrator, `/api/catalog/products/${product.id}/values`);
      assert.equal(history.total, 2);
      assert.ok(history.items.every((entry) => entry.previousValue === null && entry.changedBy.id === administratorId));
      assert.equal(history.items.find((entry) => entry.type === "ACQUISITION_COST")?.newValue, "10.1234");
      assert.equal(history.items.find((entry) => entry.type === "SALE_PRICE")?.newValue, "19.9000");
      assert.equal(new Set(history.items.map((entry) => entry.operationId)).size, 1);
    });
    await check("alteração de valores preserva anteriores e compartilha a operação", async () => {
      const beforeVersion = product.version;
      product = await item(await administrator.json(`/api/catalog/products/${product.id}`, { expectedVersion: beforeVersion, acquisitionCost: "12.3456", salePrice: "21.4321" }, "PATCH"), 200);
      assert.equal(product.version, beforeVersion + 1);
      assert.equal(product.quantity, "0.0000");
      const history = await list<ProductValueDTO>(administrator, `/api/catalog/products/${product.id}/values`);
      assert.equal(history.total, 4);
      const cost = history.items.find((entry) => entry.type === "ACQUISITION_COST" && entry.previousValue === "10.1234");
      const price = history.items.find((entry) => entry.type === "SALE_PRICE" && entry.previousValue === "19.9000");
      assert.equal(cost?.newValue, "12.3456");
      assert.equal(price?.newValue, "21.4321");
      assert.equal(cost?.operationId, price?.operationId);
      const audits = await fixture.query("SELECT count(*)::int AS n FROM audit_events WHERE entity_id=$1 AND operation_id=$2 AND action='UPDATE'", [product.id, cost?.operationId]);
      assert.equal(audits.rows[0].n, 1);
    });
    await check("alteração descritiva não repete histórico de valores", async () => {
      product = await item(await administrator.json(`/api/catalog/products/${product.id}`, { expectedVersion: product.version, description: "Descrição revisada", acquisitionCost: "12.3456" }, "PATCH"), 200);
      assert.equal((await list<ProductValueDTO>(administrator, `/api/catalog/products/${product.id}/values`)).total, 4);
    });
    await check("versão ausente e edição desatualizada são recusadas", async () => {
      assert.equal((await administrator.json(`/api/catalog/products/${product.id}`, { name: "Sem versão" }, "PATCH")).status, 400);
      assert.equal((await administrator.json(`/api/catalog/products/${product.id}`, { expectedVersion: 0, name: "Desatualizado" }, "PATCH")).status, 409);
      const current = await item<ProductDTO>(await administrator.request(`/api/catalog/products/${product.id}`), 200);
      assert.equal(current.name, product.name);
      assert.equal(current.version, product.version);
    });

    let low!: ProductDTO;
    let normal!: ProductDTO;
    await check("operador possui o cadastro autorizado e aceita limite decimal exato", async () => {
      low = await item(await operator.json("/api/catalog/products", { ...productInput(), name: "Produto baixo", sku: "PRD-LOW", barcode: "0000000000001", acquisitionCost: "99999999999999.9999" }), 201);
      assert.equal(low.acquisitionCost, "99999999999999.9999");
      normal = await item(await administrator.json("/api/catalog/products", { ...productInput(), name: "Produto normal", sku: "PRD-NORMAL", barcode: null }), 201);
      // Controlled fixtures simulate balances that later stock operations will create.
      await fixture.query('UPDATE stock_balances SET quantity=$2,version=version+1,updated_at=now() WHERE product_id=$1', [low.id, "3.0000"]);
      await fixture.query('UPDATE stock_balances SET quantity=$2,version=version+1,updated_at=now() WHERE product_id=$1', [normal.id, "8.0000"]);
    });
    await check("pesquisa por nome, SKU e código conserva os zeros", async () => {
      for (const query of ["Produto de teste", "prd-001", "0001234567890"]) {
        const result = await list<ProductDTO>(administrator, `/api/catalog/products?search=${encodeURIComponent(query)}`);
        assert.equal(result.total, 1);
        assert.equal(result.items[0].id, product.id);
      }
    });
    await check("filtros por categoria, fornecedor e situação de estoque", async () => {
      const common = `categoryId=${category.id}&supplierId=${supplier.id}`;
      for (const [status, id] of [["empty", product.id], ["low", low.id], ["normal", normal.id]]) {
        const result = await list<ProductDTO>(administrator, `/api/catalog/products?${common}&stock=${status}`);
        assert.equal(result.total, 1);
        assert.equal(result.items[0].id, id);
      }
    });
    await check("paginação não repete itens e valida parâmetros", async () => {
      const first = await list<ProductDTO>(administrator, "/api/catalog/products?page=1&pageSize=2");
      const second = await list<ProductDTO>(administrator, "/api/catalog/products?page=2&pageSize=2");
      assert.equal(first.total, 3);
      assert.equal(first.totalPages, 2);
      assert.equal(first.items.length, 2);
      assert.equal(second.items.length, 1);
      assert.equal(new Set([...first.items, ...second.items].map((entry) => entry.id)).size, 3);
      assert.equal((await administrator.request("/api/catalog/products?pageSize=101")).status, 400);
      assert.equal((await administrator.request("/api/catalog/products?page=0")).status, 400);
    });
    await check("filtros não executam SQL e rejeitam parâmetros desconhecidos ou repetidos", async () => {
      const result = await list<ProductDTO>(administrator, `/api/catalog/products?search=${encodeURIComponent("' OR 1=1 --")}`);
      assert.equal(result.total, 0);
      assert.equal((await administrator.request("/api/catalog/products?unexpectedFilter=1")).status, 400);
      assert.equal((await administrator.request("/api/catalog/products?page=1&page=2")).status, 400);
      assert.equal((await administrator.request(`/api/catalog/products?categoryId=invalid-id`)).status, 400);
    });
    await check("falha por duplicidade não grava preço, histórico ou auditoria", async () => {
      const before = (await fixture.query('SELECT count(*)::int AS n FROM audit_events WHERE entity_id=$1', [product.id])).rows[0].n;
      assert.equal((await administrator.json(`/api/catalog/products/${product.id}`, { expectedVersion: product.version, sku: low.sku, acquisitionCost: "999.0000" }, "PATCH")).status, 409);
      const current = await item<ProductDTO>(await administrator.request(`/api/catalog/products/${product.id}`), 200);
      assert.equal(current.acquisitionCost, product.acquisitionCost);
      assert.equal(current.version, product.version);
      assert.equal((await list<ProductValueDTO>(administrator, `/api/catalog/products/${product.id}/values`)).total, 4);
      assert.equal((await fixture.query('SELECT count(*)::int AS n FROM audit_events WHERE entity_id=$1', [product.id])).rows[0].n, before);
    });
    await check("edições concorrentes aceitam uma única versão", async () => {
      const responses = await Promise.all(["Concorrente A", "Concorrente B"].map((name) => administrator.json(`/api/catalog/products/${product.id}`, { expectedVersion: product.version, name }, "PATCH")));
      assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
      const accepted = responses.find((response) => response.status === 200)!;
      const beforeVersion = product.version;
      product = await item<ProductDTO>(accepted, 200);
      assert.equal(product.version, beforeVersion + 1);
      assert.ok(["Concorrente A", "Concorrente B"].includes(product.name));
    });
    await check("referências inativas existentes são preservadas na edição", async () => {
      category = await item(await administrator.json(`/api/catalog/categories/${category.id}`, { expectedVersion: category.version, isActive: false }, "PATCH"), 200);
      supplier = await item(await administrator.json(`/api/catalog/suppliers/${supplier.id}`, { expectedVersion: supplier.version, isActive: false }, "PATCH"), 200);
      product = await item(await administrator.json(`/api/catalog/products/${product.id}`, { expectedVersion: product.version, description: "Associação preservada" }, "PATCH"), 200);
      assert.equal(product.category.id, category.id);
      assert.equal(product.defaultSupplier?.id, supplier.id);
      assert.equal(product.category.isActive, false);
    });
    await check("inativação preserva saldo e histórico; reativação exige referências ativas", async () => {
      product = await item(await administrator.json(`/api/catalog/products/${product.id}`, { expectedVersion: product.version, isActive: false }, "PATCH"), 200);
      assert.equal(product.isActive, false);
      assert.equal(product.quantity, "0.0000");
      assert.equal((await list<ProductValueDTO>(administrator, `/api/catalog/products/${product.id}/values`)).total, 4);
      assert.equal((await administrator.json(`/api/catalog/products/${product.id}`, { expectedVersion: product.version, isActive: true }, "PATCH")).status, 400);
      assert.equal((await list<ProductDTO>(administrator, "/api/catalog/products?status=inactive")).items[0]?.id, product.id);
      category = await item(await administrator.json(`/api/catalog/categories/${category.id}`, { expectedVersion: category.version, isActive: true }, "PATCH"), 200);
      supplier = await item(await administrator.json(`/api/catalog/suppliers/${supplier.id}`, { expectedVersion: supplier.version, isActive: true }, "PATCH"), 200);
      product = await item(await administrator.json(`/api/catalog/products/${product.id}`, { expectedVersion: product.version, isActive: true }, "PATCH"), 200);
      assert.equal(product.isActive, true);
    });
    await check("exclusão física não está disponível", async () => {
      for (const [kind, id] of [["products", product.id], ["categories", category.id], ["suppliers", supplier.id], ["customers", customer.id]]) assert.equal((await administrator.request(`/api/catalog/${kind}/${id}`, { method: "DELETE", headers: { Origin: base } })).status, 405);
    });
    await check("histórico e auditoria preservam autoria sem credenciais", async () => {
      const audits = await fixture.query("SELECT action,module,actor_id,new_values,previous_values FROM audit_events WHERE module IN ('PRODUCTS','CATEGORIES','SUPPLIERS','CUSTOMERS')");
      assert.ok(audits.rows.some((entry) => entry.action === "CREATE" && entry.module === "PRODUCTS"));
      assert.ok(audits.rows.some((entry) => entry.action === "DEACTIVATE"));
      assert.ok(audits.rows.some((entry) => entry.action === "ACTIVATE"));
      assert.ok(audits.rows.every((entry) => [administratorId, operatorId].includes(entry.actor_id)));
      assert.doesNotMatch(JSON.stringify(audits.rows), /password_hash|passwordHash|tokenHash|access_token|refresh_token/);
      assert.equal(JSON.stringify(audits.rows).includes(password), false);
    });
    await check("histórico novo continua imutável no PostgreSQL", async () => {
      const before = await fixture.query('SELECT id,new_value::text FROM product_value_history WHERE product_id=$1 ORDER BY id', [product.id]);
      let refused = false;
      try { await fixture.query('UPDATE product_value_history SET new_value=999 WHERE product_id=$1', [product.id]); }
      catch (error) { refused = typeof error === "object" && error !== null && "code" in error && error.code === "55000"; }
      assert.equal(refused, true);
      assert.deepEqual((await fixture.query('SELECT id,new_value::text FROM product_value_history WHERE product_id=$1 ORDER BY id', [product.id])).rows, before.rows);
    });
    await check("revogação enquanto o ator espera o lock impede a escrita", async () => {
      let transactionOpen = false;
      let pending: Promise<Response> | undefined;
      try {
        await fixture.query("BEGIN");
        transactionOpen = true;
        await fixture.query("SELECT pg_advisory_xact_lock(2026103002)");
        pending = operator.json("/api/catalog/categories", { name: "Escrita revogada" });
        // Observe rejection immediately, while still awaiting the controlled lock.
        void pending.catch(() => {});
        let waiting = false;
        for (let attempt = 0; attempt < 60; attempt++) {
          const activity = await admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1 AND usename='prevision_app' AND state='active' AND wait_event_type='Lock' AND wait_event='advisory'", [databaseName]);
          waiting = activity.rows[0].n > 0;
          if (waiting) break;
          await delay(50);
        }
        assert.equal(waiting, true);
        await fixture.query('UPDATE users SET is_active=false,session_version=session_version+1,updated_at=now() WHERE id=$1', [operatorId]);
        await fixture.query('UPDATE login_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [operatorId]);
        await fixture.query("COMMIT");
        transactionOpen = false;
        assert.equal((await pending).status, 401);
        assert.equal((await fixture.query('SELECT count(*)::int AS n FROM categories WHERE name=$1', ["Escrita revogada"])).rows[0].n, 0);
        assert.equal((await operator.json("/api/catalog/categories", { name: "Escrita após revogação" })).status, 401);
      } finally {
        if (transactionOpen) await fixture.query("ROLLBACK").catch(() => {});
        await pending?.catch(() => {});
      }
    });
    console.info(`${checked} verificações de catálogo aprovadas em banco e servidor descartáveis: cadastros, filtros, precisão, histórico, auditoria, concorrência, RBAC e CSRF.`);
  } catch (error) {
    console.error(`Integração de catálogo interrompida em: ${currentCheck}. Dados sensíveis foram omitidos.`);
    if (error instanceof assert.AssertionError && ["number", "boolean"].includes(typeof error.actual) && ["number", "boolean"].includes(typeof error.expected)) {
      console.error(`Resultado recebido: ${String(error.actual)}; esperado: ${String(error.expected)}.`);
    }
    for (const diagnostic of diagnostics) console.error(diagnostic);
    process.exitCode = 1;
  } finally {
    await stopServer(server);
    if (connectedFixture) await fixture.end().catch(() => {});
    if (created) {
      const result = await admin.query("SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=$1", [databaseName]).catch(() => null);
      if (result?.rows[0]?.marker === marker && /^prevision_catalog_test_[0-9a-f]{12}$/.test(databaseName)) {
        await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`).catch(() => { console.error("Não foi possível remover o banco descartável criado por esta execução."); process.exitCode = 1; });
      } else { console.error("Marcador divergente; limpeza do banco descartável interrompida."); process.exitCode = 1; }
    }
    await admin.end().catch(() => {});
  }
}

integration().catch(() => {
  console.error("Não foi possível preparar a integração local de catálogo. Verifique o banco local, a porta 3011 e o build; detalhes privados omitidos.");
  process.exitCode = 1;
});
