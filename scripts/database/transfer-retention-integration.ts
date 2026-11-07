import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "pg";
import { config } from "dotenv";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "../../src/generated/prisma/client.ts";
import { assertDatabaseIdentity, assertLocalDevelopmentDatabase, readEnvironment } from "../../src/server/config/environment.ts";
import { purgeExpiredTransferPayloads, reserveTransferPayload } from "../../src/server/transfers/retention.ts";

config({ path: ".env", quiet: true });
async function integration() {
  assert.equal(process.argv.length, 2);
  const environment = readEnvironment(); assertLocalDevelopmentDatabase(environment); assert.ok(environment.DIRECT_URL);
  const suffix = randomBytes(6).toString("hex"); const name = `prevision_retention_test_${suffix}`;
  assert.match(name, /^prevision_retention_test_[0-9a-f]{12}$/u);
  const marker = `prevision-retention-integration-${randomUUID()}`;
  const administrativeUrl = new URL(environment.DIRECT_URL); const runtimeUrl = new URL(environment.DATABASE_URL);
  administrativeUrl.pathname = runtimeUrl.pathname = `/${name}`;
  const source = new Client({ connectionString: environment.DIRECT_URL, connectionTimeoutMillis: 5000 });
  const fixture = new Client({ connectionString: administrativeUrl.href, connectionTimeoutMillis: 5000 });
  const runtime = new PrismaClient({ adapter: new PrismaPg({ connectionString: runtimeUrl.href, max: 4, connectionTimeoutMillis: 5000 }) });
  const ownerId = randomUUID(); const otherId = randomUUID(); const roleId = randomUUID();
  const expiredExport = randomUUID(); const liveExport = randomUUID(); const expiredImport = randomUUID(); const completedImport = randomUUID();
  let created = false; let connected = false; let checked = 0; let current = "preparo do banco descartável";
  const check = async (label: string, work: () => unknown | Promise<unknown>) => { current = label; await work(); checked++; };
  const errorCode = async (query: string, parameters: unknown[], expected: string) => {
    let received: unknown;
    try { await fixture.query(query, parameters); } catch (error) { received = (error as { code?: unknown }).code; }
    assert.equal(received, expected);
  };
  const transaction = <T>(work: (tx: Prisma.TransactionClient) => Promise<T>) => runtime.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(2026103002)`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(2026103003)`;
    return work(tx);
  }, { isolationLevel: "ReadCommitted", maxWait: 5000, timeout: 15000 });
  const addExport = (id: string, owner: string, expired = false, payload: unknown = { value: "fixture" }) => fixture.query(`INSERT INTO report_exports(id,owner_id,kind,payload,row_count,created_at,expires_at,operation_id)
    VALUES($1,$2,'stock',$3,1,clock_timestamp()-interval '2 minutes',clock_timestamp()+$4::interval,$5)`, [id, owner, payload, expired ? "-1 minute" : "30 minutes", randomUUID()]);
  const addImport = (id: string, completed: boolean) => fixture.query(`INSERT INTO product_imports(id,owner_id,file_name,format,data_hash,status,payload,row_count,error_count,created_count,created_at,expires_at,completed_at,confirmation_key,operation_id)
    VALUES($1,$2,'fixture.csv','csv',$3,$4,$5,1,0,$6,clock_timestamp()-interval '2 minutes',clock_timestamp()-interval '1 minute',$7,$8,$9)`,
    [id, ownerId, randomBytes(32).toString("hex"), completed ? "COMPLETED" : "PREVIEW", { version: 1, rows: [{ rowNumber: 2, data: { name: "Fixture" }, errors: [] }] }, completed ? 1 : 0, completed ? new Date() : null, completed ? randomUUID() : null, randomUUID()]);
  const retainedCount = async () => (await fixture.query("SELECT count(*)::int AS count FROM report_exports WHERE owner_id=$1 AND payload<>'{}'::jsonb", [ownerId])).rows[0].count;
  try {
    await source.connect();
    assertDatabaseIdentity(environment, (await source.query('SELECT environment,database_id AS "databaseId" FROM environment_sentinel WHERE id=$1', ["primary"])).rows[0] ?? null);
    await source.query(`CREATE DATABASE "${name}"`); created = true;
    await source.query(`COMMENT ON DATABASE "${name}" IS '${marker}'`);
    await fixture.connect(); connected = true;
    for (const migration of (await readdir(resolve("prisma", "migrations"))).filter((value) => /^\d+_/u.test(value)).sort()) await fixture.query(await readFile(resolve("prisma", "migrations", migration, "migration.sql"), "utf8"));
    await fixture.query("INSERT INTO environment_sentinel(id,environment,database_id) VALUES('primary','test',$1)", [marker]);
    await fixture.query("INSERT INTO roles(id,code,name,updated_at) VALUES($1,'OPERATOR','Operador',now())", [roleId]);
    for (const id of [ownerId, otherId]) await fixture.query("INSERT INTO users(id,name,email,role_id,updated_at) VALUES($1,'Fixture',$2,$3,now())", [id, `${id}@example.invalid`, roleId]);
    await addExport(expiredExport, ownerId, true); await addExport(liveExport, ownerId);
    await addImport(expiredImport, false); await addImport(completedImport, true);
    const before = (await fixture.query("SELECT id,(to_jsonb(e)-'payload') AS metadata FROM report_exports e ORDER BY id")).rows;
    await check("runtime expurga somente conteúdo expirado e preserva metadados/histórico", async () => {
      assert.equal(await transaction(purgeExpiredTransferPayloads), 2);
      assert.deepEqual((await fixture.query("SELECT id,(to_jsonb(e)-'payload') AS metadata FROM report_exports e ORDER BY id")).rows, before);
      assert.deepEqual((await fixture.query("SELECT payload FROM report_exports WHERE id=$1", [expiredExport])).rows[0].payload, {});
      assert.deepEqual((await fixture.query("SELECT payload FROM product_imports WHERE id=$1", [expiredImport])).rows[0].payload, {});
      assert.ok((await fixture.query("SELECT payload FROM product_imports WHERE id=$1", [completedImport])).rows[0].payload.rows.length);
      assert.deepEqual((await fixture.query("SELECT payload FROM report_exports WHERE id=$1", [liveExport])).rows[0].payload, { value: "fixture" });
      assert.equal(await transaction(purgeExpiredTransferPayloads), 0);
    });
    await check("triggers mantêm payload vivo, metadados, exclusões e histórico concluído imutáveis", async () => {
      await errorCode("UPDATE report_exports SET payload='{}' WHERE id=$1", [liveExport], "55000");
      await errorCode("UPDATE report_exports SET kind='audit' WHERE id=$1", [expiredExport], "55000");
      await errorCode("DELETE FROM report_exports WHERE id=$1", [expiredExport], "55000");
      await errorCode("DELETE FROM product_imports WHERE id=$1", [expiredImport], "55000");
      await errorCode("UPDATE product_imports SET payload='{}' WHERE id=$1", [completedImport], "55000");
      await errorCode("UPDATE report_exports SET payload=$2 WHERE id=$1", [expiredExport, { restored: true }], "55000");
    });
    await check("quota conta também conteúdo expirado antes de sua limpeza", async () => {
      for (let index = 0; index < 98; index++) await addExport(randomUUID(), ownerId);
      await addExport(randomUUID(), ownerId, true);
      assert.equal(await retainedCount(), 100);
      await assert.rejects(transaction((tx) => reserveTransferPayload(tx, ownerId, { value: "new" })), (error: unknown) => (error as { code?: string }).code === "VALIDATION");
      assert.equal(await transaction(purgeExpiredTransferPayloads), 1);
      assert.equal(await retainedCount(), 99);
    });
    await check("duas transações concorrentes não ultrapassam a última vaga do ator", async () => {
      const create = () => transaction(async (tx) => {
        const payload = { value: "last-slot" }; await reserveTransferPayload(tx, ownerId, payload);
        await tx.$executeRaw`INSERT INTO report_exports(id,owner_id,kind,payload,row_count,created_at,expires_at,operation_id)
          VALUES(${randomUUID()}::uuid,${ownerId}::uuid,'stock',${JSON.stringify(payload)}::jsonb,1,clock_timestamp(),clock_timestamp()+interval '30 minutes',${randomUUID()}::uuid)`;
      });
      const result = await Promise.allSettled([create(), create()]);
      assert.equal(result.filter((value) => value.status === "fulfilled").length, 1);
      assert.equal(result.filter((value) => value.status === "rejected").length, 1);
      assert.equal(await retainedCount(), 100);
    });
    await check("limite de bytes usa tamanho JSONB real e não a compressão do armazenamento", async () => {
      for (let index = 0; index < 5; index++) await fixture.query(`INSERT INTO report_exports(id,owner_id,kind,payload,row_count,created_at,expires_at,operation_id)
        VALUES($1,$2,'stock',jsonb_build_object('padding',repeat('x',7*1024*1024)),1,clock_timestamp(),clock_timestamp()+interval '30 minutes',$3)`, [randomUUID(), otherId, randomUUID()]);
      await assert.rejects(transaction((tx) => reserveTransferPayload(tx, otherId, { value: "new" })), (error: unknown) => (error as { code?: string }).code === "VALIDATION");
    });
    await check("lotes de limpeza são limitados e confirmam progresso sem apagar registros", async () => {
      await fixture.query(`INSERT INTO report_exports(id,owner_id,kind,payload,row_count,created_at,expires_at,operation_id)
        SELECT gen_random_uuid(),$1,'stock','{"old":true}'::jsonb,1,clock_timestamp()-interval '2 minutes',clock_timestamp()-interval '1 minute',gen_random_uuid() FROM generate_series(1,150)`, [otherId]);
      const total = (await fixture.query("SELECT count(*)::int AS count FROM report_exports")).rows[0].count;
      assert.equal(await transaction(purgeExpiredTransferPayloads), 100);
      // Quota still refuses the large live payload, but the prior cleanup is
      // already committed and is not undone by this failed creation.
      await assert.rejects(transaction((tx) => reserveTransferPayload(tx, otherId, {})));
      assert.equal(await transaction(purgeExpiredTransferPayloads), 50);
      assert.equal(await transaction(purgeExpiredTransferPayloads), 0);
      assert.equal((await fixture.query("SELECT count(*)::int AS count FROM report_exports")).rows[0].count, total);
    });
    console.info(`${checked} verificações de retenção aprovadas em banco descartável: expiração, imutabilidade, quotas, corrida concorrente, bytes e progresso por lote.`);
  } catch (error) {
    console.error(`Integração de retenção interrompida em: ${current}. Dados privados foram omitidos.`);
    if (error instanceof Error) { const position = /transfer-retention-integration\.ts:(\d+):(\d+)/u.exec(error.stack ?? ""); if (position) console.error(`Local: linha ${position[1]}, coluna ${position[2]}.`); }
    process.exitCode = 1;
  } finally {
    await runtime.$disconnect().catch(() => {}); if (connected) await fixture.end().catch(() => {});
    if (created) {
      const identity = (await source.query("SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=$1", [name]).catch(() => null))?.rows[0]?.marker;
      if (identity === marker && /^prevision_retention_test_[0-9a-f]{12}$/u.test(name)) await source.query(`DROP DATABASE "${name}" WITH(FORCE)`).catch(() => { console.error("Não foi possível remover o banco descartável da retenção."); process.exitCode = 1; });
      else { console.error("Marcador divergente; limpeza interrompida."); process.exitCode = 1; }
    }
    await source.end().catch(() => {});
  }
}
integration().catch(() => { console.error("Não foi possível preparar a integração de retenção. Confira o banco local e as migrations; detalhes privados omitidos."); process.exitCode = 1; });
