import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "pg";
import { config } from "dotenv";
import { assertDatabaseIdentity, assertLocalDevelopmentDatabase, readEnvironment } from "../../src/server/config/environment.ts";
import { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS } from "../../src/server/authorization/permissions.ts";
import { hashPassword, verifyPassword } from "../../src/server/security/password.ts";
import { fixed, movementTotal, scaled4 } from "../../src/server/stock/calculations.ts";

config({ path: ".env", quiet: true });
const targetPattern = /^prevision_(?:recovery|restore)_test_[0-9a-f]{12}$/u;
const markerPattern = /^prevision-recovery-integration-[0-9a-f-]{36}$/u;

/** Names are generated internally, never received as CLI target arguments. */
function assertTarget(name: string, marker: string) {
  assert.match(name, targetPattern); assert.match(marker, markerPattern);
  assert.notEqual(name, "prevision_dev");
}

/** Buffer only fixture data. Tool diagnostics are deliberately not forwarded. */
function runTool(args: string[], input?: Buffer): Promise<Buffer> {
  return new Promise((accept, reject) => {
    const child = spawn("docker", args, { windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = []; let length = 0; let finished = false;
    const finish = (error?: Error) => {
      if (finished) return; finished = true; clearTimeout(timer);
      if (error) { child.kill(); reject(error); } else accept(Buffer.concat(chunks));
    };
    const timer = setTimeout(() => finish(new Error("A ferramenta PostgreSQL excedeu o tempo de teste.")), 60000);
    child.on("error", () => finish(new Error("Não foi possível iniciar a ferramenta de recuperação.")));
    child.stdout.on("data", (chunk: Buffer) => {
      length += chunk.length;
      if (length > 64 * 1024 * 1024) finish(new Error("O backup de teste excedeu seu limite de tamanho."));
      else chunks.push(chunk);
    });
    child.stderr.resume();
    child.stdin.on("error", () => { /* Failure is reported by the child's exit status. */ });
    child.on("close", (code) => finish(code === 0 ? undefined : new Error("A ferramenta de recuperação recusou a operação de teste.")));
    child.stdin.end(input);
  });
}

type Fingerprint = Record<string, { count: number; sha256: string }>;
async function fingerprint(client: Client): Promise<Fingerprint> {
  const result: Fingerprint = {};
  const tables = await client.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
  for (const { tablename } of tables.rows) {
    assert.match(tablename, /^[a-z_][a-z0-9_]*$/u);
    const rows = await client.query<{ value: string }>(`SELECT row_to_json(t)::text AS value FROM public."${tablename}" t ORDER BY row_to_json(t)::text COLLATE "C"`);
    result[tablename] = { count: rows.rows.length, sha256: createHash("sha256").update(rows.rows.map((row) => row.value).join("\n")).digest("hex") };
  }
  return result;
}

function canonicalSchemaDefinition(value: string) {
  // pg_dump deparses varchar-literal arrays cast to text[]; restoration parses
  // that expression as an ARRAY whose literals are each cast to text. Those
  // two expressions are equivalent. Normalize only this exact cast shape,
  // preserving every literal, operator, column, and all other definitions.
  // The same deparse/parse transition also occurs in partial-index predicates.
  if (!value.startsWith("constraint:") && !value.startsWith("index:")) return value;
  const literals = String.raw`'(?:[^']|'')*'::character varying`;
  const castArray = new RegExp(String.raw`\(ARRAY\[(${literals}(?:, ${literals})*)\]\)::text\[\]`, "gu");
  let canonical = value.replace(castArray, (_match, contents: string) => {
    const entries = contents.match(new RegExp(literals, "gu"))!;
    return `ARRAY[${entries.map((entry) => `(${entry})::text`).join(", ")}]`;
  });
  if (canonical.startsWith("constraint:password_reset_jobs:password_reset_jobs_shape_check:CHECK ")) {
    // BETWEEN is expanded to two bounds. On restore, PostgreSQL flattens
    // their nested AND when it is itself an operand of AND. Restrict that
    // associative rewrite to this range followed by its payload regex,
    // retaining both bounds and the regex predicate without alteration.
    canonical = canonical.replace(/\(\(\(length\(payload\) >= (\d+)\) AND \(length\(payload\) <= (\d+)\)\) AND \(payload ~ /gu,
      "((length(payload) >= $1) AND (length(payload) <= $2) AND (payload ~ ");
  }
  return canonical;
}

async function schemaFingerprint(client: Client) {
  const result = await client.query<{ value: string }>(`SELECT value FROM (
    SELECT 'constraint:'||c.conrelid::regclass::text||':'||c.conname||':'||pg_get_constraintdef(c.oid) AS value
      FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public'
    UNION ALL SELECT 'trigger:'||pg_get_triggerdef(t.oid) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal
    UNION ALL SELECT 'index:'||indexdef FROM pg_indexes WHERE schemaname='public'
    UNION ALL SELECT 'function:'||pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f'
  ) definitions ORDER BY value COLLATE "C"`);
  return result.rows.map((row) => canonicalSchemaDefinition(row.value));
}

async function expectDatabaseError(work: () => Promise<unknown>, expected: string) {
  let code: unknown;
  try { await work(); } catch (error) { code = error && typeof error === "object" && "code" in error ? error.code : undefined; }
  assert.equal(code, expected);
}

async function assertLedger(client: Client) {
  const mismatches = await client.query<{ count: number }>(`SELECT count(*)::int AS count FROM stock_balances b
    WHERE b.quantity<>(SELECT coalesce(sum(quantity_delta),0) FROM stock_movements WHERE product_id=b.product_id)`);
  assert.equal(mismatches.rows[0].count, 0);
  const invalidCompensations = await client.query<{ count: number }>(`SELECT count(*)::int AS count FROM stock_movements m
    JOIN stock_movements original ON original.id=m.compensates_movement_id WHERE m.type='COMPENSATION'
      AND (m.product_id<>original.product_id OR m.quantity_delta<>-original.quantity_delta
        OR m.historical_unit_cost<>original.historical_unit_cost OR m.historical_total_cost<>original.historical_total_cost)`);
  assert.equal(invalidCompensations.rows[0].count, 0);
}

async function integration() {
  assert.equal(process.argv.length, 2, "O teste não aceita URLs, nomes ou destinos fornecidos por argumentos.");
  const environment = readEnvironment(); assertLocalDevelopmentDatabase(environment); assert.ok(environment.DIRECT_URL);
  const adminUrl = new URL(environment.DIRECT_URL); const runtimeUrl = new URL(environment.DATABASE_URL);
  assert.equal(adminUrl.host, runtimeUrl.host); assert.equal(decodeURIComponent(runtimeUrl.username), "prevision_app");
  const username = process.env.POSTGRES_USER ?? "";
  assert.match(username, /^[a-z_][a-z0-9_]{0,62}$/u); assert.equal(username, decodeURIComponent(adminUrl.username));
  const suffix = randomBytes(6).toString("hex");
  const sourceName = `prevision_recovery_test_${suffix}`; const restoredName = `prevision_restore_test_${suffix}`;
  const marker = `prevision-recovery-integration-${randomUUID()}`;
  assertTarget(sourceName, marker); assertTarget(restoredName, marker);
  const admin = new Client({ connectionString: adminUrl.href, connectionTimeoutMillis: 5000 });
  const clients = new Set<Client>(); const created: string[] = [];
  const connect = async (name: string, runtime = false) => {
    assertTarget(name, marker);
    const url = new URL(runtime ? runtimeUrl : adminUrl); url.pathname = `/${name}`;
    const client = new Client({ connectionString: url.href, connectionTimeoutMillis: 5000 });
    await client.connect(); await client.query("SET TIME ZONE 'UTC'"); clients.add(client); return client;
  };
  let checked = 0; let currentCheck = "preparo da recuperação descartável";
  const check = async (name: string, work: () => unknown | Promise<unknown>) => { currentCheck = name; await work(); checked++; };
  const actorId = randomUUID(); const categoryId = randomUUID(); const supplierId = randomUUID(); const customerId = randomUUID();
  const productId = randomUUID(); const inventoryId = randomUUID(); const auditId = randomUUID(); const operationKey = `recovery:${randomUUID()}`;
  const password = `Recovery-${randomBytes(24).toString("hex")}`;
  const timestamp = new Date(Date.now() - 60 * 86400000).toISOString();
  const append = async (client: Client, type: "ENTRY" | "EXIT" | "COMPENSATION", delta: string, key: string, compensates: string | null = null) => {
    const balance = await client.query<{ quantity: string }>('SELECT quantity::text FROM stock_balances WHERE product_id=$1 FOR UPDATE', [productId]);
    const before = balance.rows[0].quantity; const after = fixed(scaled4(before) + scaled4(delta), 4); const id = randomUUID();
    const absolute = delta.replace(/^-/, ""); const hash = createHash("sha256").update(`${type}:${delta}:${key}`).digest("hex");
    await client.query(`INSERT INTO stock_movements(id,product_id,type,quantity_delta,quantity_before,quantity_after,historical_unit_cost,historical_total_cost,
      historical_unit_price,historical_total_price,performed_by_id,occurred_at,operation_id,idempotency_key,request_hash,justification,compensates_movement_id)
      VALUES($1,$2,$3,$4,$5,$6,'2.5000',$7,$8,$9,$10,now(),$11,$12,$13,$14,$15)`,
    [id, productId, type, delta, before, after, movementTotal(absolute, "2.5000"), type === "ENTRY" ? null : "5.0000", type === "ENTRY" ? null : movementTotal(absolute, "5.0000"),
      actorId, randomUUID(), key, hash, type === "COMPENSATION" ? "Compensação da fixture descartável" : null, compensates]);
    await client.query('UPDATE stock_balances SET quantity=$2,version=version+1,updated_at=now() WHERE product_id=$1', [productId, after]);
    return id;
  };
  try {
    await admin.connect();
    assertDatabaseIdentity(environment, (await admin.query('SELECT environment,database_id AS "databaseId" FROM environment_sentinel WHERE id=$1', ["primary"])).rows[0] ?? null);
    await check("destinos de desenvolvimento e marcadores divergentes são recusados", () => {
      assert.throws(() => assertTarget("prevision_dev", marker)); assert.throws(() => assertTarget(sourceName, "prevision-local-development"));
      assert.throws(() => assertTarget(`other_${suffix}`, marker));
    });
    const container = (await runTool(["compose", "ps", "-q", "db"])).toString("utf8").trim();
    assert.match(container, /^[0-9a-f]{12,64}$/u);
    const bindings = JSON.parse((await runTool(["inspect", "--format", "{{json .NetworkSettings.Ports}}", container])).toString("utf8")) as Record<string, { HostIp: string; HostPort: string }[] | null>;
    assert.ok(bindings["5432/tcp"]?.some((binding) => ["127.0.0.1", "::1"].includes(binding.HostIp) && binding.HostPort === adminUrl.port), "O contêiner deve servir exatamente a porta do banco local verificado.");
    for (const name of [sourceName, restoredName]) {
      assertTarget(name, marker); await admin.query(`CREATE DATABASE "${name}"`); created.push(name);
      await admin.query(`COMMENT ON DATABASE "${name}" IS '${marker}'`);
    }
    const source = await connect(sourceName);
    assert.equal(Math.floor(Number((await source.query("SHOW server_version_num")).rows[0].server_version_num) / 10000), 17);
    for (const name of (await readdir(resolve("prisma", "migrations"))).filter((value) => /^\d+_/u.test(value)).sort()) await source.query(await readFile(resolve("prisma", "migrations", name, "migration.sql"), "utf8"));
    await source.query('INSERT INTO environment_sentinel(id,environment,database_id) VALUES($1,$2,$3)', ["primary", "test", marker]);
    const roleIds = new Map<string, string>();
    for (const code of ["ADMINISTRATOR", "MANAGER", "OPERATOR"] as const) { const id = randomUUID(); roleIds.set(code, id); await source.query('INSERT INTO roles(id,code,name,updated_at) VALUES($1,$2,$3,now())', [id, code, code]); }
    for (const code of PERMISSIONS) {
      const id = randomUUID(); await source.query('INSERT INTO permissions(id,code) VALUES($1,$2)', [id, code]);
      for (const [role, defaults] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) if ((defaults as readonly string[]).includes(code)) await source.query('INSERT INTO role_permissions(role_id,permission_id) VALUES($1,$2)', [roleIds.get(role), id]);
    }
    await source.query('INSERT INTO users(id,name,email,password_hash,role_id,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$6)', [actorId, "Operador de recuperação", `recovery.${suffix}@example.invalid`, await hashPassword(password), roleIds.get("OPERATOR"), timestamp]);
    await source.query('INSERT INTO categories(id,name,updated_at) VALUES($1,$2,now())', [categoryId, "Recuperação descartável"]);
    await source.query('INSERT INTO suppliers(id,name,updated_at) VALUES($1,$2,now())', [supplierId, "Fornecedor descartável"]);
    await source.query('INSERT INTO customers(id,name,updated_at) VALUES($1,$2,now())', [customerId, "Cliente descartável"]);
    await source.query('INSERT INTO products(id,sku,name,category_id,default_supplier_id,acquisition_cost,sale_price,minimum_stock,replenishment_lead_time_days,created_at,updated_at) VALUES($1,$2,$3,$4,$5,2.5,5,3,5,$6,$6)', [productId, `RECOVERY-${suffix}`.toUpperCase(), "Produto descartável", categoryId, supplierId, timestamp]);
    await source.query('INSERT INTO stock_balances(product_id,quantity,updated_at) VALUES($1,0,now())', [productId]);
    for (const [type, value] of [["ACQUISITION_COST", "2.5000"], ["SALE_PRICE", "5.0000"]]) await source.query('INSERT INTO product_value_history(id,product_id,type,new_value,changed_by_id,operation_id,effective_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$7)', [randomUUID(), productId, type, value, actorId, randomUUID(), timestamp]);
    await source.query("BEGIN");
    try {
      await append(source, "ENTRY", "10.0000", `recovery:${randomUUID()}`);
      const exit = await append(source, "EXIT", "-2.0000", `recovery:${randomUUID()}`);
      await append(source, "COMPENSATION", "2.0000", `recovery:${randomUUID()}`, exit);
      await source.query('INSERT INTO audit_events(id,actor_id,action,module,entity_type,entity_id,operation_id,origin,new_values) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [auditId, actorId, "STOCK_ENTRY", "STOCK", "Product", productId, randomUUID(), "recovery-fixture", { quantity: "10.0000" }]);
      await source.query('INSERT INTO inventories(id,title,created_by_id) VALUES($1,$2,$3)', [inventoryId, "Inventário descartável", actorId]);
      await source.query('INSERT INTO inventory_items(inventory_id,product_id,name,sku,unit_of_measure,category_name,baseline_quantity,baseline_version,counted_quantity,counted_by_id,counted_at) SELECT $1,p.id,p.name,p.sku,p.unit_of_measure,c.name,b.quantity,b.version,b.quantity,$2,now() FROM products p JOIN categories c ON c.id=p.category_id JOIN stock_balances b ON b.product_id=p.id WHERE p.id=$3', [inventoryId, actorId, productId]);
      await source.query('UPDATE inventories SET status=$2,completed_at=now(),completed_by_id=$3,version=version+1 WHERE id=$1', [inventoryId, "COMPLETED", actorId]);
      await source.query('INSERT INTO inventory_operations(key,inventory_id,actor_id,kind,request_hash) VALUES($1,$2,$3,$4,$5)', [randomUUID(), inventoryId, actorId, "COMPLETE", "a".repeat(64)]);
      await source.query('INSERT INTO user_preferences(user_id,theme) VALUES($1,$2)', [actorId, "dark"]);
      await source.query('INSERT INTO notification_reads(notification_id,user_id) SELECT id,$1 FROM notifications ORDER BY created_at,id LIMIT 1', [actorId]);
      await source.query("COMMIT");
    } catch (error) { await source.query("ROLLBACK"); throw error; }
    await check("fixture mantém saldo, compensação e histórico consistentes", () => assertLedger(source));
    await check("erro de restrição reverte movimento, saldo, auditoria e notificações juntos", async () => {
      const before = await fingerprint(source); await source.query("BEGIN");
      await append(source, "ENTRY", "1.0000", `recovery:${randomUUID()}`);
      await source.query('INSERT INTO audit_events(id,actor_id,action,module,entity_type,entity_id,operation_id) VALUES($1,$2,$3,$4,$5,$6,$7)', [randomUUID(), actorId, "STOCK_ENTRY", "STOCK", "Product", productId, randomUUID()]);
      await expectDatabaseError(() => source.query('UPDATE stock_balances SET quantity=-1 WHERE product_id=$1', [productId]), "23514");
      await source.query("ROLLBACK"); assert.deepEqual(await fingerprint(source), before);
    });
    await check("desconectar antes do commit não deixa gravações parciais", async () => {
      const before = await fingerprint(source); const interrupted = await connect(sourceName, true);
      await interrupted.query("BEGIN"); await append(interrupted, "ENTRY", "1.0000", `recovery:${randomUUID()}`);
      await interrupted.end(); clients.delete(interrupted); assert.deepEqual(await fingerprint(source), before);
    });
    await check("commit confirmado permanece após reconexão e bloqueia chave repetida", async () => {
      const writer = await connect(sourceName, true); await writer.query("BEGIN"); await append(writer, "ENTRY", "1.0000", operationKey); await writer.query("COMMIT"); await writer.end(); clients.delete(writer);
      const reader = await connect(sourceName, true);
      assert.equal((await reader.query('SELECT count(*)::int AS count FROM stock_movements WHERE idempotency_key=$1', [operationKey])).rows[0].count, 1);
      await expectDatabaseError(() => append(reader, "ENTRY", "1.0000", operationKey), "23505");
      await assertLedger(reader); assert.equal((await reader.query('SELECT quantity::text FROM stock_balances WHERE product_id=$1', [productId])).rows[0].quantity, "11.0000");
      await reader.end(); clients.delete(reader);
    });
    const beforeBackup = await fingerprint(source); const beforeSchema = await schemaFingerprint(source);
    let backup: Buffer = Buffer.alloc(0);
    await check("pg_dump gera backup real somente do banco efêmero verificado", async () => {
      assertTarget(sourceName, marker);
      const identity = (await source.query('SELECT environment,database_id AS "databaseId" FROM environment_sentinel WHERE id=$1', ["primary"])).rows[0];
      assertDatabaseIdentity({ APP_ENV: "test", DATABASE_ID: marker }, identity);
      const dockerMarker = (await runTool(["exec", container, "psql", "--username", username, "--dbname", sourceName, "--tuples-only", "--no-align", "--command", "SELECT database_id FROM environment_sentinel WHERE id='primary'"])).toString("utf8").trim();
      assert.equal(dockerMarker, marker);
      backup = await runTool(["exec", container, "pg_dump", "--username", username, "--dbname", sourceName, "--format=custom", "--no-owner"]);
      assert.equal(backup.subarray(0, 5).toString("ascii"), "PGDMP"); assert.ok(backup.length > 1000);
    });
    await check("pg_restore recupera esquema, dados e permissões em outro banco efêmero", async () => {
      assertTarget(restoredName, marker);
      const catalogMarker = (await admin.query("SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=$1", [restoredName])).rows[0]?.marker;
      assert.equal(catalogMarker, marker);
      await runTool(["exec", "-i", container, "pg_restore", "--username", username, "--dbname", restoredName, "--no-owner", "--exit-on-error", "--single-transaction"], backup);
    });
    const restored = await connect(restoredName); const runtime = await connect(restoredName, true);
    await check("todas as tabelas recuperadas preservam contagens e hashes exatos", async () => assert.deepEqual(await fingerprint(restored), beforeBackup));
    await check("constraints, índices e triggers são recuperados sem desativação", async () => {
      const after = await schemaFingerprint(restored);
      assert.deepEqual(after, beforeSchema);
    });
    await check("sentinela restaurada aceita a identidade de teste e recusa desenvolvimento", async () => {
      const identity = (await runtime.query('SELECT environment,database_id AS "databaseId" FROM environment_sentinel WHERE id=$1', ["primary"])).rows[0];
      assertDatabaseIdentity({ APP_ENV: "test", DATABASE_ID: marker }, identity);
      assert.throws(() => assertDatabaseIdentity(environment, identity));
    });
    await check("hash da senha e permissões limitadas permanecem após a restauração", async () => {
      const user = (await runtime.query('SELECT password_hash FROM users WHERE id=$1', [actorId])).rows[0]; assert.equal(await verifyPassword(user.password_hash, password), true);
      const permissions = await runtime.query<{ code: string }>('SELECT p.code FROM permissions p JOIN role_permissions rp ON rp.permission_id=p.id JOIN users u ON u.role_id=rp.role_id WHERE u.id=$1 ORDER BY p.code', [actorId]);
      assert.deepEqual(permissions.rows.map((row) => row.code), [...DEFAULT_ROLE_PERMISSIONS.OPERATOR].sort());
      assert.equal(permissions.rows.some((row) => ["users.manage", "roles.manage", "stock.adjust"].includes(row.code)), false);
    });
    await check("runtime recuperado conserva leitura e inserção sem poder alterar históricos", async () => {
      const rights = (await runtime.query("SELECT has_table_privilege(current_user,'stock_movements','SELECT') AS read,has_table_privilege(current_user,'stock_movements','INSERT') AS append,has_table_privilege(current_user,'stock_movements','UPDATE') AS update,has_table_privilege(current_user,'stock_movements','DELETE') AS delete,has_table_privilege(current_user,'environment_sentinel','UPDATE') AS identify")).rows[0];
      assert.deepEqual(rights, { read: true, append: true, update: false, delete: false, identify: false });
      await expectDatabaseError(() => runtime.query('UPDATE stock_movements SET justification=$1 WHERE product_id=$2', ["Alteração proibida", productId]), "42501");
      await expectDatabaseError(() => runtime.query('DELETE FROM audit_events WHERE id=$1', [auditId]), "42501");
    });
    await check("triggers restaurados recusam alterações mesmo com a conexão administrativa", async () => {
      await expectDatabaseError(() => restored.query('UPDATE stock_movements SET justification=$1 WHERE product_id=$2', ["Alteração proibida", productId]), "55000");
      await expectDatabaseError(() => restored.query('UPDATE product_value_history SET new_value=new_value WHERE product_id=$1', [productId]), "55000");
      await expectDatabaseError(() => restored.query('DELETE FROM audit_events WHERE id=$1', [auditId]), "55000");
      await expectDatabaseError(() => restored.query('UPDATE inventories SET title=title WHERE id=$1', [inventoryId]), "55000");
      assert.deepEqual(await fingerprint(restored), beforeBackup);
    });
    await check("saldo, compensações e proteção contra reenvio sobrevivem ao backup", async () => {
      await assertLedger(runtime); await expectDatabaseError(() => append(runtime, "ENTRY", "1.0000", operationKey), "23505");
      await expectDatabaseError(() => runtime.query('UPDATE stock_balances SET quantity=-1 WHERE product_id=$1', [productId]), "23514");
      await expectDatabaseError(() => runtime.query('UPDATE user_preferences SET theme=$2,version=version+1,updated_at=clock_timestamp() WHERE user_id=$1', [actorId, "invalid"]), "23514");
      assert.deepEqual(await fingerprint(restored), beforeBackup);
    });
    await check("banco recuperado aceita uma nova transação válida sem afetar a origem", async () => {
      await runtime.query("BEGIN"); await append(runtime, "ENTRY", "1.0000", `recovery:${randomUUID()}`); await runtime.query("COMMIT");
      await assertLedger(runtime);
      assert.equal((await runtime.query('SELECT quantity::text FROM stock_balances WHERE product_id=$1', [productId])).rows[0].quantity, "12.0000");
      assert.deepEqual(await fingerprint(source), beforeBackup);
    });
    console.info(`${checked} verificações de recuperação aprovadas: rollback, desconexão, reconexão, pg_dump/pg_restore reais, hashes, permissões e integridade em bancos descartáveis.`);
    backup.fill(0);
  } catch (error) {
    console.error(`Integração de recuperação interrompida em: ${currentCheck}. Dados privados foram omitidos.`);
    if (error instanceof Error) { const position = /recovery-integration\.ts:(\d+):(\d+)/u.exec(error.stack ?? ""); if (position) console.error(`Local da verificação: linha ${position[1]}, coluna ${position[2]}.`); }
    process.exitCode = 1;
  } finally {
    for (const client of clients) await client.end().catch(() => {});
    for (const name of created.reverse()) {
      assertTarget(name, marker);
      const result = await admin.query("SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=$1", [name]).catch(() => null);
      if (result?.rows[0]?.marker === marker) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`).catch(() => { console.error("Não foi possível remover um banco descartável da recuperação."); process.exitCode = 1; });
      else { console.error("Marcador divergente; limpeza do banco de teste interrompida."); process.exitCode = 1; }
    }
    await admin.end().catch(() => {});
  }
}

integration().catch(() => { console.error("Não foi possível preparar a recuperação. Confira Docker, identidade do banco e ferramentas PostgreSQL 17; detalhes privados omitidos."); process.exitCode = 1; });
