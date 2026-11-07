"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import { Icon, type IconName } from "@/components/ui/icon";
import { errorMessage, sendJson } from "@/components/auth/client-api";
import { roleLabels, type WorkspaceIdentity } from "@/components/auth/access-types";
import { NotificationBell } from "@/components/notifications/notification-bell";
import { ThemeControl } from "@/components/preferences/theme-control";
import { canUseTransfers } from "@/lib/transfers/access";
import { canViewAnalyses } from "@/lib/analyses/access";

const navigation: { href: string; label: string; icon: IconName; permission?: string }[] = [
  { href: "/#visao-geral", label: "Visão geral", icon: "overview" },
  { href: "/produtos", label: "Produtos", icon: "package", permission: "catalog.read" },
  { href: "/categorias", label: "Categorias", icon: "layers", permission: "catalog.read" },
  { href: "/fornecedores", label: "Fornecedores", icon: "partners", permission: "catalog.read" },
  { href: "/clientes", label: "Clientes", icon: "partners", permission: "catalog.read" },
  { href: "/estoque", label: "Controle de estoque", icon: "movement", permission: "stock.read" },
  { href: "/inventarios", label: "Inventários", icon: "inventory", permission: "stock.read" },
  { href: "/auditoria", label: "Auditoria", icon: "shield", permission: "audit.read" },
  { href: "/transferencias", label: "Importar e exportar", icon: "chart" },
  { href: "/notificacoes", label: "Notificações", icon: "layers" },
  { href: "/configuracoes", label: "Configurações", icon: "settings" },
  { href: "/analises", label: "Curva ABC e reposição", icon: "forecast" },
];

function SidebarContent({ onNavigate, mobile = false, identity, pathname }: { onNavigate?: () => void; mobile?: boolean; identity?: WorkspaceIdentity; pathname: string }) {
  return (
    <>
      <div className="sidebar-brand-row">
        <Link href="/" className="brand" aria-label="Prevision, início" onClick={onNavigate}>
          <span className="brand-symbol"><Icon name="package" /></span>
          <span>prevision<span className="brand-period">.</span></span>
        </Link>
        {mobile && <button type="button" className="icon-button drawer-close" aria-label="Fechar navegação" onClick={onNavigate}><Icon name="close" /></button>}
      </div>

      <div className="workspace-label"><span className="workspace-monogram">P</span><div><strong>Meu ambiente</strong><span>Gestão de estoque</span></div><span className="workspace-dot" /></div>

      <nav aria-label="Navegação principal" className="sidebar-navigation">
        <p className="sidebar-caption">SEU ESPAÇO</p>
        {navigation.filter((item) => item.href === "/transferencias" ? canUseTransfers(identity?.permissions ?? []) : item.href === "/analises" ? canViewAnalyses(identity?.permissions ?? []) : !item.permission || identity?.permissions.includes(item.permission)).map((item) => (
          <Link key={item.href} href={item.href} className={`sidebar-link${pathname === item.href || (item.href === "/#visao-geral" && pathname === "/") ? " sidebar-link-home" : ""}`} onClick={onNavigate} aria-current={pathname === item.href || (item.href === "/#visao-geral" && pathname === "/") ? "page" : undefined}>
            <Icon name={item.icon} /><span>{item.label}</span>{(pathname === item.href || (item.href === "/#visao-geral" && pathname === "/")) && <span className="navigation-indicator" />}
          </Link>
        ))}
        {identity && <><p className="sidebar-caption access-nav-caption">EQUIPE E ACESSO</p>{identity.permissions.includes("users.manage") && <Link href="/usuarios" className={`sidebar-link${pathname === "/usuarios" ? " sidebar-link-home" : ""}`} onClick={onNavigate} aria-current={pathname === "/usuarios" ? "page" : undefined}><Icon name="partners" /><span>Usuários</span></Link>}<Link href="/perfil" className={`sidebar-link${pathname === "/perfil" ? " sidebar-link-home" : ""}`} onClick={onNavigate} aria-current={pathname === "/perfil" ? "page" : undefined}><Icon name="shield" /><span>Meu perfil</span></Link></>}
      </nav>

      <div className="sidebar-bottom">
        <div className="sidebar-note"><span className="note-spark">✳</span><p>Mais clareza.<br /><strong>Melhores decisões.</strong></p><span>Uma nova forma de olhar<br />para o seu estoque.</span></div>
        <div className="sidebar-footer"><span className="footer-mark">P</span><span>PREVISION<span>Organize. Acompanhe. Planeje.</span></span></div>
      </div>
    </>
  );
}

