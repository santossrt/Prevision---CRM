import type { Metadata } from "next";
import type { ReactNode } from "react";
import { requestTheme } from "@/server/preferences/request-theme";
import "./globals.css";
import "./access.css";
import "./catalog.css";
import "./stock.css";
import "./stock-alerts.css";
import "./inventory.css";
import "./audit.css";
import "./transfers.css";
import "./notifications.css";
import "./dashboard.css";
import "./analyses.css";
import "./theme.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { default: "Prevision — Gestão de estoque", template: "%s | Prevision" },
  description: "Um espaço para organizar produtos, acompanhar o estoque e planejar os próximos passos do seu negócio.",
  applicationName: "Prevision",
};

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  const theme = await requestTheme();
  return <html lang="pt-BR" data-scroll-behavior="smooth" data-theme={theme} suppressHydrationWarning><body>{children}</body></html>;
}
