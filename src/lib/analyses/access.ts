export const canViewAnalyses = (permissions: readonly string[]) => permissions.includes("reports.read") && permissions.includes("stock.read");
