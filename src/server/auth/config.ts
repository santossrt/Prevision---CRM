import "server-only";
import { randomBytes } from "node:crypto";
import NextAuth, { type NextAuthConfig } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { getToken } from "next-auth/jwt";
import { getDatabase } from "../database/client.ts";
import { verifyDatabaseIdentity } from "../database/identity.ts";
import { hashPassword, passwordSchema, verifyPassword } from "../security/password.ts";
import { consumeRateLimit } from "../security/rate-limit.ts";
import { readCookie } from "../security/csrf.ts";
import { requestOrigin } from "../security/http.ts";
import { emailSchema, getAuthCapabilities, getAuthSettings, sessionCookieName } from "./settings.ts";
import { authorizeGoogleIdentity } from "./access-tokens.ts";
import { findSessionPrincipal, publicIdentity } from "./identity.ts";
import { createLoginSession, revokeLoginSession } from "./sessions.ts";

let dummyPasswordHash: Promise<string> | undefined;

export const { handlers, auth } = NextAuth((request) => {
  const settings = getAuthSettings();
  const db = getDatabase();
  const adapter = PrismaAdapter(db);
  return {
    adapter: {
      ...adapter,
      async createUser() { throw new Error("Usuários precisam ser previamente autorizados."); },
      async linkAccount() { throw new Error("A vinculação exige um fluxo explícito de autorização."); },
      async deleteUser() { throw new Error("Usuários são desativados para preservar o histórico."); }
    },
    secret: settings.secret, trustHost: true, useSecureCookies: settings.secure,
    session: { strategy: "jwt", maxAge: settings.sessionSeconds },
    cookies: { sessionToken: { name: sessionCookieName(), options: { httpOnly: true, sameSite: "lax", path: "/", secure: settings.secure } } },
    pages: { signIn: "/login", error: "/login" },
    providers: [Credentials({
      credentials: { email: {}, password: {} },
      async authorize(credentials, request) {
        const ipRate = await consumeRateLimit(["login-ip", requestOrigin(request)], 120, 900);
        const email = emailSchema.safeParse(credentials.email);
        const password = passwordSchema.safeParse(credentials.password);
        if (!ipRate.allowed || !email.success || !password.success) return null;
        const accountRate = await consumeRateLimit(["login-account", email.data], 12, 900);
        if (!accountRate.allowed) return null;
        await verifyDatabaseIdentity();
        const user = await db.user.findUnique({ where: { email: email.data } });
        dummyPasswordHash ??= hashPassword(randomBytes(32).toString("hex"));
        const matched = await verifyPassword(user?.passwordHash ?? await dummyPasswordHash, password.data);
        if (!matched || !user?.isActive || !user.passwordHash) {
          await db.auditEvent.create({ data: { actorId: user?.id, action: "LOGIN_FAILURE", module: "AUTH", entityType: "User", origin: requestOrigin(request) } });
          return null;
        }
        return { id: user.id, name: user.name, email: user.email, sessionVersion: user.sessionVersion };
      }
    }), ...(getAuthCapabilities().google ? [Google({ clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET, checks: ["pkce", "state"], authorization: { params: { scope: "openid email profile", prompt: "select_account" } }, allowDangerousEmailAccountLinking: false })] : [])],
    callbacks: {
      async signIn({ user, account, profile }) {
        if (account?.provider !== "google") return Boolean(user.id);
        if (!request || !profile) return false;
        if (account.providerAccountId !== profile.sub) return false;
        const token = await getToken({ req: request, secret: settings.secret, cookieName: sessionCookieName(), salt: sessionCookieName() });
        const grant = readCookie(request.headers.get("cookie") ?? "", "prevision.google-link");
        const allowed = await authorizeGoogleIdentity({ subject: String(profile.sub ?? ""), email: String(profile.email ?? ""), verified: profile.email_verified === true }, grant || undefined, token?.sub);
        if (!allowed) await db.auditEvent.create({ data: { action: "LOGIN_FAILURE", module: "AUTH", entityType: "User", origin: requestOrigin(request) } });
        return Boolean(allowed);
      },
      async jwt({ token, user, account }) {
        if (user?.id) {
          const session = await createLoginSession(user.id, account?.provider ?? "credentials", request ? requestOrigin(request) : "server", (user as typeof user & { sessionVersion?: number }).sessionVersion);
          return { ...token, sub: user.id, sid: session.id, version: session.sessionVersion };
        }
        return await findSessionPrincipal(token.sid, { sub: token.sub, version: token.version }) ? token : null;
      },
      async session({ session, token }) {
        const principal = await findSessionPrincipal(token.sid, { sub: token.sub, version: token.version }, false);
        if (!principal) throw new Error("Sessão inválida.");
        return { ...session, user: publicIdentity(principal) };
      },
      async redirect({ url }) {
        try { const target = new URL(url, settings.url); return target.origin === settings.url.origin ? target.href : settings.url.origin; }
        catch { return settings.url.origin; }
      }
    },
    events: { async signOut(event) { if ("token" in event && event.token) await revokeLoginSession(event.token.sid, event.token.sub); } },
    logger: { error(error) { console.error("[auth]", "type" in error && typeof error.type === "string" ? error.type : error.name); }, warn(code) { console.warn("[auth]", code); }, debug() {} }
  } satisfies NextAuthConfig;
});
