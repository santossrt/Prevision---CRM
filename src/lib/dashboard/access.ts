export const canViewDashboard = (permissions: readonly string[]) => permissions.includes("reports.read") && permissions.includes("stock.read");
