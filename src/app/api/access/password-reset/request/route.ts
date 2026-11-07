import { setTimeout } from "node:timers/promises";
import { after } from "next/server";
import { z } from "zod";
import { enqueuePasswordReset, processPasswordResetJobs } from "@/server/auth/password-reset-jobs";
import { emailSchema } from "@/server/auth/settings";
import { errorResponse, limitRequest, readJson } from "@/server/security/http";
import { consumeRateLimit } from "@/server/security/rate-limit";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const started = Date.now();
  try {
    const body = z.object({ email: emailSchema }).strict().parse(await readJson(request));
    await limitRequest(request, "reset-ip", 20, 900);
    const accountRate = await consumeRateLimit(["reset-account", body.email], 3, 3600);
    if (accountRate.allowed) {
      const jobId = await enqueuePasswordReset(body.email);
      after(async () => {
        try { await processPasswordResetJobs({ limit: 1, jobId }); }
        catch { console.error("[mail] Processamento de recuperação adiado; dados pessoais e tokens foram omitidos."); }
      });
    }
    await setTimeout(Math.max(0, 600 - (Date.now() - started)));
    return Response.json({ message: "Se houver uma conta elegível, você receberá instruções. Contas exclusivamente Google recuperam o acesso pelo Google." }, { status: 202 });
  } catch (error) { return errorResponse(error); }
}
