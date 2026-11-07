import { describe, expect, it } from "vitest";
import { withTransferResource } from "../../src/server/transfers/resource-limit.ts";

describe("limite efêmero do processamento de arquivos", () => {
  it("permite dois trabalhos, recusa o terceiro sem iniciá-lo e libera a vaga", async () => {
    let releaseFirst!: () => void; let releaseSecond!: () => void; let thirdStarted = false;
    const first = withTransferResource(() => new Promise<void>((resolve) => { releaseFirst = resolve; }));
    const second = withTransferResource(() => new Promise<void>((resolve) => { releaseSecond = resolve; }));
    try {
      await expect(withTransferResource(async () => { thirdStarted = true; })).rejects.toMatchObject({ code: "UNAVAILABLE" });
      expect(thirdStarted).toBe(false);
      releaseFirst(); await first;
      await expect(withTransferResource(async () => "concluído")).resolves.toBe("concluído");
    } finally { releaseFirst(); releaseSecond(); await Promise.all([first, second]); }
  });
  it("libera o recurso depois de erro ou exceção síncrona", async () => {
    await expect(withTransferResource(async () => { throw new Error("controlled-failure"); })).rejects.toThrow("controlled-failure");
    await expect(withTransferResource(() => { throw new Error("synchronous-failure"); })).rejects.toThrow("synchronous-failure");
    await expect(Promise.all([withTransferResource(async () => 1), withTransferResource(async () => 2)])).resolves.toEqual([1, 2]);
  });
});
