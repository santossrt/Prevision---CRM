import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, readdir, unlink } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "pg";
import { config } from "dotenv";
import { assertDatabaseIdentity, assertLocalDevelopmentDatabase, readEnvironment } from "../../src/server/config/environment.ts";
import { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS } from "../../src/server/authorization/permissions.ts";
import { hashPassword } from "../../src/server/security/password.ts";

config({ path: ".env", quiet: true });

const base = "http://127.0.0.1:3010";
const mailDirectory = resolve(".cache", "mail-test");
const sessionCookie = "prevision.session-token";
const diagnostics = new Set<string>();

class Browser {
  cookies = new Map<string, string>();
  sessionWasHttpOnly = false;

  clone() {
    const browser = new Browser();
    browser.cookies = new Map(this.cookies);
    return browser;
  }

  async request(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    if (this.cookies.size) headers.set("cookie", [...this.cookies].map(([key, value]) => `${key}=${value}`).join("; "));
    const response = await fetch(new URL(path, base), { ...init, headers, redirect: "manual", signal: AbortSignal.timeout(20000) });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair, ...attributes] = cookie.split(";");
      const separator = pair.indexOf("=");
      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      if (!value || attributes.some((part) => /^\s*max-age=0$/i.test(part))) this.cookies.delete(name);
      else this.cookies.set(name, value);
      if (name === sessionCookie || name.startsWith(sessionCookie + ".")) {
        this.sessionWasHttpOnly ||= attributes.some((part) => /^\s*httponly$/i.test(part));
      }
    }
    return response;
  }

  async json(path: string, body: unknown, method = "POST", extra: Record<string, string> = {}) {
    // A page navigation refreshes the signed CSRF cookie after authentication.
    await this.request("/login");
    const csrf = this.cookies.get("prevision.csrf");
    assert.ok(csrf, "A navegação deve fornecer proteção CSRF.");
    return this.request(path, {
      method, headers: { "Content-Type": "application/json", Origin: base, "X-Prevision-CSRF": csrf, ...extra },
      body: JSON.stringify(body)
    });
  }

  async login(email: string, password: string) {
    const csrfResponse = await this.request("/api/auth/csrf");
    assert.equal(csrfResponse.status, 200, "O Auth.js deve emitir o desafio CSRF.");
    const { csrfToken } = await csrfResponse.json() as { csrfToken: string };
    const response = await this.request("/api/auth/callback/credentials", {
      method: "POST", headers: { Origin: base, "Content-Type": "application/x-www-form-urlencoded", "X-Auth-Return-Redirect": "1" },
      body: new URLSearchParams({ csrfToken, email, password, callbackUrl: base + "/" })
    });
    const result = await response.json() as { url?: string };
    const error = result.url ? new URL(result.url, base).searchParams.get("error") : "MissingRedirect";
    if (error && /^[A-Za-z]{1,64}$/.test(error)) diagnostics.add(`Auth.js: ${error}; HTTP ${response.status}`);
    return Boolean(result.url && !new URL(result.url, base).searchParams.has("error") && [...this.cookies.keys()].some((name) => name === sessionCookie || name.startsWith(sessionCookie + ".")));
  }
}

async function assertFreePort() {
  const probe = createServer();
  await new Promise<void>((accept, reject) => { probe.once("error", reject); probe.listen(3010, "127.0.0.1", accept); });
  await new Promise<void>((accept, reject) => probe.close((error) => error ? reject(error) : accept()));
}

async function stopServer(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await Promise.race([new Promise<void>((accept) => child.once("exit", () => accept())), delay(5000)]);
  if (child.exitCode === null) { child.kill("SIGKILL"); await delay(500); }
}

