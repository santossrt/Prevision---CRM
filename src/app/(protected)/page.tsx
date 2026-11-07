import { WorkspaceShell } from "@/components/layout/workspace-shell";
import { Icon, type IconName } from "@/components/ui/icon";
import { requireIdentity } from "@/server/auth/identity";
import Link from "next/link";
import { StockAlertDashboard } from "@/components/stock-alerts/stock-alert-dashboard";
import { canUseTransfers } from "@/lib/transfers/access";
import { canViewDashboard } from "@/lib/dashboard/access";
import { DashboardManager } from "@/components/dashboard/dashboard-manager";
import { canViewAnalyses } from "@/lib/analyses/access";

const groups: { id: string; number: string; title: string; description: string; cards: { icon: IconName; title: string; description: string; detail: string; href?: string }[] }[] = [
  { id: "cadastros", number: "01", title: "Tudo começa com organização", description: "Uma base bem cuidada para a sua operação.", cards: [
    { icon: "package", title: "Produtos", description: "Organize os produtos, seus códigos, custos e preços em um só lugar.", detail: "Consultar produtos", href: "/produtos" },
    { icon: "layers", title: "Categorias", description: "Agrupe os produtos para consultar e manter seu catálogo organizado.", detail: "Consultar categorias", href: "/categorias" },
    { icon: "partners", title: "Fornecedores", description: "Mantenha os contatos dos parceiros e o prazo de reposição cadastrado.", detail: "Consultar fornecedores", href: "/fornecedores" },
    { icon: "partners", title: "Clientes", description: "Reúna os dados dos clientes que fazem parte da sua operação.", detail: "Consultar clientes", href: "/clientes" },
  ] },
  { id: "estoque", number: "02", title: "Acompanhe cada movimento", description: "Uma visão compartilhada do que entra, sai e permanece.", cards: [
    { icon: "movement", title: "Movimentações de estoque", description: "Registre entradas, saídas e ajustes e consulte o saldo e os valores de cada operação.", detail: "Consultar o estoque", href: "/estoque" },
    { icon: "inventory", title: "Inventário e conferência", description: "Conte o estoque físico, confira divergências e confirme ajustes com histórico.", detail: "Consultar inventários", href: "/inventarios" },
  ] },
  { id: "analises", number: "03", title: "Transforme informação em direção", description: "Entenda o presente para planejar os próximos passos.", cards: [
    { icon: "chart", title: "Importação e relatórios", description: "Confira produtos antes de importar e gere relatórios filtrados em Excel ou PDF.", detail: "Abrir importação e exportação", href: "/transferencias" },
    { icon: "forecast", title: "Curva ABC e reposição", description: "Classifique o consumo pelos custos históricos e consulte estimativas explicáveis de reposição.", detail: "Consultar análises", href: "/analises" },
  ] },
  { id: "acesso", number: "04", title: "Um ambiente que acompanha sua equipe", description: "Acesso individual e preferências para o dia a dia.", cards: [
    { icon: "shield", title: "Usuários e permissões", description: "Organize o acesso de administradores, gerentes e operadores às áreas do sistema.", detail: "Cada pessoa, com seu espaço" },
    { icon: "shield", title: "Auditoria de atividades", description: "Consulte responsáveis, alterações e operações registradas no histórico do sistema.", detail: "Consultar auditoria", href: "/auditoria" },
    { icon: "layers", title: "Central de notificações", description: "Acompanhe avisos, inventários e mudanças importantes, com histórico e leitura individual.", detail: "Consultar notificações", href: "/notificacoes" },
    { icon: "settings", title: "Aparência e preferências", description: "Escolha entre o tema claro, escuro ou a aparência do seu dispositivo.", detail: "Ajustar preferências", href: "/configuracoes" },
  ] },
];

