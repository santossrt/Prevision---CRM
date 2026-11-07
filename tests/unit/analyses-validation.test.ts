import { describe, expect, it } from "vitest";
import { analysisPeriodDays, parseAnalysisFilters } from "../../src/server/analyses/validation.ts";

const now = new Date("2026-11-06T12:00:00Z");
describe("filtros das análises", () => {
  it("usa 90 dias civis de São Paulo e normaliza os percentuais", () => {
    expect(parseAnalysisFilters(new URLSearchParams("thresholdA=8&thresholdB=90.5"), now)).toEqual({ from: "2026-08-09", to: "2026-11-06", search: "", status: "all", thresholdA: "8.00", thresholdB: "90.50", horizonDays: 30 });
    expect(parseAnalysisFilters(new URLSearchParams(), new Date("2026-11-06T02:59:59Z")).to).toBe("2026-11-05");
  });
  it("aceita ano bissexto, limites em centésimos e horizonte explícito", () => {
    const filters = parseAnalysisFilters(new URLSearchParams("from=2024-02-29&to=2025-02-28&thresholdA=0.01&thresholdB=99.99&horizonDays=365&status=inactive&search=%20café%20"), now);
    expect(analysisPeriodDays(filters.from, filters.to)).toBe(366);
    expect(filters).toMatchObject({ thresholdA: "0.01", thresholdB: "99.99", horizonDays: 365, status: "inactive", search: "café" });
  });
  it.each([
    "from=2026-10-01", "to=2026-10-01", "from=2026-02-30&to=2026-03-01", "from=0000-01-01&to=0000-01-02",
    "from=2026-10-02&to=2026-10-01", "from=2026-11-06&to=2026-11-07", "from=2024-01-01&to=2025-01-01",
    "thresholdA=0", "thresholdA=95&thresholdB=95", "thresholdB=100", "thresholdA=1.234", "thresholdA=80&thresholdA=70",
    "horizonDays=0", "horizonDays=366", "horizonDays=1.5", "horizonDays=", "status=other", "source=private", "search=%00"
  ])("recusa período ou critérios ambíguos: %s", (search) => {
    expect(() => parseAnalysisFilters(new URLSearchParams(search), now)).toThrow();
  });
});
