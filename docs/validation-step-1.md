# Etapa 1 — fundação e arquitetura

Validação realizada em 30/10/2026. Esta entrega prepara a base; ainda não disponibiliza login, cadastros ou movimentações aos usuários.

## Entregue

- Next.js 16, React 19, TypeScript estrito e Tailwind CSS 4, com versões fixadas e lockfile.
- Página inicial responsiva em português, com identidade PREVISION, navegação por âncoras e menu móvel.
- Fronteiras entre interface, módulos, configuração do servidor e persistência.
- Prisma 7 com geração ESM e imports compatíveis com os scripts TypeScript nativos do Node.js 24.
- Schema inicial de identidade/acesso, catálogo, estoque, valores históricos e auditoria.
- Duas migrations: tabelas/relacionamentos e restrições locais/imutabilidade/permissões.
- PostgreSQL local, credenciais distintas de administração/runtime e identificação persistida do banco.
- Configuração Docker e alternativa PostgreSQL portátil para Windows x64.
- Geração do `.env` com senhas aleatórias, sem sobrescrever configuração existente nem expor valores.
- Comandos de migrations protegidos contra destinos fora do desenvolvimento local esperado.
- Endpoint `/api/health` com liveness sem dados internos.
- Documentação de arquitetura, ambientes e inicialização.

## Verificações executadas

| Verificação | Resultado |
| --- | --- |
| Schema Prisma e geração do client | Aprovados. |
| `npm test` | 17 testes aprovados em 3 arquivos. |
| `npm run typecheck` | Aprovado. |
| `npm run build` | Compilação de produção aprovada. |
| `npm run db:deploy` | Duas migrations aplicadas. |
| `npm run db:identify` | Identidade local registrada. |
| `npm run db:check` | Conectividade, sentinela e leitura do PrismaAdapter aprovadas. |
| `npm run check:integration` | 28 verificações de integração aprovadas, com rollback das fixtures. |
| `npm run db:status` | Schema atualizado, sem migrations pendentes. |
| HTTP `/` e `/api/health` | Respostas 200; proteção contra incorporação em iframe conferida. |
| `npm audit --omit=dev` | Nenhuma vulnerabilidade conhecida reportada para dependências de produção nessa consulta. |
| Exclusão de arquivos privados do versionamento | `.env`, `.cache`, `node_modules` e client gerado ignorados pelo Git. |

Os testes de banco cobrem precisão decimal, unicidade de SKU/código de barras/chave de operação, rejeição de saldo negativo e NaN, coerência local de movimentações, preservação dos históricos, referências e privilégios limitados do runtime. A reconciliação transacional entre saldo e movimentações e os testes de concorrência dos serviços pertencem à etapa 4.

O smoke test Auth.js valida o contrato de configuração JWT e uma leitura pelo PrismaAdapter. Não realiza login Google ou convencional e não equivale a validar o futuro fluxo de vinculação e autorização prévia. Auth.js 5 permanece beta, conforme a decisão registrada no planejamento.

## Limitações observadas

O Docker Desktop desta sessão não iniciou de forma estável: registrou acesso negado ao salvar arquivos na própria pasta de configuração `.docker`. A validação de banco foi concluída com PostgreSQL 17.11 portátil, dentro do cache do projeto, sem alterar permissões do Windows. A inicialização pelo Docker permanece sem validação de execução neste computador.

A infraestrutura de navegador automatizado estava indisponível. Houve verificação HTTP, compilação e revisão do código da interface; a inspeção visual e a interação do menu em navegadores desktop/mobile precisam ser conferidas durante a validação da etapa.

## Conferência pelo responsável

Na configuração atual, inicie o banco com `npm run db:local:up` e a interface com `npm run dev`. Abra `http://127.0.0.1:3000`, confira o conteúdo, os atalhos da navegação e o menu em largura móvel. Os módulos aparecem como “Em preparação”, sem indicadores fictícios apresentados como dados reais.

A etapa 2, de autenticação e segurança, aguarda a validação desta entrega. Nenhum serviço externo foi publicado e nenhuma credencial Google foi criada.
