import { config } from "dotenv";
import { defineConfig } from "prisma/config";

config({ path: ".env", quiet: true });

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  // Sem conexão em generate/build. Comandos de banco exigem DIRECT_URL real.
  datasource: { url: process.env.DIRECT_URL ?? "" }
});
