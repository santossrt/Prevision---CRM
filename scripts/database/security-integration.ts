import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, readdir, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Client } from "pg";
import { config } from "dotenv";
import { assertDatabaseIdentity, assertLocalDevelopmentDatabase, readEnvironment } from "../../src/server/config/environment.ts";
import { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS } from "../../src/server/authorization/permissions.ts";
import { getDatabase } from "../../src/server/database/client.ts";
import { confirmPassword, hashAccessToken } from "../../src/server/auth/access-tokens.ts";
import { enqueuePasswordReset, processPasswordResetJobs, resetJobLimits } from "../../src/server/auth/password-reset-jobs.ts";
import { decryptResetJobEmail, encryptResetJobEmail } from "../../src/server/mail/job-crypto.ts";
import { hashPassword, verifyPassword } from "../../src/server/security/password.ts";

config({ path: ".env", quiet: true });
const targetPattern = /^prevision_security_test_[0-9a-f]{12}$/u;
const markerPattern = /^prevision-security-integration-[0-9a-f-]{36}$/u;
const mailDirectory = resolve(".cache", "mail-test");
const mailName = /^\d+-[0-9a-f-]+\.json$/u;
function assertTarget(name: string, marker: string) { assert.match(name, targetPattern); assert.match(marker, markerPattern); }
async function expectedDatabaseError(work: () => Promise<unknown>, expected: string) {
  let code: unknown;
  try { await work(); } catch (error) { code = error && typeof error === "object" && "code" in error ? error.code : undefined; }
  assert.equal(code, expected);
}
type Job = { id: string; payload: string | null; status: string; attempts: number; locked_by: string | null; lease_until: Date | null; processed_at: Date | null };
type Mail = { name: string; to: string; text: string };

/** A new Node process demonstrates recovery without the producer's memory. */
async function independentWorker(jobId: string) {
  const script = `import {processPasswordResetJobs} from './src/server/auth/password-reset-jobs.ts';
    import {getDatabase} from './src/server/database/client.ts';
    try { const r=await processPasswordResetJobs({limit:1,jobId:process.env.SECURITY_TEST_JOB});
      console.info(r.processed===1&&r.failed===0?'ok':'failed'); if(r.processed!==1||r.failed!==0)process.exitCode=1;
    } catch { console.info('failed');process.exitCode=1; } finally { await getDatabase().$disconnect().catch(()=>{}); }`;
  await new Promise<void>((accept, reject) => {
    const child = spawn(process.execPath, ["--conditions=react-server", "--input-type=module"], {
      cwd: process.cwd(), windowsHide: true, shell: false, stdio: ["pipe", "pipe", "ignore"],
      env: { ...process.env, NODE_ENV: "production", SECURITY_TEST_JOB: jobId }
    });
    let output = ""; let settled = false;
    const finish = (ok: boolean) => { if (settled) return; settled = true; clearTimeout(timer); if (ok) accept(); else { child.kill(); reject(new Error("O worker isolado não concluiu a solicitação de teste.")); } };
    const timer = setTimeout(() => finish(false), 20000);
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); if (output.length > 1024) finish(false); });
    child.on("error", () => finish(false)); child.stdin.on("error", () => {});
    child.on("close", (code) => finish(code === 0 && output.trim() === "ok")); child.stdin.end(script);
  });
}