export function WorkspaceShell({ children, identity }: { children: ReactNode; identity?: WorkspaceIdentity }) {
  const drawerRef = useRef<HTMLDialogElement>(null);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [logoutPending, setLogoutPending] = useState(false);
  const [logoutError, setLogoutError] = useState("");
  const pathname = usePathname();
  const pageLabels: Record<string, string> = { "/usuarios": "Usuários", "/perfil": "Meu perfil", "/produtos": "Produtos", "/categorias": "Categorias", "/fornecedores": "Fornecedores", "/clientes": "Clientes", "/estoque": "Controle de estoque", "/inventarios": "Inventários", "/auditoria": "Auditoria", "/transferencias": "Importar e exportar", "/notificacoes": "Notificações", "/configuracoes": "Configurações", "/analises": "Curva ABC e reposição" };
  const pageLabel = pageLabels[pathname] ?? "Visão geral";

  async function logout() {
    setLogoutPending(true); setLogoutError("");
    try { await sendJson("/api/access/logout", {}); await signOut({ redirectTo: "/login" }); } catch (failure) { setLogoutError(errorMessage(failure)); setLogoutPending(false); }
  }

  useEffect(() => {
    const breakpoint = window.matchMedia("(min-width: 1100px)");
    const handleBreakpoint = () => {
      if (breakpoint.matches) drawerRef.current?.close();
    };
    breakpoint.addEventListener("change", handleBreakpoint);
    return () => breakpoint.removeEventListener("change", handleBreakpoint);
  }, []);

  useEffect(() => {
    if (!navigationOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previousOverflow; };
  }, [navigationOpen]);

  const closeNavigation = () => drawerRef.current?.close();
  const openNavigation = () => {
    drawerRef.current?.showModal();
    setNavigationOpen(true);
  };

  return (
    <div className="workspace-shell">
      <a className="skip-link" href="#conteudo">Ir para o conteúdo</a>
      <aside className="desktop-sidebar"><SidebarContent identity={identity} pathname={pathname} /></aside>
      <dialog id="mobile-navigation" ref={drawerRef} className="mobile-drawer" aria-label="Menu de navegação" onClose={() => setNavigationOpen(false)} onClick={(event) => { if (event.target === event.currentTarget) closeNavigation(); }}>
        <div className="mobile-drawer-inner"><SidebarContent mobile onNavigate={closeNavigation} identity={identity} pathname={pathname} /></div>
      </dialog>
      <div className="workspace-body">
        <header className="topbar">
          <div className="topbar-location"><button type="button" className="icon-button mobile-menu-button" aria-label="Abrir navegação" aria-controls="mobile-navigation" aria-expanded={navigationOpen} onClick={openNavigation}><Icon name="menu" /></button><span className="breadcrumb-root">Meu ambiente</span><Icon name="chevron-right" className="breadcrumb-chevron" /><span>{pageLabel}</span></div>
          <div className="topbar-meta">{identity ? <><ThemeControl /><NotificationBell ownerId={identity.id} /><Link href="/perfil" className="topbar-person"><span className="topbar-avatar" aria-hidden="true">{(identity.name || identity.email).slice(0, 1).toLocaleUpperCase("pt-BR")}</span><span className="topbar-person-text"><strong>{identity.name || identity.email}</strong><span>{roleLabels[identity.role]}</span></span></Link><button type="button" className="logout-button" disabled={logoutPending} onClick={() => void logout()}>{logoutPending ? "Saindo…" : "Sair"}<Icon name="arrow-right" /></button></> : <span className="topbar-avatar" aria-label="Prevision">P</span>}</div>
        </header>
        {logoutError && <p className="shell-error form-message form-error" role="alert">{logoutError}</p>}
        <main id="conteudo" className="main-content" tabIndex={-1}>{children}</main>
        <footer className="page-footer"><span>© Prevision</span><span>Seu estoque. Sua visão de futuro.</span></footer>
      </div>
    </div>
  );
}
