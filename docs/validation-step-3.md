# Etapa 3 — cadastros

Registro de 31/10/2026. Produtos, categorias, fornecedores e clientes estão implementados e passaram nas verificações automáticas abaixo. A inspeção visual e a conferência local pelo responsável continuam pendentes. A etapa 4 não foi iniciada.

## Implementado

- Páginas protegidas `/produtos`, `/categorias`, `/fornecedores` e `/clientes`, com navegação consistente e permissões de consulta/escrita.
- Listas com pesquisa, paginação, situação ativa/inativa/todas e estados de carregamento, erro e resultado vazio.
- Formulários de criação e edição, confirmação de inativação/reativação, mensagens de resultado e tratamento de edição concorrente.
- Produtos com nome, descrição, SKU, código de barras, categoria, fornecedor padrão, unidade, mínimo, segurança, custo, preço e prazo de reposição.
- Consulta por nome, SKU ou código de barras, com filtros de categoria, fornecedor e situação do estoque.
- Categorias com nome e descrição; fornecedores e clientes com documento, e-mail, telefone e endereço opcionais. Fornecedores possuem prazo de reposição opcional.
- Validação estrita no servidor, normalização e erros de duplicidade. SKU em maiúsculas, código de barras com zeros à esquerda preservados e categoria única sem distinção de maiúsculas.
- Valores e quantidades em `Decimal(18,4)`, transportados por strings. A interface aceita vírgula ou ponto, sem separador de milhar; a API recebe ponto e rejeita valores negativos, não finitos, precisão excessiva e estouro.
- Produto novo com saldo zero e histórico inicial de custo e venda, na mesma transação do cadastro e da auditoria.
- Histórico paginado de custo/preço com responsável, data, valores anterior/novo e identificação da operação; mudanças acrescentam registros e preservam o histórico anterior.
- Inativação em vez de exclusão, sem liberar SKU, código de barras ou nome de categoria para duplicação.
- Referências ativas para novos produtos, troca de categoria/fornecedor e reativação. Associações inativas já existentes podem permanecer em outras edições; filtros incluem essas referências.
- Campo `version` nos quatro cadastros e `expectedVersion` obrigatório nas alterações; edição desatualizada recebe HTTP 409.
- Revalidação do ator dentro da transação após aguardar os locks de autorização e catálogo, com `ReadCommitted` e auditoria atômica.
- API com identidade, permissão, origem, CSRF e limite de requisições, sem endpoint de exclusão.
- Migration `202610300004_catalog_management` com versões não negativas e índice de nome de categoria sem distinção de maiúsculas.

## Verificações

| Verificação | Estado nesta revisão |
| --- | --- |
| Schema Prisma, geração do cliente e migration 004 | Aplicados ao banco Docker local; quatro migrations no ambiente de desenvolvimento. |
| `npm.cmd run db:check` e schema do banco | Conexão e identidade conferidas, com a migration 004 aplicada. |
| Testes unitários | 146 testes aprovados em 12 arquivos. |
| `npm.cmd run typecheck` | Aprovado. |
| `npm.cmd run build` | Aprovado, sem avisos. |
| `npm.cmd run check:catalog` | 41 cenários HTTP e PostgreSQL aprovados; limpeza concluída, sem bancos descartáveis remanescentes. |
| Regressão de autenticação (`check:auth`) | 45 cenários aprovados. |
| Integridade e privilégios do banco (`check:integration`) | 28 verificações aprovadas. |
| Inspeção visual e interação desktop/mobile | Pendente: a ferramenta informou que o acesso ao navegador está indisponível nesta sessão. Não inferida dos testes HTTP. |

A integração aprovou criação e edição dos quatro cadastros, detalhes, pesquisa e filtros, paginação, normalização, duplicidades, referências inativas, precisão decimal, histórico e auditoria, rejeição de alteração direta de saldo, CSRF, permissões de leitura/escrita, versão desatualizada e duas edições concorrentes. A regressão de revogação durante a espera pelo lock de autorização confirmou a rejeição da requisição e a ausência de cadastro persistido. As fixtures permaneceram isoladas do banco principal.

O script usa um banco descartável `prevision_catalog_test_<sufixo aleatório>`, com marcador e identidade próprios, credenciais aleatórias e servidor separado na porta `3011`. A limpeza confere o marcador antes de remover o banco criado pela execução. Os testes não devem criar usuários ou cadastros fictícios no banco principal.

## Repetir as verificações

Com o Docker e o banco local preparados:

```powershell
npm.cmd run db:check
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run check:catalog
```

Mantenha a porta `3011` livre e não gere outra compilação durante `check:catalog`. Para conferir a integração com as etapas anteriores, execute também `npm.cmd run check:auth` e `npm.cmd run check:integration`, cada um conforme seus pré-requisitos.

## Conferência local pelo responsável

1. Entre em `http://127.0.0.1:3000` e abra **Categorias**. Cadastre uma categoria e confira pesquisa e edição.
2. Abra **Fornecedores**, cadastre um parceiro e informe um documento opcional, contato e prazo de reposição. Confira a mesma operação em **Clientes**.
3. Em **Produtos**, crie um produto com a categoria, SKU e código de barras. Use um código começando por zero para conferir sua preservação.
4. Confira saldo zero, detalhes e o histórico inicial de custo e venda. Altere um valor e confirme que o histórico anterior continua disponível.
5. Teste os filtros de situação, categoria e fornecedor. Os produtos novos aparecem como sem estoque; esta etapa não cria quantidades positivas.
6. Inative e reative um cadastro. Confira que ele continua consultável e que seus códigos não podem ser reutilizados em outro registro.
7. Abra a edição do mesmo cadastro em duas abas, salve em uma e tente salvar a outra. O segundo formulário deve informar o conflito e oferecer a versão atual.
8. Confira navegação, diálogos, pesquisa, tabelas e mensagens em desktop e largura móvel.

## Limites da entrega

O documento opcional é normalizado e tem formato limitado, mas sua autenticidade e dígitos de CPF/CNPJ não são verificados. A consulta de situação do estoque não gera alertas. O cadastro não altera quantidades e não implementa entradas, saídas ou ajustes; esses fluxos pertencem à etapa 4. Importação, exportação, inventário e análises continuam para etapas posteriores.

O login Google já foi validado na etapa 2. SMTP externo e inspeção visual completa permanecem pendentes conforme os respectivos registros. O trabalho desta etapa é local; não houve publicação nem preparo do ambiente de demonstração. Consulte [arquitetura](architecture.md) e [ambientes](environments.md) para os contratos e procedimentos.