async function integration() {
  const source = readEnvironment();
  assertLocalDevelopmentDatabase(source);
  assert.ok(source.DIRECT_URL, "Configure DIRECT_URL para o teste local.");
  assert.equal(new URL(source.DIRECT_URL).host, new URL(source.DATABASE_URL).host, "As duas conexões precisam usar o mesmo servidor local.");
  await assertFreePort();
  const suffix = randomBytes(6).toString("hex");
  const databaseName = `prevision_auth_test_${suffix}`;
  assert.match(databaseName, /^prevision_auth_test_[0-9a-f]{12}$/);
  const marker = `prevision-auth-integration-${randomUUID()}`;
  const admin = new Client({ connectionString: source.DIRECT_URL, connectionTimeoutMillis: 5000 });
  const adminUrl = new URL(source.DIRECT_URL);
  const runtimeUrl = new URL(source.DATABASE_URL);
  adminUrl.pathname = runtimeUrl.pathname = `/${databaseName}`;
  const fixture = new Client({ connectionString: adminUrl.href, connectionTimeoutMillis: 5000 });
  const authSecret = randomBytes(48).toString("hex");
  const password = `Integration-${randomBytes(20).toString("hex")}`;
  const nextPassword = `Updated-${randomBytes(20).toString("hex")}`;
  const administratorId = randomUUID();
  const operatorId = randomUUID();
  const adminEmail = `admin.${suffix}@example.invalid`;
  const operatorEmail = `operator.${suffix}@example.invalid`;
  const invitedEmail = `invited.${suffix}@example.invalid`;
  const googleEmail = `google.${suffix}@example.invalid`;
  const resetManagerId = randomUUID();
  const resetManagerEmail = `reset-manager.${suffix}@example.invalid`;
  const otherAdministratorId = randomUUID();
  const otherAdministratorEmail = `other-admin.${suffix}@example.invalid`;
  const pendingResetId = randomUUID();
  const pendingResetEmail = `pending-reset.${suffix}@example.invalid`;
  const testRecipients = new Set([adminEmail, operatorEmail, invitedEmail, googleEmail, resetManagerEmail, otherAdministratorEmail, pendingResetEmail]);
  let currentOperatorPassword = password;
  const adminResetTokens: string[] = [];
  const mailFiles = new Set<string>();
  const initialMailFiles = new Set(await readdir(mailDirectory).catch(() => [] as string[]));
  let created = false;
  let connectedFixture = false;
  let server: ChildProcess | undefined;
  let checked = 0;
  let currentCheck = "preparo do banco de teste";

  async function check(name: string, work: () => unknown | Promise<unknown>) {
    currentCheck = name;
    await work();
    checked += 1;
  }

  async function readMail(to: string, route: string) {
    // Public recovery is durable and delivered after its HTTP response. Poll
    // only this run's private test mailbox instead of assuming synchronous I/O.
    for (let attempt = 0; attempt < 60; attempt++) {
    const names = await readdir(mailDirectory).catch(() => [] as string[]);
    const matching: { token: string; name: string; createdAt: string }[] = [];
    for (const name of names.filter((entry) => !initialMailFiles.has(entry) && /^\d+-[0-9a-f-]+\.json$/.test(entry))) {
      const content = JSON.parse(await readFile(resolve(mailDirectory, name), "utf8")) as { to: string; text: string; createdAt: string };
      if (!testRecipients.has(content.to)) continue;
      mailFiles.add(name);
      if (content.to !== to) continue;
      const match = content.text.match(/http:\/\/127\.0\.0\.1:3010\/[^\s]+/);
      if (!match) continue;
      const url = new URL(match[0]);
      if (url.pathname === route && url.searchParams.get("token")) matching.push({ token: url.searchParams.get("token")!, name, createdAt: content.createdAt });
    }
    matching.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      if (matching[0]) return matching[0].token;
      await delay(50);
    }
    assert.fail("O transporte local deve gravar a mensagem de teste dentro do prazo.");
  }

  try {
    await admin.connect();
    const identity = await admin.query('SELECT environment, database_id AS "databaseId" FROM environment_sentinel WHERE id = $1', ["primary"]);
    assertDatabaseIdentity(source, identity.rows[0] ?? null);
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    // Marker plus random strict prefix authorize only this run's cleanup target.
    await admin.query(`COMMENT ON DATABASE "${databaseName}" IS '${marker}'`);
    await fixture.connect();
    connectedFixture = true;
    for (const name of (await readdir(resolve("prisma", "migrations"))).filter((name) => /^\d+_/.test(name)).sort()) {
      await fixture.query(await readFile(resolve("prisma", "migrations", name, "migration.sql"), "utf8"));
    }
    await fixture.query('INSERT INTO environment_sentinel (id, environment, database_id) VALUES ($1, $2, $3)', ["primary", "test", marker]);
    const roleIds = new Map<string, string>();
    for (const code of Object.keys(DEFAULT_ROLE_PERMISSIONS) as (keyof typeof DEFAULT_ROLE_PERMISSIONS)[]) {
      const id = randomUUID();
      roleIds.set(code, id);
      await fixture.query('INSERT INTO roles (id, code, name, updated_at) VALUES ($1, $2, $3, now())', [id, code, code]);
    }
    for (const code of PERMISSIONS) {
      const id = randomUUID();
      await fixture.query('INSERT INTO permissions (id, code) VALUES ($1, $2)', [id, code]);
      for (const [role, codes] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
        if ((codes as readonly string[]).includes(code)) await fixture.query('INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2)', [roleIds.get(role), id]);
      }
    }
    const hash = await hashPassword(password);
    for (const [id, email, role] of [[administratorId, adminEmail, "ADMINISTRATOR"], [operatorId, operatorEmail, "OPERATOR"]]) {
      await fixture.query('INSERT INTO users (id, name, email, password_hash, role_id, updated_at) VALUES ($1, $2, $3, $4, $5, now())', [id, "Integração", email, hash, roleIds.get(role)]);
    }
    const googleId = randomUUID();
    await fixture.query('INSERT INTO users (id, name, email, google_access_allowed, role_id, updated_at) VALUES ($1, $2, $3, true, $4, now())', [googleId, "Google exclusivo", googleEmail, roleIds.get("OPERATOR")]);
    await fixture.query('INSERT INTO auth_accounts (id, user_id, type, provider, provider_account_id) VALUES ($1, $2, $3, $4, $5)', [randomUUID(), googleId, "oidc", "google", `integration-${suffix}`]);

    currentCheck = "inicialização do servidor isolado";
    server = spawn(process.execPath, [resolve("node_modules", "next", "dist", "bin", "next"), "start", "--hostname", "127.0.0.1", "--port", "3010"], {
      cwd: process.cwd(), windowsHide: true, stdio: ["ignore", "ignore", "pipe"], env: {
        ...process.env, NODE_ENV: "production", APP_ENV: "test", DATABASE_ID: marker,
        DATABASE_URL: runtimeUrl.href, DIRECT_URL: adminUrl.href, AUTH_SECRET: authSecret, AUTH_URL: base,
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
      try { ready = (await fetch(base + "/api/health", { signal: AbortSignal.timeout(1000) })).ok; } catch { /* wait for our child */ }
      if (ready) break;
      await delay(250);
    }
    assert.ok(ready, "O servidor isolado não respondeu; execute npm run build antes do teste.");
    const anonymous = new Browser();
    const administrator = new Browser();
    const operator = new Browser();
    const invited = new Browser();

    await check("origem alternativa preserva o destino canonico sem ciclo", async () => {
      const alternative = new URL(base);
      alternative.hostname = "localhost";
      for (const path of ["/login", "/login?error=Configuration"]) {
        const response = await fetch(new URL(path, alternative), { redirect: "manual", signal: AbortSignal.timeout(20000) });
        assert.equal(response.status, 308);
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.equal(response.headers.get("referrer-policy"), "no-referrer");
        const destination = new URL(path, base).href;
        assert.equal(response.headers.get("location"), destination);
        await response.body?.cancel();
        const final = await fetch(destination, { redirect: "manual", signal: AbortSignal.timeout(20000) });
        assert.equal(final.status, 200);
        assert.equal(final.headers.get("location"), null);
        await final.body?.cancel();
      }
    });

    await check("página pública e CSP", async () => {
      const response = await anonymous.request("/login");
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-security-policy") ?? "", /script-src[^;]+nonce-/);
      assert.match(response.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
      assert.equal(response.headers.get("referrer-policy"), "no-referrer");
      assert.ok(anonymous.cookies.get("prevision.csrf"));
    });
    await check("página protegida anônima", async () => {
      const response = await anonymous.request("/");
      assert.ok([303, 307].includes(response.status));
      assert.equal(new URL(response.headers.get("location")!, base).pathname, "/login");
    });
    await check("API protegida anônima", async () => assert.equal((await anonymous.request("/api/users")).status, 401));
    await check("Google ausente sem configuração", async () => {
      const response = await anonymous.request("/api/auth/providers");
      assert.equal(response.status, 200);
      const providers = await response.json();
      assert.equal(Object.hasOwn(providers, "google"), false);
    });
    await check("senha incorreta", async () => assert.equal(await anonymous.login(adminEmail, "Wrong-password-integration"), false));
    await check("login não cadastra usuário", async () => {
      const countBefore = (await fixture.query('SELECT count(*)::integer AS count FROM users')).rows[0].count;
      assert.equal(await new Browser().login(`unapproved.${suffix}@example.invalid`, password), false);
      assert.equal((await fixture.query('SELECT count(*)::integer AS count FROM users')).rows[0].count, countBefore);
    });
    await check("login de administrador", async () => assert.equal(await administrator.login(adminEmail, password), true));
    await check("cookie HttpOnly", () => assert.equal(administrator.sessionWasHttpOnly, true));
    await check("sessão pública sem dados secretos", async () => {
      const response = await administrator.request("/api/auth/session");
      assert.equal(response.status, 200);
      const session = await response.json();
      assert.equal(session.user.role, "ADMINISTRATOR");
      assert.ok(session.user.permissions.includes("users.manage"));
      assert.doesNotMatch(JSON.stringify(session), /passwordHash|sessionVersion|sessionId|refresh_token|access_token|"sid"/);
    });
    await check("listagem sem dados secretos", async () => {
      const response = await administrator.request("/api/users");
      assert.equal(response.status, 200);
      const users = await response.json();
      assert.equal(users.users.length, 3);
      assert.doesNotMatch(JSON.stringify(users), /passwordHash|password_hash|sessionVersion|tokenHash|refresh_token|access_token/);
      assert.equal(response.headers.get("cache-control"), "no-store");
    });
    await check("login de operador", async () => assert.equal(await operator.login(operatorEmail, password), true));
    await check("RBAC de leitura", async () => assert.equal((await operator.request("/api/users")).status, 403));
    await check("RBAC de escrita", async () => assert.equal((await operator.json("/api/users", { name: "Sem permissão", email: `blocked.${suffix}@example.invalid` })).status, 403));
    await check("origem forjada", async () => assert.equal((await administrator.json("/api/users", {}, "POST", { Origin: "https://attacker.invalid" })).status, 403));
    await check("CSRF forjado", async () => assert.equal((await administrator.json("/api/users", {}, "POST", { "X-Prevision-CSRF": "forged" })).status, 403));
    await check("JSON inválido", async () => assert.equal((await administrator.json("/api/users", { email: invitedEmail, name: "Integração", passwordHash: hash })).status, 400));

    let invitedId = "";
    await check("cadastro pré-autorizado", async () => {
      const response = await administrator.json("/api/users", { name: "Pessoa Convidada", email: invitedEmail, role: "OPERATOR", googleAccessAllowed: false });
      assert.equal(response.status, 201);
      const result = await response.json();
      invitedId = result.user.id;
      assert.equal(result.user.email, invitedEmail);
      assert.doesNotMatch(JSON.stringify(result), /token|passwordHash|sessionVersion/);
    });
    await check("pendente não autentica", async () => assert.equal(await invited.login(invitedEmail, password), false));
    let activationToken = await readMail(invitedEmail, "/ativar-acesso");
    await check("desativar e reativar não recupera convite revogado", async () => {
      assert.equal((await administrator.json(`/api/users/${invitedId}`, { isActive: false }, "PATCH")).status, 200);
      assert.equal((await administrator.json(`/api/users/${invitedId}`, { isActive: true }, "PATCH")).status, 200);
      assert.equal((await invited.json("/api/access/activate", { token: activationToken, password })).status, 400);
      assert.equal((await administrator.json(`/api/users/${invitedId}/activation`, {})).status, 200);
      const nextActivationToken = await readMail(invitedEmail, "/ativar-acesso");
      assert.notEqual(nextActivationToken, activationToken);
      activationToken = nextActivationToken;
    });
    await check("token armazenado somente por hash", async () => {
      const rows = await fixture.query('SELECT token_hash FROM access_tokens WHERE user_id = $1 AND purpose = $2 AND revoked_at IS NULL', [invitedId, "PASSWORD_SETUP"]);
      assert.equal(rows.rows.length, 1);
      assert.match(rows.rows[0].token_hash, /^[0-9a-f]{64}$/);
      assert.equal(rows.rows[0].token_hash, createHash("sha256").update(activationToken).digest("hex"));
    });
    await check("finalidade do token", async () => assert.equal((await invited.json("/api/access/password-reset/confirm", { token: activationToken, password })).status, 400));
    await check("ativação", async () => assert.equal((await invited.json("/api/access/activate", { token: activationToken, password })).status, 200));
    await check("ativação de uso único", async () => assert.equal((await invited.json("/api/access/activate", { token: activationToken, password })).status, 400));
    await check("login após ativação", async () => assert.equal(await invited.login(invitedEmail, password), true));
    const beforeReset = invited.clone();
    let genericResponse: unknown;
    await check("solicitação de recuperação", async () => {
      const response = await anonymous.json("/api/access/password-reset/request", { email: invitedEmail });
      assert.equal(response.status, 202);
      genericResponse = await response.json();
    });
    await check("recuperação sem enumeração de conta inexistente", async () => {
      const response = await anonymous.json("/api/access/password-reset/request", { email: `unknown.${suffix}@example.invalid` });
      assert.equal(response.status, 202);
      assert.deepEqual(await response.json(), genericResponse);
    });
    await check("recuperação sem enumeração de conta Google", async () => {
      const response = await anonymous.json("/api/access/password-reset/request", { email: googleEmail });
      assert.equal(response.status, 202);
      assert.deepEqual(await response.json(), genericResponse);
      assert.equal((await fixture.query('SELECT count(*)::integer AS count FROM access_tokens WHERE user_id = $1', [googleId])).rows[0].count, 0);
    });
    const resetToken = await readMail(invitedEmail, "/redefinir-senha");
    await check("recuperação rejeita token inválido", async () => assert.equal((await anonymous.json("/api/access/password-reset/confirm", { token: randomBytes(32).toString("base64url"), password: nextPassword })).status, 400));
    await check("recuperação rejeita token expirado", async () => {
      const expired = randomBytes(32).toString("base64url");
      await fixture.query("INSERT INTO access_tokens (id, user_id, purpose, token_hash, created_at, expires_at) VALUES ($1, $2, 'PASSWORD_RESET', $3, now() - interval '2 hours', now() - interval '1 hour')", [randomUUID(), invitedId, createHash("sha256").update(expired).digest("hex")]);
      assert.equal((await anonymous.json("/api/access/password-reset/confirm", { token: expired, password: nextPassword })).status, 400);
    });
    await check("redefinição concorrente e uso único", async () => {
      const responses = await Promise.all(Array.from({ length: 2 }, () => anonymous.json("/api/access/password-reset/confirm", { token: resetToken, password: nextPassword })));
      assert.deepEqual(responses.map((response) => response.status).sort(), [200, 400]);
    });
    await check("reset revoga cópia do cookie", async () => assert.equal((await beforeReset.request("/api/users")).status, 401));
    await check("reset de uso único", async () => assert.equal((await anonymous.json("/api/access/password-reset/confirm", { token: resetToken, password: nextPassword })).status, 400));
    await check("senha anterior invalidada", async () => assert.equal(await new Browser().login(invitedEmail, password), false));
    const freshInvited = new Browser();
    await check("nova senha aceita", async () => assert.equal(await freshInvited.login(invitedEmail, nextPassword), true));
    await check("perfil revoga sessão anterior", async () => {
      assert.equal((await administrator.json(`/api/users/${invitedId}`, { role: "MANAGER" }, "PATCH")).status, 200);
      assert.equal((await freshInvited.request("/api/users")).status, 401);
    });
    const manager = new Browser();
    await check("permissão atualizada no novo login", async () => {
      assert.equal(await manager.login(invitedEmail, nextPassword), true);
      assert.equal((await manager.request("/api/users")).status, 200);
      assert.equal((await manager.json("/api/users", { name: "Negado", email: `manager-blocked.${suffix}@example.invalid` })).status, 403);
    });
    await check("desativação revoga acesso", async () => {
      assert.equal((await administrator.json(`/api/users/${invitedId}`, { isActive: false }, "PATCH")).status, 200);
      assert.equal((await manager.request("/api/users")).status, 401);
      assert.equal(await new Browser().login(invitedEmail, nextPassword), false);
    });
    await check("último administrador protegido", async () => {
      assert.equal((await administrator.json(`/api/users/${administratorId}`, { isActive: false }, "PATCH")).status, 409);
      assert.equal((await administrator.json(`/api/users/${administratorId}`, { role: "OPERATOR" }, "PATCH")).status, 409);
    });

    // Administrative reset fixtures are created only after the last-admin check.
    // The manager deliberately has users.manage: the role restriction must still hold.
    await fixture.query('INSERT INTO role_permissions (role_id, permission_id) SELECT $1, id FROM permissions WHERE code=$2 ON CONFLICT DO NOTHING', [roleIds.get("MANAGER"), "users.manage"]);
    for (const [userId, email, role] of [[resetManagerId, resetManagerEmail, "MANAGER"], [otherAdministratorId, otherAdministratorEmail, "ADMINISTRATOR"]]) {
      await fixture.query('INSERT INTO users (id,name,email,password_hash,role_id,updated_at) VALUES ($1,$2,$3,$4,$5,now())', [userId, "Reset administrativo", email, hash, roleIds.get(role)]);
    }
    await fixture.query('INSERT INTO users (id,name,email,role_id,updated_at) VALUES ($1,$2,$3,$4,now())', [pendingResetId, "Acesso pendente", pendingResetEmail, roleIds.get("OPERATOR")]);
    const privilegedManager = new Browser();
    const otherAdministrator = new Browser();
    await check("preparo das contas para reset administrativo", async () => {
      assert.equal(await privilegedManager.login(resetManagerEmail, password), true);
      assert.equal(await otherAdministrator.login(otherAdministratorEmail, password), true);
    });
    await check("reset administrativo exige autenticação", async () => {
      assert.equal((await anonymous.json(`/api/users/${operatorId}/password-reset`, {})).status, 401);
    });
    await check("operador não pode solicitar reset administrativo", async () => {
      const before = (await fixture.query('SELECT count(*)::int AS n FROM access_tokens WHERE user_id=$1', [operatorId])).rows[0].n;
      assert.equal((await operator.json(`/api/users/${operatorId}/password-reset`, {})).status, 403);
      assert.equal((await fixture.query('SELECT count(*)::int AS n FROM access_tokens WHERE user_id=$1', [operatorId])).rows[0].n, before);
    });
    await check("gerente com users.manage continua sem reset administrativo", async () => {
      const session = await (await privilegedManager.request("/api/auth/session")).json() as { user: { role: string; permissions: string[] } };
      assert.equal(session.user.role, "MANAGER");
      assert.equal(session.user.permissions.includes("users.manage"), true);
      const before = (await fixture.query('SELECT count(*)::int AS n FROM access_tokens WHERE user_id=$1', [operatorId])).rows[0].n;
      assert.equal((await privilegedManager.json(`/api/users/${operatorId}/password-reset`, {})).status, 403);
      assert.equal((await fixture.query('SELECT count(*)::int AS n FROM access_tokens WHERE user_id=$1', [operatorId])).rows[0].n, before);
    });
    await check("reset administrativo valida CSRF e corpo estrito", async () => {
      assert.equal((await administrator.json(`/api/users/${operatorId}/password-reset`, {}, "POST", { "X-Prevision-CSRF": "forged" })).status, 403);
      assert.equal((await otherAdministrator.json(`/api/users/${operatorId}/password-reset`, { password: nextPassword })).status, 400);
    });
    await check("reset administrativo valida ID e conta existente", async () => {
      assert.equal((await otherAdministrator.json("/api/users/not-a-uuid/password-reset", {})).status, 400);
      assert.equal((await otherAdministrator.json(`/api/users/${randomUUID()}/password-reset`, {})).status, 404);
    });
    await check("reset administrativo revalida o papel após aguardar autorização", async () => {
      let transactionOpen = false;
      let pending: Promise<Response> | undefined;
      const before = (await fixture.query('SELECT count(*)::int AS n FROM access_tokens WHERE user_id=$1', [pendingResetId])).rows[0].n;
      try {
        await fixture.query("BEGIN"); transactionOpen = true;
        await fixture.query("SELECT pg_advisory_xact_lock(2026103002)");
        pending = otherAdministrator.json(`/api/users/${pendingResetId}/password-reset`, {});
        void pending.catch(() => {});
        let waiting = false;
        for (let attempt = 0; attempt < 60; attempt++) {
          const activity = await admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1 AND usename='prevision_app' AND state='active' AND wait_event_type='Lock' AND wait_event='advisory'", [databaseName]);
          waiting = activity.rows[0].n > 0;
          if (waiting) break;
          await delay(50);
        }
        assert.equal(waiting, true);
        // Keep the session version unchanged to prove the current role is checked,
        // independently of normal user-management session invalidation.
        await fixture.query('UPDATE users SET role_id=$2,updated_at=now() WHERE id=$1', [otherAdministratorId, roleIds.get("MANAGER")]);
        await fixture.query("COMMIT"); transactionOpen = false;
        assert.equal((await pending).status, 403);
        assert.equal((await fixture.query('SELECT count(*)::int AS n FROM access_tokens WHERE user_id=$1', [pendingResetId])).rows[0].n, before);
      } finally {
        if (transactionOpen) await fixture.query("ROLLBACK").catch(() => {});
        await pending?.catch(() => {});
        await fixture.query('UPDATE users SET role_id=$2,updated_at=now() WHERE id=$1', [otherAdministratorId, roleIds.get("ADMINISTRATOR")]);
      }
    });
    let firstAdminToken = "";
    await check("administrador solicita link sem revelar credenciais", async () => {
      const response = await administrator.json(`/api/users/${operatorId}/password-reset`, {});
      assert.equal(response.status, 200);
      const result = await response.json() as { sent: boolean; message: string };
      assert.equal(result.sent, true);
      firstAdminToken = await readMail(operatorEmail, "/redefinir-senha");
      adminResetTokens.push(firstAdminToken);
      const serialized = JSON.stringify(result);
      assert.doesNotMatch(serialized, /passwordHash|password_hash|tokenHash|token_hash|"token"|"url"|"resetUrl"/);
      assert.equal(serialized.includes(firstAdminToken), false);
      const row = (await fixture.query("SELECT purpose,token_hash,extract(epoch FROM(expires_at-created_at))::int AS seconds FROM access_tokens WHERE token_hash=$1", [createHash("sha256").update(firstAdminToken).digest("hex")])).rows[0];
      assert.equal(row.purpose, "ADMIN_PASSWORD_RESET");
      assert.match(row.token_hash, /^[0-9a-f]{64}$/);
      assert.ok(row.seconds >= 1790 && row.seconds <= 1801);
      const audit = await fixture.query("SELECT actor_id,entity_id FROM audit_events WHERE origin=$1 AND actor_id=$2 AND entity_id=$3", ["users.admin_password_reset", administratorId, operatorId]);
      assert.ok(audit.rows.length > 0);
      assert.equal((await anonymous.json("/api/access/activate", { token: firstAdminToken, password: nextPassword })).status, 400);
    });
    const beforeAdministrativeReset = new Browser();
    await check("solicitar reset não troca senha nem encerra a sessão antes da confirmação", async () => {
      assert.equal(await beforeAdministrativeReset.login(operatorEmail, password), true);
      assert.equal((await beforeAdministrativeReset.request("/api/auth/session")).status, 200);
    });
    let currentAdminToken = "";
    await check("novo reset administrativo revoga o link anterior", async () => {
      assert.equal((await administrator.json(`/api/users/${operatorId}/password-reset`, {})).status, 200);
      currentAdminToken = await readMail(operatorEmail, "/redefinir-senha");
      adminResetTokens.push(currentAdminToken);
      assert.notEqual(currentAdminToken, firstAdminToken);
      assert.equal((await anonymous.json("/api/access/password-reset/confirm", { token: firstAdminToken, password: nextPassword })).status, 400);
    });
    const operatorResetPassword = `Admin-operator-${randomBytes(20).toString("hex")}`;
    await check("usuário conclui reset administrativo e invalida as sessões anteriores", async () => {
      const copy = beforeAdministrativeReset.clone();
      assert.equal((await anonymous.json("/api/access/password-reset/confirm", { token: currentAdminToken, password: operatorResetPassword })).status, 200);
      assert.equal((await copy.request("/api/users")).status, 401);
      assert.equal(await new Browser().login(operatorEmail, password), false);
      const renewed = new Browser();
      assert.equal(await renewed.login(operatorEmail, operatorResetPassword), true);
      operator.cookies = new Map(renewed.cookies);
      currentOperatorPassword = operatorResetPassword;
      assert.equal((await anonymous.json("/api/access/password-reset/confirm", { token: currentAdminToken, password: operatorResetPassword })).status, 400);
    });
    await check("reset administrativo permite senha para conta Google sem desfazer o vínculo", async () => {
      const accountsBefore = (await fixture.query("SELECT count(*)::int AS n FROM auth_accounts WHERE user_id=$1 AND provider='google'", [googleId])).rows[0].n;
      assert.equal((await administrator.json(`/api/users/${googleId}/password-reset`, {})).status, 200);
      const token = await readMail(googleEmail, "/redefinir-senha"); adminResetTokens.push(token);
      assert.equal((await anonymous.json("/api/access/password-reset/confirm", { token, password: nextPassword })).status, 200);
      const row = (await fixture.query('SELECT is_active,password_hash IS NOT NULL AS has_password,google_access_allowed FROM users WHERE id=$1', [googleId])).rows[0];
      assert.equal(row.is_active, true); assert.equal(row.has_password, true); assert.equal(row.google_access_allowed, true);
      assert.equal((await fixture.query("SELECT count(*)::int AS n FROM auth_accounts WHERE user_id=$1 AND provider='google'", [googleId])).rows[0].n, accountsBefore);
      assert.equal(await new Browser().login(googleEmail, nextPassword), true);
    });
    await check("reset administrativo de conta inativa não reativa o acesso", async () => {
      assert.equal((await administrator.json(`/api/users/${invitedId}/password-reset`, {})).status, 200);
      const token = await readMail(invitedEmail, "/redefinir-senha"); adminResetTokens.push(token);
      assert.equal((await anonymous.json("/api/access/password-reset/confirm", { token, password })).status, 200);
      assert.equal((await fixture.query('SELECT is_active FROM users WHERE id=$1', [invitedId])).rows[0].is_active, false);
      assert.equal(await new Browser().login(invitedEmail, password), false);
    });
    await check("reset administrativo atende conta ainda sem senha", async () => {
      assert.equal((await administrator.json(`/api/users/${pendingResetId}/password-reset`, {})).status, 200);
      const token = await readMail(pendingResetEmail, "/redefinir-senha"); adminResetTokens.push(token);
      assert.equal((await anonymous.json("/api/access/password-reset/confirm", { token, password: nextPassword })).status, 200);
      assert.equal(await new Browser().login(pendingResetEmail, nextPassword), true);
    });
    const otherAdminPassword = `Admin-other-${randomBytes(20).toString("hex")}`;
    await check("administrador pode solicitar reset de outro administrador", async () => {
      const copy = otherAdministrator.clone();
      assert.equal((await administrator.json(`/api/users/${otherAdministratorId}/password-reset`, {})).status, 200);
      const token = await readMail(otherAdministratorEmail, "/redefinir-senha"); adminResetTokens.push(token);
      assert.equal((await anonymous.json("/api/access/password-reset/confirm", { token, password: otherAdminPassword })).status, 200);
      assert.equal((await copy.request("/api/users")).status, 401);
      assert.equal(await otherAdministrator.login(otherAdministratorEmail, otherAdminPassword), true);
    });
    await check("administrador pode solicitar a própria redefinição", async () => {
      assert.equal((await otherAdministrator.json(`/api/users/${otherAdministratorId}/password-reset`, {})).status, 200);
      const token = await readMail(otherAdministratorEmail, "/redefinir-senha"); adminResetTokens.push(token);
      assert.equal((await anonymous.json("/api/access/password-reset/confirm", { token, password: nextPassword })).status, 200);
      assert.equal(await new Browser().login(otherAdministratorEmail, nextPassword), true);
    });
    await check("expiração por inatividade", async () => {
      await fixture.query("UPDATE login_sessions SET created_at = now() - interval '32 minutes', last_seen_at = now() - interval '31 minutes' WHERE user_id = $1 AND revoked_at IS NULL", [operatorId]);
      assert.equal((await operator.request("/api/users")).status, 401);
    });
    const copiedAdministrator = administrator.clone();
    await check("logout", async () => assert.equal((await administrator.json("/api/access/logout", {})).status, 200));
    await check("logout revoga cópia do cookie", async () => assert.equal((await copiedAdministrator.request("/api/users")).status, 401));
    await check("logout do Auth.js revoga cópia do cookie", async () => {
      const signedOut = new Browser();
      assert.equal(await signedOut.login(operatorEmail, currentOperatorPassword), true);
      const copied = signedOut.clone();
      const { csrfToken } = await (await signedOut.request("/api/auth/csrf")).json() as { csrfToken: string };
      const response = await signedOut.request("/api/auth/signout", {
        method: "POST", headers: { Origin: base, "Content-Type": "application/x-www-form-urlencoded", "X-Auth-Return-Redirect": "1" },
        body: new URLSearchParams({ csrfToken, callbackUrl: base + "/login" })
      });
      assert.ok([200, 302, 303].includes(response.status));
      assert.equal((await copied.request("/api/users")).status, 401);
    });
    await check("auditoria sem segredos", async () => {
      const audits = await fixture.query('SELECT action, previous_values, new_values, origin FROM audit_events');
      const serialized = JSON.stringify(audits.rows);
      assert.doesNotMatch(serialized, /passwordHash|password_hash|tokenHash|token_hash|refresh_token|access_token/);
      assert.equal(serialized.includes(password), false);
      assert.equal(serialized.includes(resetToken), false);
      for (const token of adminResetTokens) assert.equal(serialized.includes(token), false);
      assert.equal(serialized.includes(operatorResetPassword), false);
      assert.equal(serialized.includes(otherAdminPassword), false);
      assert.ok(audits.rows.some((row) => row.action === "PASSWORD_RESET"));
      assert.ok(audits.rows.some((row) => row.action === "LOGOUT"));
    });
    await check("limite compartilhado concorrente", async () => {
      process.env.AUTH_SECRET = authSecret;
      const [{ PrismaClient }, { PrismaPg }, { consumeRateLimit }] = await Promise.all([
        import("../../src/generated/prisma/client.ts"), import("@prisma/adapter-pg"), import("../../src/server/security/rate-limit.ts")
      ]);
      const runtime = new PrismaClient({ adapter: new PrismaPg({ connectionString: runtimeUrl.href }) });
      try {
        const results = await Promise.all(Array.from({ length: 20 }, () => consumeRateLimit(["integration-concurrency", suffix], 7, 3600, runtime)));
        assert.equal(results.filter((result) => result.allowed).length, 7);
        assert.ok(results.filter((result) => !result.allowed).every((result) => result.retryAfter > 0));
      } finally { await runtime.$disconnect(); }
    });
    console.info(`${checked} verificações de autenticação aprovadas em banco e servidor descartáveis: HTTP, RBAC, CSRF, ativação, recuperação, revogação, auditoria e concorrência.`);
  } catch (error) {
    // Assertion/driver details can contain a password or token. Report only the fixed label.
    console.error(`Integração de autenticação interrompida em: ${currentCheck}. Dados sensíveis foram omitidos.`);
    if (error instanceof assert.AssertionError && ["number", "boolean"].includes(typeof error.actual) && ["number", "boolean"].includes(typeof error.expected)) {
      console.error(`Resultado recebido: ${String(error.actual)}; esperado: ${String(error.expected)}.`);
    }
    for (const diagnostic of diagnostics) console.error(diagnostic);
    process.exitCode = 1;
  } finally {
    await stopServer(server);
    if (connectedFixture) await fixture.end().catch(() => {});
    if (created) {
      const result = await admin.query("SELECT shobj_description(oid, 'pg_database') AS marker FROM pg_database WHERE datname = $1", [databaseName]).catch(() => null);
      if (result?.rows[0]?.marker === marker && /^prevision_auth_test_[0-9a-f]{12}$/.test(databaseName)) {
        await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`).catch(() => { console.error("Não foi possível remover o banco descartável criado por esta execução."); process.exitCode = 1; });
      } else { console.error("Marcador do banco descartável divergente; limpeza interrompida."); process.exitCode = 1; }
    }
    await admin.end().catch(() => {});
    // Only messages addressed to this run's unique test identities are removed.
    // Collect again on failure: delivery may have succeeded before an assertion.
    for (const name of (await readdir(mailDirectory).catch(() => [] as string[])).filter((entry) => !initialMailFiles.has(entry) && /^\d+-[0-9a-f-]+\.json$/.test(entry))) {
      try {
        const mail = JSON.parse(await readFile(resolve(mailDirectory, name), "utf8")) as { to?: string };
        if (typeof mail.to === "string" && testRecipients.has(mail.to)) mailFiles.add(name);
      } catch { /* Preserve unrecognized files instead of widening cleanup. */ }
    }
    await Promise.allSettled([...mailFiles].map((name) => unlink(resolve(mailDirectory, name))));
  }
}

integration().catch(() => {
  console.error("Não foi possível preparar a integração local de autenticação. Verifique o banco local, a porta 3010 e o build; segredos foram omitidos.");
  process.exitCode = 1;
});
