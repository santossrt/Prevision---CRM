# Etapa 11 — Testes funcionais, de segurança e recuperação

Este documento preserva a execução de 06/11/2026. Os achados e as quatro falhas esperadas descritos abaixo foram tratados posteriormente, após autorização do responsável; consulte [as correções de 07/11/2026](security-hardening-2026-11-07.md) para os resultados e limites atuais.

O responsável limitou esta etapa aos testes. Preparação de ambiente público, conta da banca, dados de demonstração e publicação não fazem parte desta execução. As fixtures abaixo existem apenas para validação e não são dados de demonstração permanentes.

## Escopo e isolamento

As integrações HTTP iniciam bancos e servidores descartáveis com credenciais efêmeras. A limpeza confere nomes gerados e marcadores antes de remover os próprios recursos. Não há envio de e-mail externo nem uso de credenciais Google nos testes.

As contagens do desenvolvimento permaneceram iguais antes e depois: um produto, nenhuma movimentação, um inventário, uma notificação, uma preferência e onze migrations aplicadas. Não restaram bancos de teste após a recuperação e as integrações.

`check:integration` é a exceção: consulta os privilégios do runtime local e exercita restrições do banco de desenvolvimento com fixtures dentro de uma transação revertida em `finally`. Nenhuma fixture desse comando deve permanecer gravada. As contagens do desenvolvimento são conferidas antes e depois da validação.

## Validação funcional e das proteções

Resultados executados em **06/11/2026**, com o mesmo build atualizado:

| Comando | Verificações aprovadas | Cobertura principal |
| --- | ---: | --- |
| `check:integration` | 28 | Privilégios, precisão, unicidade, restrições e histórico imutável. |
| `check:auth` | 61 | Login, ativação, recuperação, reset administrativo, revogação, concorrência, RBAC e CSRF. |
| `check:catalog` | 41 | Cadastros, filtros, histórico, permissões, concorrência e CSRF. |
| `check:stock` | 44 | Movimentos, decimais, compensações, idempotência, saldo e concorrência. |
| `check:stock-tools` | 33 | Códigos, alertas, sincronização, deduplicação e rollback. |
| `check:inventory` | 25 | Contagem, snapshots, conflitos, rebase, ajustes, auditoria e rollback. |
| `check:audit` | 21 | Leitura restrita, filtros e omissão de campos privados. |
| `check:transfers-import` | 20 | CSV/XLSX, prévia, duplicidades, permissões, expiração e retomada. |
| `check:transfers-export` | 23 | Prévia privada, expiração, revogação, Excel e PDF reais. |
| `check:notifications` | 20 | Histórico, leitura, avisos, preferências, permissões e triggers. |
| `check:dashboard` | 21 | Indicadores, histórico financeiro, datas, precisão e permissões. |
| `check:analyses` | 25 | ABC, previsão, critérios, exportações, precisão e revogação. |
| **Total** | **362** | Grupos de integração; não representa número de requisições ou vulnerabilidades. |

TypeScript e build de produção foram aprovados antes das integrações. A suíte unitária ampliada registra **816 testes aprovados e quatro falhas esperadas**, em 48 arquivos. As quatro falhas estão marcadas explicitamente com `it.fails` para reproduzir a limitação de leitura JSON descrita abaixo; não representam correção ou aprovação desse comportamento.

## Recuperação de dados

O comando `npm.cmd run check:recovery` usa dois bancos efêmeros, `prevision_recovery_test_<sufixo>` e `prevision_restore_test_<sufixo>`, no PostgreSQL 17 do Docker. Verifica a identidade local antes de criá-los e confere os marcadores dos destinos. Não aceita nomes ou URLs de destino por argumentos.

O teste cobre rollback por erro de restrição, desconexão antes do commit, reconexão após commit e proteção contra reenvio. Gera um backup real em formato custom com `pg_dump` e o restaura em outro banco vazio com `pg_restore --single-transaction --exit-on-error`. O dump fica em memória e contém somente as fixtures descartáveis.

A recuperação compara contagens e hashes de todas as tabelas e confere esquema, índices, constraints, triggers, sentinela, hash de senha e permissões. Após restaurar, testa saldo e compensações, imutabilidade, rejeição de estoque negativo e uma nova gravação válida, preservando a origem.

As **15 verificações de recuperação foram aprovadas em 06/11/2026**. O teste também demonstrou uma nova transação válida no banco restaurado, sem modificar sua origem. Os dois bancos descartáveis foram removidos ao final. A comparação do esquema normaliza apenas a representação equivalente de casts de arrays de texto emitida por `pg_dump`; literais, colunas, operadores, funções e demais definições continuam conferidos.