export default async function HomePage() {
  const identity = await requireIdentity();
  return (
    <WorkspaceShell identity={identity}>
      <section id="visao-geral" className="welcome-section" aria-labelledby="welcome-title">
        <div className="page-intro"><div><p className="eyebrow">VISÃO GERAL DO ESTOQUE</p><h1 id="welcome-title">Seu estoque, em perspectiva<span>.</span></h1><p>Acompanhe o saldo atual e consulte os movimentos do período.</p></div><a href="#modulos" className="button-secondary">Explorar módulos<Icon name="arrow-right" /></a></div>
        {canViewDashboard(identity.permissions) ? <DashboardManager ownerId={identity.id} /> : <section className="management-panel denied-panel"><h2>Os indicadores exigem permissão de consulta</h2><p>Para abrir o painel, sua conta precisa de acesso ao estoque e aos relatórios. Os demais módulos autorizados continuam disponíveis abaixo.</p></section>}
      </section>

      {identity.permissions.includes("stock.read") && <StockAlertDashboard canConfigure={identity.permissions.includes("catalog.read") && identity.permissions.includes("catalog.write")} />}

      <section className="workspace-message" aria-label="Disponibilidade do ambiente"><span className="message-icon"><Icon name="layers" /></span><div><strong>Catálogo e estoque, conectados</strong><p>Organize seus cadastros e acompanhe entradas, saídas e saldos em um só lugar.</p></div><span className="preparation-badge"><span />Em evolução</span></section>

      <div id="modulos" className="modules-area"><div className="section-intro"><div><p className="eyebrow">PENSADO PARA A SUA ROTINA</p><h2>Um lugar para cada parte da gestão<span>.</span></h2></div><p>Da organização dos produtos<br />ao planejamento do estoque.</p></div>
        {groups.map((group) => <section id={group.id} className="module-group" key={group.id} aria-labelledby={`${group.id}-title`}>
          <div className="group-heading"><span className="group-number">{group.number}</span><div><h3 id={`${group.id}-title`}>{group.title}</h3><p>{group.description}</p></div></div>
          <div className="module-grid">{group.cards.map((card) => {
            const isAccess = card.title === "Usuários e permissões";
            const permission = card.href === "/auditoria" ? "audit.read" : card.href === "/estoque" || card.href === "/inventarios" ? "stock.read" : "catalog.read";
            const canOpen = isAccess || card.href === "/notificacoes" || card.href === "/configuracoes" || (card.href === "/analises" ? canViewAnalyses(identity.permissions) : card.href === "/transferencias" ? canUseTransfers(identity.permissions) : Boolean(card.href && identity.permissions.includes(permission)));
            const href = isAccess ? (identity.permissions.includes("users.manage") ? "/usuarios" : "/perfil") : card.href;
            const label = isAccess ? (identity.permissions.includes("users.manage") ? "Gerenciar usuários" : "Consultar meu perfil") : card.detail;
            return <article className="module-card" key={card.title}>
              <div className="module-card-top"><span className="module-icon"><Icon name={card.icon} /></span><span className={`card-status${canOpen ? " card-status-ready" : ""}`}>{canOpen ? "Disponível" : card.href ? "Acesso restrito" : "Em preparação"}</span></div>
              <h4>{card.title}</h4><p>{card.description}</p>
              <div className="module-card-detail">{canOpen && href ? <Link className="module-open-link" href={href}>{label}<Icon name="arrow-right" /></Link> : <><span className="detail-dot" />{card.href ? "Consulte suas permissões com o administrador" : card.detail}</>}</div>
            </article>;
          })}</div>
        </section>)}
      </div>

      <section className="closing-note"><span className="closing-symbol"><Icon name="package" /></span><div><p>Menos incerteza. Mais visão.</p><span>O próximo passo da sua gestão começa com uma base organizada.</span></div><a href="#visao-geral" aria-label="Voltar ao início da página"><Icon name="arrow-up-right" /></a></section>
    </WorkspaceShell>
  );
}
