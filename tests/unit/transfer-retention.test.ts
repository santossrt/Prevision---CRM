import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "../../src/generated/prisma/client.ts";
import type { Principal } from "../../src/server/auth/identity.ts";
import { ApplicationError } from "../../src/server/errors/application-error.ts";
import { prepareTransferRetention, purgeExpiredTransferPayloads, reserveTransferPayload, transferPayloadLimits } from "../../src/server/transfers/retention.ts";

const state = vi.hoisted(() => ({ database: {} as Record<string, unknown>, authorize: vi.fn() }));
vi.mock("../../src/server/database/client.ts", () => ({ getDatabase: () => state.database }));
vi.mock("../../src/server/database/identity.ts", () => ({ verifyDatabaseIdentity: vi.fn() }));
vi.mock("../../src/server/authorization/guard.ts", () => ({ assertActorInTransaction: state.authorize }));
const owner = "00000000-0000-4000-8000-000000000001";
const actor = { id: owner } as Principal;
const usage = () => ({ ownerCount: 0n, ownerBytes: 0n, globalBytes: 0n, incomingBytes: 32n });
const sqlText = (call: readonly unknown[]) => (call[0] as TemplateStringsArray).join("$parameter");
function fixture(values = usage()) {
  const tx = { $executeRaw: vi.fn().mockResolvedValue(0), $queryRaw: vi.fn().mockResolvedValue([values]) };
  return { tx, typed: tx as unknown as Prisma.TransactionClient };
}
beforeEach(() => state.authorize.mockReset().mockResolvedValue(undefined));

describe("quotas de conteúdo temporário", () => {
  it("conta o JSON persistido no PostgreSQL e inclui o passivo expirado, preservando importações concluídas", async () => {
    const { tx, typed } = fixture();
    await reserveTransferPayload(typed, owner, { name: "Produto" });
    expect(sqlText(tx.$executeRaw.mock.calls[0])).toContain("pg_advisory_xact_lock(202611060012");
    expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.$queryRaw.mock.invocationCallOrder[0]);
    const statement = tx.$queryRaw.mock.calls[0];
    expect(sqlText(statement)).toContain("octet_length(payload::text)");
    expect(sqlText(statement)).toContain("status='PREVIEW'");
    expect(sqlText(statement)).not.toContain("expires_at>");
    expect(statement.slice(1)).toContain(owner); expect(statement.slice(1)).toContain(JSON.stringify({ name: "Produto" }));
  });
  it.each([
    { ownerCount: transferPayloadLimits.ownerCount },
    { ownerBytes: transferPayloadLimits.ownerBytes - 31n },
    { globalBytes: transferPayloadLimits.globalBytes - 31n }
  ])("recusa quota excedida sem arredondar bytes", async (values) => {
    const { typed } = fixture({ ...usage(), ...values });
    await expect(reserveTransferPayload(typed, owner, { name: "P" })).rejects.toBeInstanceOf(ApplicationError);
  });
  it("aceita exatamente o teto de bytes", async () => {
    const { typed } = fixture({ ...usage(), ownerCount: 99n, ownerBytes: transferPayloadLimits.ownerBytes - 32n, globalBytes: transferPayloadLimits.globalBytes - 32n });
    await expect(reserveTransferPayload(typed, owner, { name: "P" })).resolves.toBeUndefined();
  });
  it.each([[], [{ ...usage(), ownerCount: -1n }], [{ ...usage(), incomingBytes: 32 }]].map((result) => ({ result })))("falha fechada se a contabilidade não for confiável", async ({ result }) => {
    const { tx, typed } = fixture(); tx.$queryRaw.mockResolvedValueOnce(result);
    await expect(reserveTransferPayload(typed, owner, {})).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });
  it("serializa duas admissões que disputam a última vaga", async () => {
    let count = 99n; let last = Promise.resolve(); let successful = 0;
    const create = async () => {
      let release!: () => void;
      const predecessor = last; last = new Promise<void>((accept) => { release = accept; });
      const tx = {
        $executeRaw: vi.fn(async () => { await predecessor; return 0; }),
        $queryRaw: vi.fn(async () => [{ ...usage(), ownerCount: count }])
      };
      try { await reserveTransferPayload(tx as unknown as Prisma.TransactionClient, owner, { id: "same-owner" }); count++; successful++; }
      finally { release(); }
    };
    const results = await Promise.allSettled([create(), create()]);
    expect(successful).toBe(1); expect(count).toBe(100n);
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
  });
});

describe("expurgo restrito de prévias expiradas", () => {
  it("limita o lote global e remove somente o payload de prévias vencidas", async () => {
    const { tx, typed } = fixture(); tx.$queryRaw.mockResolvedValueOnce([{ cleared: 100n }]);
    expect(await purgeExpiredTransferPayloads(typed)).toBe(100);
    const sql = sqlText(tx.$queryRaw.mock.calls[0]);
    expect(sql).toContain("LIMIT 100"); expect(sql).toContain("status='PREVIEW'");
    expect(sql).toContain("SET payload='{}'::jsonb"); expect(sql).toContain("expires_at<=clock_timestamp()");
    expect(sql).not.toMatch(/DELETE|TRUNCATE/u);
  });
  it.each([[], [{ cleared: -1n }], [{ cleared: 101n }]].map((result) => ({ result })))("recusa resultado de lote incoerente", async ({ result }) => {
    const { tx, typed } = fixture(); tx.$queryRaw.mockResolvedValueOnce(result);
    await expect(purgeExpiredTransferPayloads(typed)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });
  it("confirma a limpeza em transação separada com permissões atuais e ordem de locks", async () => {
    const { tx, typed } = fixture(); tx.$queryRaw.mockResolvedValue([{ cleared: 1n }]);
    const transaction = vi.fn(async (work: (value: Prisma.TransactionClient) => Promise<void>, _options: unknown) => work(typed));
    state.database = { $transaction: transaction };
    await prepareTransferRetention(actor, ["reports.read", "stock.read"]);
    expect(transaction.mock.calls[0][1]).toMatchObject({ isolationLevel: "ReadCommitted" });
    expect(state.authorize.mock.calls.map((call) => call[2])).toEqual(["reports.read", "stock.read"]);
    expect(tx.$executeRaw.mock.calls.map(sqlText)).toEqual([
      "SELECT pg_advisory_xact_lock_shared(2026103002)", "SELECT pg_advisory_xact_lock_shared(2026103003)", "SELECT pg_advisory_xact_lock(202611060012::bigint)"
    ]);
    expect(tx.$executeRaw.mock.invocationCallOrder[1]).toBeLessThan(state.authorize.mock.invocationCallOrder[0]);
    expect(state.authorize.mock.invocationCallOrder[1]).toBeLessThan(tx.$executeRaw.mock.invocationCallOrder[2]);
    // A separate creation transaction can now be refused without rolling this
    // successfully completed maintenance transaction back.
    const denied = fixture({ ...usage(), ownerCount: 100n });
    await expect(reserveTransferPayload(denied.typed, owner, {})).rejects.toMatchObject({ code: "VALIDATION" });
    expect(transaction).toHaveBeenCalledOnce();
  });
  it("não faz expurgo com permissão revogada", async () => {
    const { tx, typed } = fixture(); state.authorize.mockRejectedValueOnce(new ApplicationError("FORBIDDEN", "Sem acesso."));
    state.database = { $transaction: async (work: (value: Prisma.TransactionClient) => unknown) => work(typed) };
    await expect(prepareTransferRetention(actor, ["reports.read"])).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(tx.$queryRaw).not.toHaveBeenCalled(); expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
  });
});
