import "server-only";
import { z } from "zod";
import { Prisma } from "../../generated/prisma/client.ts";
import type { RoleCode } from "../../generated/prisma/enums.ts";
import type { Principal } from "../auth/identity.ts";
import { sendActivationEmail } from "../auth/access-tokens.ts";
import { assertActorInTransaction, assertPermission } from "../authorization/guard.ts";
import { DEFAULT_ROLE_PERMISSIONS } from "../authorization/permissions.ts";
import { getDatabase } from "../database/client.ts";
import { ApplicationError } from "../errors/application-error.ts";

const roleCodes = Object.keys(DEFAULT_ROLE_PERMISSIONS) as [RoleCode, ...RoleCode[]];
const normalizedName = z.string().trim().transform((name) => name.replace(/\s+/g, " "))
  .pipe(z.string().min(1).max(160));
const normalizedEmail = z.string().trim().toLowerCase().email().max(254);

const createUserSchema = z.object({
  name: normalizedName,
  email: normalizedEmail,
  role: z.enum(roleCodes).default("OPERATOR"),
  googleAccessAllowed: z.boolean().default(false)
}).strict();

const updateUserSchema = z.object({
  name: normalizedName.optional(),
  role: z.enum(roleCodes).optional(),
  isActive: z.boolean().optional(),
  googleAccessAllowed: z.boolean().optional()
}).strict().refine((input) => Object.values(input).some((value) => value !== undefined));

const publicUserSelect = {
  id: true,
  name: true,
  email: true,
  isActive: true,
  googleAccessAllowed: true,
  role: { select: { code: true } },
  accounts: { where: { provider: "google" }, select: { id: true }, take: 1 }
} as const satisfies Prisma.UserSelect;

const managedUserSelect = {
  ...publicUserSelect,
  passwordHash: true,
  role: {
    select: {
      code: true,
      permissions: { select: { permission: { select: { code: true } } } }
    }
  }
} as const satisfies Prisma.UserSelect;

type PublicUserRecord = Prisma.UserGetPayload<{ select: typeof publicUserSelect }>;
type ManagedUserRecord = Prisma.UserGetPayload<{ select: typeof managedUserSelect }>;

export interface PublicUser {
  id: string;
  name: string | null;
  email: string;
  role: RoleCode;
  isActive: boolean;
  googleAccessAllowed: boolean;
  googleLinked: boolean;
}

function toPublicUser(user: PublicUserRecord): PublicUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role.code,
    isActive: user.isActive,
    googleAccessAllowed: user.googleAccessAllowed,
    googleLinked: user.accounts.length > 0
  };
}

function auditSnapshot(user: PublicUserRecord, permissions: string[]): Prisma.InputJsonObject {
  // Explicit allowlist: no password hash, account tokens, subject or session data.
  return {
    ...toPublicUser(user),
    permissions: [...permissions].sort()
  };
}

function permissionCodes(user: ManagedUserRecord): string[] {
  return user.role.permissions.map(({ permission }) => permission.code);
}

function validateId(id: string): string {
  const result = z.string().uuid().safeParse(id);
  if (!result.success) throw new ApplicationError("VALIDATION", "Identificador de usuário inválido.");
  return result.data;
}

async function runUserWrite<T>(actor: Principal, work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  assertPermission(actor, "users.manage");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      // The advisory lock serializes writes. READ COMMITTED gives the actor
      // check a fresh snapshot after waiting, including access revocations.
      return await getDatabase().$transaction(async (tx) => {
        // Acquire the management lock before checking the actor inside the transaction.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(2026103002)`;
        await assertActorInTransaction(tx, actor, "users.manage");
        return work(tx);
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5000, timeout: 15000 });
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === "P2034" && attempt < 2) continue;
        if (error.code === "P2002") {
          throw new ApplicationError("CONFLICT", "Já existe um usuário com esse e-mail.");
        }
        if (error.code === "P2034" || error.code === "P2028") {
          throw new ApplicationError("CONFLICT", "Outra operação alterou esses dados. Atualize a página e tente novamente.");
        }
      }
      throw new ApplicationError("CONFLICT", "Não foi possível concluir a operação de usuários. Tente novamente.");
    }
  }
  throw new ApplicationError("CONFLICT", "Não foi possível concluir a operação de usuários. Tente novamente.");
}

