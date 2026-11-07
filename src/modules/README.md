# Organização dos módulos

Os módulos de negócio serão introduzidos incrementalmente. Nesta fundação, o schema define suas primeiras entidades; não há rotas de cadastro ou de movimentação habilitadas.

Cada módulo seguirá esta organização conforme a necessidade, sem criar arquivos vazios:

```text
modules/<modulo>/
  domain/       regras puras e tipos do domínio
  schemas/      contratos Zod de entrada e saída
  server/       serviços/casos de uso e repositórios Prisma
  components/   interface específica do módulo
```

Serviços verificam autorização e coordenam transações. Repositórios executam consultas e recebem a transação do serviço. Endpoints não acessam Prisma diretamente. Arquivos de servidor usam o marcador `server-only`; a UI recebe somente dados autorizados, serializados para apresentação.

As fronteiras são produtos, categorias, fornecedores, clientes, estoque, inventários, usuários, auditoria, notificações, importações, relatórios, análises e configurações. Regras compartilhadas do estoque ficam no serviço de estoque, inclusive quando chamadas por inventário ou importação.
