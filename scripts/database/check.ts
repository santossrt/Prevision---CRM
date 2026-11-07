import type { NextAuthConfig } from "next-auth";
import Google from "next-auth/providers/google";
import Credentials from "next-auth/providers/credentials";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { getDatabase } from "../../src/server/database/client.ts";
import { verifyDatabaseIdentity } from "../../src/server/database/identity.ts";
import { reportDatabaseFailure } from "./shared.ts";

async function check() {
  const database = getDatabase();
  try {
    await database.$queryRaw`SELECT 1`;
    await verifyDatabaseIdentity();
    const adapter = PrismaAdapter(database);
    // Prova de tipos e leitura do adapter; o fluxo HTTP tem verificação própria.
    const contract = {
      adapter,
      session: { strategy: "jwt" },
      providers: [Google, Credentials({ authorize: () => null })]
    } satisfies NextAuthConfig;
    if (contract.session.strategy !== "jwt" || !adapter.getUser) throw new Error("Contrato Auth.js incompatível.");
    await adapter.getUser("00000000-0000-0000-0000-000000000000");
    console.info("PostgreSQL: conexão e identidade válidas.");
    console.info("Prisma 7 + Auth.js: contrato JWT e leitura do PrismaAdapter validados.");
  } finally {
    await database.$disconnect();
  }
}

check().catch((error: unknown) => reportDatabaseFailure("Verificação interrompida", error));