async function getRole(tx: Prisma.TransactionClient, code: RoleCode) {
  const role = await tx.role.findUnique({
    where: { code },
    select: { id: true, code: true, permissions: { select: { permission: { select: { code: true } } } } }
  });
  if (!role) {
    throw new ApplicationError("CONFLICT", "O perfil selecionado ainda não está disponível no sistema.");
  }
  return role;
}

async function protectAdministrativeAccess(
  tx: Prisma.TransactionClient,
  current: ManagedUserRecord,
  next: { role: RoleCode; isActive: boolean; googleAccessAllowed: boolean }
) {
  if (!current.isActive || current.role.code !== "ADMINISTRATOR") return;

  const remainsActiveAdministrator = next.isActive && next.role === "ADMINISTRATOR";
  if (!remainsActiveAdministrator) {
    const activeAdministrators = await tx.user.count({ where: { isActive: true, role: { code: "ADMINISTRATOR" } } });
    if (activeAdministrators <= 1) {
      throw new ApplicationError("CONFLICT", "É necessário manter pelo menos um administrador ativo.");
    }
  }

  const currentlyHasAccess = current.passwordHash !== null || (current.googleAccessAllowed && current.accounts.length > 0);
  const keepsAccess = remainsActiveAdministrator &&
    (current.passwordHash !== null || (next.googleAccessAllowed && current.accounts.length > 0));
  if (currentlyHasAccess && !keepsAccess) {
    const otherAccessibleAdministrators = await tx.user.count({
      where: {
        id: { not: current.id },
        isActive: true,
        role: { code: "ADMINISTRATOR" },
        OR: [
          { passwordHash: { not: null } },
          { googleAccessAllowed: true, accounts: { some: { provider: "google" } } }
        ]
      }
    });
    if (otherAccessibleAdministrators === 0) {
      throw new ApplicationError("CONFLICT", "Mantenha um administrador ativo com uma forma de acesso configurada.");
    }
  }
}

export async function listUsers(actor: Principal) {
  assertPermission(actor, "users.read");
  const database = getDatabase();
  const [users, roles, permissions] = await database.$transaction([
    database.user.findMany({ select: publicUserSelect, orderBy: [{ name: "asc" }, { email: "asc" }] }),
    database.role.findMany({ where: { code: { in: roleCodes } }, select: { code: true, name: true }, orderBy: { name: "asc" } }),
    database.permission.findMany({ select: { code: true, description: true }, orderBy: { code: "asc" } })
  ]);
  return { users: users.map(toPublicUser), roles, permissions };
}

export async function createUser(actor: Principal, input: unknown): Promise<PublicUser> {
  assertPermission(actor, "users.manage");
  const parsed = createUserSchema.safeParse(input);
  if (!parsed.success) throw new ApplicationError("VALIDATION", "Dados do usuário inválidos.");
  const data = parsed.data;
  if (data.role !== "OPERATOR") assertPermission(actor, "roles.manage");

  const user = await runUserWrite(actor, async (tx) => {
    if (data.role !== "OPERATOR") await assertActorInTransaction(tx, actor, "roles.manage");
    const role = await getRole(tx, data.role);
    const created = await tx.user.create({
      data: { name: data.name, email: data.email, roleId: role.id, googleAccessAllowed: data.googleAccessAllowed },
      select: publicUserSelect
    });
    await tx.auditEvent.create({
      data: {
        actorId: actor.id,
        action: "CREATE",
        module: "USERS",
        entityType: "User",
        entityId: created.id,
        newValues: auditSnapshot(created, role.permissions.map(({ permission }) => permission.code))
      }
    });
    return toPublicUser(created);
  });

  try {
    await sendActivationEmail(user.id);
  } catch {
    throw new ApplicationError("CONFLICT", "Usuário criado, mas não foi possível enviar a ativação. Utilize a opção de reenviar ativação.");
  }
  return user;
}

