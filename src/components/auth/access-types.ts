export type WorkspaceIdentity = {
  id: string;
  name: string | null;
  email: string;
  role: "ADMINISTRATOR" | "MANAGER" | "OPERATOR";
  permissions: string[];
  googleLinked: boolean;
  hasPassword: boolean;
  googleAccessAllowed: boolean;
};

export const roleLabels: Record<WorkspaceIdentity["role"], string> = {
  ADMINISTRATOR: "Administrador",
  MANAGER: "Gerente",
  OPERATOR: "Operador",
};
