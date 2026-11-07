import { config } from "dotenv";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { PrismaPg } from "@prisma/adapter-pg";
import { z } from "zod";
import { PrismaClient } from "../../src/generated/prisma/client.ts";
import { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS } from "../../src/server/authorization/permissions.ts";
import { assertDatabaseIdentity, assertLocalDevelopmentDatabase, readEnvironment } from "../../src/server/config/environment.ts";
import { getDatabase } from "../../src/server/database/client.ts";
import { verifyDatabaseIdentity } from "../../src/server/database/identity.ts";
import { hashPassword, passwordSchema } from "../../src/server/security/password.ts";
import { collectBootstrapCredentials } from "./bootstrap-input.ts";

config({ path: ".env", quiet: true });

class BootstrapError extends Error {}
let runtimeDatabase: PrismaClient | undefined;

async function requestCredentials() {
  const initial = { email: process.env.BOOTSTRAP_ADMIN_EMAIL, password: process.env.BOOTSTRAP_ADMIN_PASSWORD };
  if (!process.stdin.isTTY || !process.stdout.isTTY) return initial;
  let muted = false;
  const output = new Writable({ write(chunk, encoding, callback) { if (!muted) process.stdout.write(chunk, encoding); callback(); } });
  const terminal = createInterface({ input: process.stdin, output, terminal: true, historySize: 0 });
  const cancellation = new AbortController();
  terminal.once("SIGINT", () => cancellation.abort());
  terminal.once("close", () => cancellation.abort());
  try {
    return await collectBootstrapCredentials({
      async ask(message, secret = false) {
        if (!secret) return terminal.question(message, { signal: cancellation.signal });
        process.stdout.write(message);
        muted = true;
        try { return await terminal.question("", { signal: cancellation.signal }); }
        finally { muted = false; process.stdout.write("\n"); }
      },
      notify(message) { process.stdout.write(`${message}\n`); }
    }, initial);
  } catch (error) {
    if (cancellation.signal.aborted) throw new BootstrapError("Cadastro cancelado. Nenhum administrador foi criado.");
    throw error;
  } finally { terminal.close(); }
}

async function bootstrap() {
  const environment = readEnvironment();
  assertLocalDevelopmentDatabase(environment);
  if (!environment.DIRECT_URL) throw new BootstrapError("Configure DIRECT_URL para a administração local.");
  const credentials = await requestCredentials();
  const emailResult = z.string().trim().toLowerCase().pipe(z.email().max(254)).safeParse(credentials.email);
  const passwordResult = passwordSchema.safeParse(credentials.password);
  if (!emailResult.success) throw new BootstrapError("E-mail ausente ou inválido. Execute npm.cmd run auth:bootstrap em um terminal interativo ou configure BOOTSTRAP_ADMIN_EMAIL no ambiente do processo.");
  if (!passwordResult.success) throw new BootstrapError("Senha ausente ou inválida: são necessários de 12 a 128 caracteres. Execute npm.cmd run auth:bootstrap em um terminal interativo ou configure BOOTSTRAP_ADMIN_PASSWORD no ambiente do processo.");
  runtimeDatabase = getDatabase();
  await verifyDatabaseIdentity();

  const admin = new PrismaClient({
    adapter: new PrismaPg({ connectionString: environment.DIRECT_URL, max: 1, connectionTimeoutMillis: 5_000 })
  });
  try {
    assertDatabaseIdentity(environment, await admin.environmentSentinel.findUnique({ where: { id: "primary" } }));
    const passwordHash = await hashPassword(passwordResult.data);
    await admin.$transaction(async (tx) => {
      // Serialize competing bootstrap attempts without locking a human session.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(731050, 2)::text`;
      if (await tx.user.findFirst({ where: { role: { code: "ADMINISTRATOR" } }, select: { id: true } })) {
        throw new BootstrapError("Já existe um administrador. O bootstrap não altera usuários existentes.");
      }
      if (await tx.user.findUnique({ where: { email: emailResult.data }, select: { id: true } })) {
        throw new BootstrapError("O e-mail informado já está cadastrado. Nenhum usuário foi alterado.");
      }

      const permissions = new Map<string, string>();
      for (const code of PERMISSIONS) {
        const permission = await tx.permission.upsert({
          where: { code }, update: {}, create: { code, description: `Permissão ${code}` }
        });
        permissions.set(code, permission.id);
      }
      const roleNames = { ADMINISTRATOR: "Administrador", MANAGER: "Gerente", OPERATOR: "Operador" } as const;
      let administratorRoleId = "";
      for (const code of ["ADMINISTRATOR", "MANAGER", "OPERATOR"] as const) {
        const role = await tx.role.upsert({ where: { code }, update: { name: roleNames[code] }, create: { code, name: roleNames[code] } });
        await tx.rolePermission.deleteMany({ where: { roleId: role.id } });
        await tx.rolePermission.createMany({
          data: DEFAULT_ROLE_PERMISSIONS[code].map((permission) => ({ roleId: role.id, permissionId: permissions.get(permission)! }))
        });
        if (code === "ADMINISTRATOR") administratorRoleId = role.id;
      }
      const user = await tx.user.create({
        data: {
          email: emailResult.data, name: "Administrador", passwordHash,
          roleId: administratorRoleId, isActive: true, googleAccessAllowed: false
        }
      });
      await tx.auditEvent.create({
        data: {
          actorId: user.id, action: "CREATE", module: "USERS", entityType: "User", entityId: user.id,
          origin: "bootstrap-local",
          newValues: { email: user.email, role: "ADMINISTRATOR", isActive: true, googleAccessAllowed: false }
        }
      });
    }, { maxWait: 5_000, timeout: 15_000 });
    console.info("Administrador inicial criado. As credenciais não foram exibidas.");
  } finally {
    await admin.$disconnect();
  }
}

bootstrap().catch((error: unknown) => {
  console.error(error instanceof BootstrapError
    ? error.message
    : "Não foi possível criar o administrador inicial. Confira o ambiente local, a identidade do banco e as migrations; nenhuma credencial foi exibida.");
  process.exitCode = 1;
}).finally(async () => {
  // Also close the runtime connection if identity verification itself failed.
  await runtimeDatabase?.$disconnect().catch(() => {});
});