async function integration() {
  assert.equal(process.argv.length, 2, "O teste não aceita destinos ou credenciais por argumentos.");
  const source = readEnvironment(); assertLocalDevelopmentDatabase(source); assert.ok(source.DIRECT_URL);
  assert.equal(new URL(source.DATABASE_URL).host, new URL(source.DIRECT_URL).host);
  assert.equal(decodeURIComponent(new URL(source.DATABASE_URL).username), "prevision_app");
  const suffix = randomBytes(6).toString("hex"); const databaseName = `prevision_security_test_${suffix}`;
  const marker = `prevision-security-integration-${randomUUID()}`; assertTarget(databaseName, marker);
  const adminUrl = new URL(source.DIRECT_URL); const runtimeUrl = new URL(source.DATABASE_URL); adminUrl.pathname = runtimeUrl.pathname = `/${databaseName}`;
  const admin = new Client({ connectionString: source.DIRECT_URL, connectionTimeoutMillis: 5000 });
  const fixture = new Client({ connectionString: adminUrl.href, connectionTimeoutMillis: 5000 });
  const runtime = new Client({ connectionString: runtimeUrl.href, connectionTimeoutMillis: 5000 });
  const accountId = randomUUID(); const email = `security.known.${suffix}@example.invalid`; const unknown = `security.unknown.${suffix}@example.invalid`;
  const testRecipients = new Set([email, unknown]); const ownedMailFiles = new Set<string>();
  const initialMail = new Set(await readdir(mailDirectory).catch(() => [] as string[]));
  const password = `Security-${randomBytes(20).toString("hex")}`;
  const original = new Map<string, string | undefined>();
  const configure = (key: string, value: string) => { if (!original.has(key)) original.set(key, process.env[key]); process.env[key] = value; };
  let created = false; let fixtureConnected = false; let runtimeConnected = false; let configured = false;
  let checked = 0; let currentCheck = "preparo da fila descartável";
  const check = async (name: string, work: () => unknown | Promise<unknown>) => { currentCheck = name; await work(); checked++; };
  const job = async (id: string) => { const value = (await fixture.query<Job>('SELECT id,payload,status,attempts,locked_by,lease_until,processed_at FROM password_reset_jobs WHERE id=$1', [id])).rows[0]; assert.ok(value); return value; };
  const tokens = async () => (await fixture.query<{ count: number }>('SELECT count(*)::int AS count FROM access_tokens')).rows[0].count;
  async function mails(): Promise<Mail[]> {
    const matching: Mail[] = [];
    for (const name of (await readdir(mailDirectory).catch(() => [] as string[])).filter((value) => !initialMail.has(value) && mailName.test(value))) {
      const value = JSON.parse(await readFile(resolve(mailDirectory, name), "utf8")) as { to?: unknown; text?: unknown };
      if (typeof value.to !== "string" || !testRecipients.has(value.to) || typeof value.text !== "string") continue;
      ownedMailFiles.add(name); matching.push({ name, to: value.to, text: value.text });
    }
    return matching;
  }
  const assertTerminal = async (id: string, status: "COMPLETED" | "FAILED", attempts?: number) => {
    const value = await job(id); assert.equal(value.status, status); assert.equal(value.payload, null); assert.equal(value.locked_by, null); assert.equal(value.lease_until, null); assert.ok(value.processed_at);
    if (attempts !== undefined) assert.equal(value.attempts, attempts);
  };
  async function insertFixtureJob(options: { email?: string; status?: "PENDING" | "PROCESSING" | "COMPLETED"; ageSeconds?: number; attempts?: number; payloadForAnotherId?: boolean } = {}) {
    const id = randomUUID(); const status = options.status ?? "PENDING"; const age = options.ageSeconds ?? 120;
    const payload = status === "COMPLETED" ? null : encryptResetJobEmail(options.payloadForAnotherId ? randomUUID() : id, options.email ?? email);
    await fixture.query(`INSERT INTO password_reset_jobs(id,payload,status,attempts,available_at,expires_at,locked_by,lease_until,processed_at,created_at)
      SELECT $1::uuid,$2::text,$3::varchar,$4::integer,t.created,t.created+interval '15 minutes',
        CASE WHEN $3::varchar='PROCESSING' THEN $5::uuid ELSE NULL END,
        CASE WHEN $3::varchar='PROCESSING' THEN t.now-interval '30 seconds' ELSE NULL END,
        CASE WHEN $3::varchar='COMPLETED' THEN t.created+interval '1 second' ELSE NULL END,t.created
      FROM(SELECT clock_timestamp() AS now,clock_timestamp()-interval '1 second'*$6::integer AS created)t`,
    [id, payload, status, options.attempts ?? (status === "PROCESSING" ? 1 : 0), randomUUID(), age]);
    return id;
  }

  try {
    await admin.connect();
    assertDatabaseIdentity(source, (await admin.query('SELECT environment,database_id AS "databaseId" FROM environment_sentinel WHERE id=$1', ["primary"])).rows[0] ?? null);
    await check("destinos e marcadores não pertencentes ao teste são recusados", () => {
      assert.throws(() => assertTarget("prevision_dev", marker)); assert.throws(() => assertTarget(databaseName, "prevision-local-development"));
    });
    await admin.query(`CREATE DATABASE "${databaseName}"`); created = true; await admin.query(`COMMENT ON DATABASE "${databaseName}" IS '${marker}'`);
    await fixture.connect(); fixtureConnected = true;
    for (const name of (await readdir(resolve("prisma", "migrations"))).filter((value) => /^\d+_/u.test(value)).sort()) await fixture.query(await readFile(resolve("prisma", "migrations", name, "migration.sql"), "utf8"));
    await fixture.query('INSERT INTO environment_sentinel(id,environment,database_id) VALUES($1,$2,$3)', ["primary", "test", marker]);
    const roles = new Map<string, string>();
    for (const role of ["ADMINISTRATOR", "MANAGER", "OPERATOR"] as const) { const id = randomUUID(); roles.set(role, id); await fixture.query('INSERT INTO roles(id,code,name,updated_at) VALUES($1,$2,$3,now())', [id, role, role]); }
    for (const permission of PERMISSIONS) {
      const id = randomUUID(); await fixture.query('INSERT INTO permissions(id,code) VALUES($1,$2)', [id, permission]);
      for (const [role, defaults] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) if ((defaults as readonly string[]).includes(permission)) await fixture.query('INSERT INTO role_permissions(role_id,permission_id) VALUES($1,$2)', [roles.get(role), id]);
    }
    await fixture.query('INSERT INTO users(id,name,email,password_hash,role_id,updated_at) VALUES($1,$2,$3,$4,$5,now())', [accountId, "Conferência de segurança", email, await hashPassword(password), roles.get("OPERATOR")]);
    for (const [key, value] of Object.entries({ APP_ENV: "test", DATABASE_ID: marker, DATABASE_URL: runtimeUrl.href, DIRECT_URL: adminUrl.href, AUTH_SECRET: randomBytes(48).toString("hex"), AUTH_URL: "http://127.0.0.1:3021", MAIL_TRANSPORT: "local", MAIL_FROM: "Prevision <test@example.invalid>", GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "", VERCEL: "", REQUEST_IP_HEADER: "", SMTP_HOST: "", SMTP_USER: "", SMTP_PASSWORD: "" })) configure(key, value);
    configured = true; await runtime.connect(); runtimeConnected = true;

    let unknownJob = ""; let knownJob = "";
    await check("solicitações conhecidas e desconhecidas têm o mesmo registro cifrado sem criar grants", async () => {
      unknownJob = await enqueuePasswordReset(unknown); knownJob = await enqueuePasswordReset(email);
      for (const [id, address] of [[unknownJob, unknown], [knownJob, email]]) {
        const value = await job(id); assert.equal(value.status, "PENDING"); assert.equal(value.attempts, 0); assert.ok(value.payload);
        assert.equal(value.payload.includes(address), false); assert.match(value.payload, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
        assert.equal(decryptResetJobEmail(id, value.payload), address);
      }
      assert.equal(await tokens(), 0); assert.equal((await mails()).length, 0);
    });
    await check("runtime não pode mudar o destinatário cifrado nem apagar trabalho ativo", async () => {
      await expectedDatabaseError(() => runtime.query('UPDATE password_reset_jobs SET payload=$2 WHERE id=$1', [knownJob, encryptResetJobEmail(knownJob, unknown)]), "55000");
      await expectedDatabaseError(() => runtime.query('DELETE FROM password_reset_jobs WHERE id=$1', [knownJob]), "55000");
      await expectedDatabaseError(() => runtime.query("INSERT INTO password_reset_jobs(id,payload,expires_at) VALUES($1,$2,clock_timestamp()+interval '15 minutes')", [randomUUID(), email]), "23514");
    });
    await check("destinatário desconhecido termina sem enviar mensagens ou emitir token", async () => {
      assert.deepEqual(await processPasswordResetJobs({ limit: 1, jobId: unknownJob }), { processed: 1, failed: 0 });
      await assertTerminal(unknownJob, "COMPLETED", 1); assert.equal(await tokens(), 0); assert.equal((await mails()).length, 0);
    });
    await check("destinatário elegível recebe link válido e o payload é apagado", async () => {
      assert.deepEqual(await processPasswordResetJobs({ limit: 1, jobId: knownJob }), { processed: 1, failed: 0 });
      await assertTerminal(knownJob, "COMPLETED", 1);
      const messages = (await mails()).filter((value) => value.to === email); assert.equal(messages.length, 1);
      const link = /http:\/\/127\.0\.0\.1:3021\/redefinir-senha\?token=([A-Za-z0-9_-]{43})/u.exec(messages[0].text); assert.ok(link);
      const token = link[1]; const grant = (await fixture.query('SELECT purpose,used_at,revoked_at FROM access_tokens WHERE token_hash=$1 AND user_id=$2', [hashAccessToken(token), accountId])).rows[0];
      assert.equal(grant.purpose, "PASSWORD_RESET"); assert.equal(grant.used_at, null); assert.equal(grant.revoked_at, null);
      const replacement = `Replacement-${randomBytes(20).toString("hex")}`;
      await confirmPassword(token, replacement, "PASSWORD_RESET");
      const user = (await fixture.query('SELECT password_hash,session_version FROM users WHERE id=$1', [accountId])).rows[0];
      assert.equal(await verifyPassword(user.password_hash, replacement), true); assert.equal(user.session_version, 1);
      await assert.rejects(() => confirmPassword(token, replacement, "PASSWORD_RESET"));
    });
    await check("workers concorrentes processam a mesma solicitação uma única vez", async () => {
      const id = await enqueuePasswordReset(email); const before = (await mails()).length;
      const result = await Promise.all([processPasswordResetJobs({ limit: 1, jobId: id }), processPasswordResetJobs({ limit: 1, jobId: id }), processPasswordResetJobs({ limit: 1, jobId: id })]);
      assert.equal(result.reduce((sum, value) => sum + value.processed, 0), 1); assert.equal(result.reduce((sum, value) => sum + value.failed, 0), 0);
      await assertTerminal(id, "COMPLETED", 1); assert.equal((await mails()).length, before + 1);
    });
    await check("solicitação expirada é descartada sem entrega e sem destinatário residual", async () => {
      const id = await insertFixtureJob({ ageSeconds: 1000 }); const before = (await mails()).length; const beforeTokens = await tokens();
      assert.deepEqual(await processPasswordResetJobs({ limit: 1, jobId: id }), { processed: 0, failed: 0 });
      await assertTerminal(id, "FAILED", 0); assert.equal((await mails()).length, before); assert.equal(await tokens(), beforeTokens);
    });
    await check("lease abandonada pode ser retomada antes da expiração do trabalho", async () => {
      const id = await insertFixtureJob({ status: "PROCESSING" }); const before = (await mails()).length;
      assert.deepEqual(await processPasswordResetJobs({ limit: 1, jobId: id }), { processed: 1, failed: 0 });
      await assertTerminal(id, "COMPLETED", 2); assert.equal((await mails()).length, before + 1);
    });
    await check("lease abandonada no limite de tentativas termina sem nova entrega", async () => {
      const id = await insertFixtureJob({ status: "PROCESSING", attempts: resetJobLimits.attempts }); const before = (await mails()).length;
      assert.deepEqual(await processPasswordResetJobs({ limit: 1, jobId: id }), { processed: 0, failed: 0 });
      await assertTerminal(id, "FAILED", resetJobLimits.attempts); assert.equal((await mails()).length, before);
    });
    await check("ciphertext transferido para outro identificador falha fechado sem emitir token", async () => {
      const id = await insertFixtureJob({ payloadForAnotherId: true }); const before = (await mails()).length; const beforeTokens = await tokens();
      assert.deepEqual(await processPasswordResetJobs({ limit: 1, jobId: id }), { processed: 0, failed: 1 });
      await assertTerminal(id, "FAILED", 1); assert.equal((await mails()).length, before); assert.equal(await tokens(), beforeTokens);
    });
    await check("falha de transporte fica durável, adia retentativas e encerra após três tentativas", async () => {
      const id = await enqueuePasswordReset(email); const before = (await mails()).length;
      // Blank SMTP configuration fails locally before any DNS/socket operation.
      process.env.MAIL_TRANSPORT = "smtp";
      try {
        for (let attempt = 1; attempt <= resetJobLimits.attempts; attempt++) {
          assert.deepEqual(await processPasswordResetJobs({ limit: 1, jobId: id }), { processed: 0, failed: 1 });
          const value = await job(id); assert.equal(value.attempts, attempt);
          if (attempt < resetJobLimits.attempts) {
            assert.equal(value.status, "PENDING"); assert.ok(value.payload);
            assert.deepEqual(await processPasswordResetJobs({ limit: 1, jobId: id }), { processed: 0, failed: 0 });
            await fixture.query('UPDATE password_reset_jobs SET available_at=clock_timestamp() WHERE id=$1', [id]);
          }
        }
        await assertTerminal(id, "FAILED", resetJobLimits.attempts); assert.equal((await mails()).length, before);
      } finally { process.env.MAIL_TRANSPORT = "local"; }
    });
    await check("outro processo retoma o trabalho persistido sem a memória do produtor", async () => {
      const id = await enqueuePasswordReset(email); const before = (await mails()).length;
      const reconnected = new Client({ connectionString: runtimeUrl.href, connectionTimeoutMillis: 5000 });
      try { await reconnected.connect(); assert.equal((await reconnected.query('SELECT status FROM password_reset_jobs WHERE id=$1', [id])).rows[0].status, "PENDING"); }
      finally { await reconnected.end().catch(() => {}); }
      await independentWorker(id); await assertTerminal(id, "COMPLETED", 1); assert.equal((await mails()).length, before + 1);
    });
    await check("manutenção remove somente terminais antigos e preserva os recentes", async () => {
      const old = await insertFixtureJob({ status: "COMPLETED", ageSeconds: 172800 });
      await expectedDatabaseError(() => runtime.query('DELETE FROM password_reset_jobs WHERE id=$1', [knownJob]), "55000");
      await processPasswordResetJobs({ limit: 1, jobId: randomUUID() });
      assert.equal((await fixture.query('SELECT count(*)::int AS count FROM password_reset_jobs WHERE id=$1', [old])).rows[0].count, 0);
      await assertTerminal(knownJob, "COMPLETED");
    });
    await check("limites inválidos do worker não modificam a fila", async () => {
      const before = (await fixture.query('SELECT count(*)::int AS count FROM password_reset_jobs')).rows[0].count;
      for (const options of [{ limit: 0 }, { limit: 26 }, { limit: 1.5 }, { jobId: "invalid" }]) await assert.rejects(() => processPasswordResetJobs(options));
      assert.equal((await fixture.query('SELECT count(*)::int AS count FROM password_reset_jobs')).rows[0].count, before);
    });
    await check("quota da fila recusa elegíveis e desconhecidos sem persistência parcial", async () => {
      const rows = Array.from({ length: resetJobLimits.active }, () => { const id = randomUUID(); return { id, payload: encryptResetJobEmail(id, unknown) }; });
      await fixture.query(`INSERT INTO password_reset_jobs(id,payload,status,attempts,available_at,expires_at,created_at)
        SELECT x.id,x.payload,'PENDING',0,t.now,t.now+interval '15 minutes',t.now
        FROM jsonb_to_recordset($1::jsonb) AS x(id uuid,payload text) CROSS JOIN(SELECT clock_timestamp() AS now)t`, [JSON.stringify(rows)]);
      for (const address of [email, unknown]) {
        const failure = await enqueuePasswordReset(address).then(() => null, (error: unknown) => error);
        assert.ok(failure && typeof failure === "object" && "code" in failure && failure.code === "UNAVAILABLE");
      }
      assert.equal((await fixture.query("SELECT count(*)::int AS count FROM password_reset_jobs WHERE status IN ('PENDING','PROCESSING')")).rows[0].count, resetJobLimits.active);
    });
    console.info(`${checked} verificações de segurança da fila aprovadas em banco descartável: cifra, grants, concorrência, leases, retentativas, expiração, quota e retomada em outro processo.`);
  } catch (error) {
    console.error(`Integração de segurança interrompida em: ${currentCheck}. Dados privados foram omitidos.`);
    if (error instanceof Error) { const position = /security-integration\.ts:(\d+):(\d+)/u.exec(error.stack ?? ""); if (position) console.error(`Local da verificação: linha ${position[1]}, coluna ${position[2]}.`); }
    if (error instanceof assert.AssertionError && ["number", "boolean"].includes(typeof error.actual) && ["number", "boolean"].includes(typeof error.expected)) console.error(`Resultado recebido: ${String(error.actual)}; esperado: ${String(error.expected)}.`);
    process.exitCode = 1;
  } finally {
    if (configured) await getDatabase().$disconnect().catch(() => {});
    if (runtimeConnected) await runtime.end().catch(() => {}); if (fixtureConnected) await fixture.end().catch(() => {});
    // A failed test can have created its message before the read assertion.
    await mails().catch(() => []);
    for (const name of ownedMailFiles) {
      const path = resolve(mailDirectory, name);
      if (mailName.test(name) && dirname(path) === mailDirectory) await unlink(path).catch(() => {});
    }
    if (created) {
      assertTarget(databaseName, marker);
      const observed = (await admin.query("SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=$1", [databaseName]).catch(() => null))?.rows[0]?.marker;
      if (observed === marker) await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`).catch(() => { console.error("Não foi possível remover o banco descartável da segurança."); process.exitCode = 1; });
      else { console.error("Marcador divergente; limpeza interrompida."); process.exitCode = 1; }
    }
    await admin.end().catch(() => {});
    for (const [key, value] of original) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}

integration().catch(() => { console.error("Não foi possível preparar a validação de segurança. Confira o banco local e as migrations; detalhes privados omitidos."); process.exitCode = 1; });