export async function updateUser(actor: Principal, id: string, input: unknown): Promise<PublicUser> {
  assertPermission(actor, "users.manage");
  const userId = validateId(id);
  const parsed = updateUserSchema.safeParse(input);
  if (!parsed.success) throw new ApplicationError("VALIDATION", "Dados de atualização do usuário inválidos.");
  const data = parsed.data;

  return runUserWrite(actor, async (tx) => {
    const current = await tx.user.findUnique({ where: { id: userId }, select: managedUserSelect });
    if (!current) throw new ApplicationError("NOT_FOUND", "Usuário não encontrado.");

    const nextRoleCode = data.role ?? current.role.code;
    if (data.role !== undefined && (data.role !== "OPERATOR" || data.role !== current.role.code)) {
      await assertActorInTransaction(tx, actor, "roles.manage");
    }
    const next = {
      role: nextRoleCode,
      isActive: data.isActive ?? current.isActive,
      googleAccessAllowed: data.googleAccessAllowed ?? current.googleAccessAllowed
    };
    await protectAdministrativeAccess(tx, current, next);

    const authorizationChanged = next.role !== current.role.code || next.isActive !== current.isActive ||
      next.googleAccessAllowed !== current.googleAccessAllowed;
    if (!authorizationChanged && (data.name === undefined || data.name === current.name)) return toPublicUser(current);

    const role = await getRole(tx, next.role);
    const updated = await tx.user.update({
      where: { id: userId },
      data: {
        name: data.name,
        roleId: role.id,
        isActive: next.isActive,
        googleAccessAllowed: next.googleAccessAllowed,
        ...(authorizationChanged ? { sessionVersion: { increment: 1 } } : {})
      },
      select: publicUserSelect
    });
    if (authorizationChanged) {
      await tx.loginSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
      await tx.accessToken.updateMany({ where: { userId, usedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
    }
    await tx.auditEvent.create({
      data: {
        actorId: actor.id,
        action: current.isActive === next.isActive ? "UPDATE" : next.isActive ? "ACTIVATE" : "DEACTIVATE",
        module: "USERS",
        entityType: "User",
        entityId: userId,
        previousValues: auditSnapshot(current, permissionCodes(current)),
        newValues: auditSnapshot(updated, role.permissions.map(({ permission }) => permission.code))
      }
    });
    return toPublicUser(updated);
  });
}

export async function resendActivation(actor: Principal, id: string): Promise<{ sent: true }> {
  assertPermission(actor, "users.manage");
  const userId = validateId(id);
  await runUserWrite(actor, async (tx) => {
    const user = await tx.user.findUnique({ where: { id: userId }, select: managedUserSelect });
    if (!user) throw new ApplicationError("NOT_FOUND", "Usuário não encontrado.");
    if (!user.isActive) throw new ApplicationError("CONFLICT", "Ative o usuário antes de reenviar a ativação.");
    if (user.passwordHash !== null) {
      throw new ApplicationError("CONFLICT", "O usuário já definiu uma senha. Utilize a recuperação de senha.");
    }
    await tx.auditEvent.create({
      data: {
        actorId: actor.id,
        action: "UPDATE",
        module: "USERS",
        entityType: "User",
        entityId: userId,
        origin: "users.resend_activation",
        newValues: { ...auditSnapshot(user, permissionCodes(user)), activationEmailRequested: true }
      }
    });
  });

  try {
    await sendActivationEmail(userId);
  } catch {
    throw new ApplicationError("CONFLICT", "Não foi possível enviar a ativação. O cadastro foi preservado; tente reenviar.");
  }
  return { sent: true };
}