## Achados de segurança

### Leitura de corpos JSON

Em `src/server/security/http.ts`, `readJson` chama `request.text()` antes de conferir o tamanho efetivo em bytes. Um `Content-Length` acima do limite é recusado antes da leitura; quando o cabeçalho está ausente ou informa um tamanho menor, o corpo inteiro é consumido antes da resposta de erro. O conteúdo excessivo é rejeitado, mas pode alocar mais memória do que o limite pretendido.

`tests/unit/http-body-limit.test.ts` reproduz o problema com streams locais de 256 KiB, sem rede, nos limites de 16 e 64 KiB. Seis casos confirmam a rejeição e o bloqueio antecipado quando o cabeçalho declara tamanho excessivo. Quatro falhas esperadas documentam a ausência de cancelamento durante a leitura. A correção recomendada é ler incrementalmente com limite e cancelar ao excedê-lo; o backend não foi alterado, conforme o escopo de somente testes.

### Dependências

O `npm audit` consultado em **06/11/2026** sinalizou **seis pacotes afetados: quatro altos e dois moderados**, sem críticos. São `nodemailer`, `@auth/core`, `@auth/prisma-adapter` e `next-auth` na cadeia de autenticação/e-mail; `uuid` e `exceljs` na cadeia de planilhas. Pacotes afetados não equivalem a seis vulnerabilidades independentes, pois os avisos se propagam entre dependências.

Não houve instalação, alteração de versões ou `npm audit fix` nesta execução. Os números acima são do relatório atual e atualizam o registro histórico de 13 pacotes da etapa 7. Os avisos continuam pendentes de avaliação e correção antes da publicação. O relatório completo está em `.cache/security-audit-step11.json`, ignorado pelo Git; a referência histórica permanece em [dependências da etapa 7](dependency-review-step-7.md).

## Limites da validação

Os testes confirmam os cenários executados; não demonstram ausência geral de vulnerabilidades e não substituem pentest. Google OAuth real, SMTP, HTTPS e infraestrutura pública não foram revalidados nesta etapa. A câmera continua com a ampliação de compatibilidade adiada pelo responsável.

As integrações conferem HTML e HTTP, dados e arquivos; não são testes de interação visual de ponta a ponta. O serviço de acesso ao navegador estava indisponível na etapa anterior. A conferência de layout, teclado e largura móvel permanece separada dos resultados funcionais e de segurança.

## Ajuste de legibilidade após os testes

Atendendo ao pedido adicional do responsável, as fontes do frontend foram aumentadas em geral em 2 px, com piso de 12 px para os textos menores, considerando a preferência padrão de 16 px do navegador. Os tamanhos foram convertidos para `rem`, mantendo a base em `100%` para acompanhar a preferência do usuário. Títulos preservam a hierarquia; campos móveis acompanham o aumento e têm tamanho padrão de 18 px.

O ajuste abrange telas de acesso, navegação, formulários, tabelas, diálogos, notificações, dashboard, análises e leitura de códigos. Também foram ajustados espaços de menus e cabeçalho, contadores e legendas para acomodar os textos maiores. O build de produção foi novamente aprovado após o ajuste, incluindo a checagem de tipos e a compilação dos estilos. Os arquivos PDF e os cálculos de negócio não fazem parte da mudança tipográfica.

Uma nova tentativa de inspeção visual automática retornou `The browser access host is unavailable`. Assim, a conferência visual do frontend permanece pendente: abrir telas de acesso e módulos, verificar abas e diálogos com teclado, temas claro/escuro e larguras móveis, e conferir legendas, contadores e rolagem de tabelas com as fontes maiores.

## Repetir

Com o Docker saudável e as portas 3010 a 3020 livres:

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run check:integration
npm.cmd run check:auth
npm.cmd run check:catalog
npm.cmd run check:stock
npm.cmd run check:stock-tools
npm.cmd run check:inventory
npm.cmd run check:audit
npm.cmd run check:transfers-import
npm.cmd run check:transfers-export
npm.cmd run check:notifications
npm.cmd run check:dashboard
npm.cmd run check:analyses
npm.cmd run check:recovery
npm.cmd audit
```

Não gere outro build enquanto uma integração usa a compilação. `npm audit` pode terminar com código diferente de zero enquanto houver avisos. As falhas esperadas do JSON devem permanecer visíveis no resultado dos testes até que o comportamento seja corrigido.
