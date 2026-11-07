import type { ReactNode } from "react";
import { requireIdentity } from "@/server/auth/identity";

export default async function ProtectedLayout({ children }: { children: ReactNode }) {
  await requireIdentity();
  return children;
}
