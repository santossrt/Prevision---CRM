import { describe, expect, it } from "vitest";
import { dashboardBuckets, dashboardToday, parseDashboardPeriod } from "../../src/server/dashboard/validation.ts";

describe("períodos dos indicadores", () => {
  const now = new Date("2026-11-06T16:00:00Z");
  it("o padrão tem trinta dias civis na zona informada, inclusive o dia atual", () => {
    expect(parseDashboardPeriod(new URLSearchParams(), now)).toEqual({ from: "2026-10-08", to: "2026-11-06", granularity: "day", timeZone: "America/Sao_Paulo" });
    expect(dashboardToday(new Date("2026-11-06T02:59:59Z"))).toBe("2026-11-05");
    expect(dashboardToday(new Date("2026-11-06T03:00:00Z"))).toBe("2026-11-06");
  });
  it.each([
    "from=2026-11-01", "to=2026-11-01", "from=&to=", "from=2026-02-30&to=2026-03-01",
    "from=2025-02-29&to=2025-03-01", "from=2026-1-01&to=2026-01-02", "from=0000-01-01&to=0000-01-02",
    "from=2026-11-07&to=2026-11-07", "from=2026-11-02&to=2026-11-01", "from=2025-01-01&to=2026-11-01",
    "from=2026-11-01T00%3A00%3A00Z&to=2026-11-02", "from=2026-10-01&from=2026-11-01&to=2026-11-02",
    "from=&from=2026-11-01&to=2026-11-02", "categoryId=other", "__proto__=other"
  ])("recusa datas inválidas, incompletas, excessivas ou filtros ambíguos: %s", (value) => {
    expect(() => parseDashboardPeriod(new URLSearchParams(value), now)).toThrow();
  });
  it("conserva dias sem movimento, inclusive fevereiro bissexto", () => {
    const period = parseDashboardPeriod(new URLSearchParams("from=2024-02-28&to=2024-03-01"), now);
    expect(dashboardBuckets(period)).toEqual([
      { from: "2024-02-28", to: "2024-02-28" }, { from: "2024-02-29", to: "2024-02-29" }, { from: "2024-03-01", to: "2024-03-01" }
    ]);
  });
  it("agrupa períodos maiores por mês e mantém as extremidades selecionadas", () => {
    const period = parseDashboardPeriod(new URLSearchParams("from=2026-01-20&to=2026-03-05"), now);
    expect(period.granularity).toBe("month");
    expect(dashboardBuckets(period)).toEqual([
      { from: "2026-01-20", to: "2026-01-31" }, { from: "2026-02-01", to: "2026-02-28" }, { from: "2026-03-01", to: "2026-03-05" }
    ]);
  });
  it("aceita o limite de 366 dias sem ultrapassá-lo em um dia", () => {
    const period = parseDashboardPeriod(new URLSearchParams("from=2024-01-01&to=2024-12-31"), now);
    expect(dashboardBuckets(period)).toHaveLength(12);
    expect(() => parseDashboardPeriod(new URLSearchParams("from=2023-12-31&to=2024-12-31"), now)).toThrow();
  });
});
