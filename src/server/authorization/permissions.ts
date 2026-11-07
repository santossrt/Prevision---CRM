import type { RoleCode } from "../../generated/prisma/enums.ts";

export const PERMISSIONS = [
  "users.read",
  "users.manage",
  "roles.manage",
  "audit.read",
  "catalog.read",
  "catalog.write",
  "stock.read",
  "stock.write",
  "stock.adjust",
  "reports.read",
  "settings.manage"
] as const;

export type PermissionCode = (typeof PERMISSIONS)[number];

export const DEFAULT_ROLE_PERMISSIONS: Readonly<Record<RoleCode, readonly PermissionCode[]>> = {
  ADMINISTRATOR: PERMISSIONS,
  MANAGER: [
    "users.read", "audit.read", "catalog.read", "catalog.write",
    "stock.read", "stock.write", "stock.adjust", "reports.read"
  ],
  OPERATOR: ["catalog.read", "catalog.write", "stock.read", "stock.write", "reports.read"]
};
