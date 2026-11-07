# Etapa 9 — Dashboard e indicadores

A visão geral passa a mostrar os indicadores e gráficos do estoque compartilhado. Os atalhos dos módulos e o painel de alertas continuam disponíveis abaixo. A consulta exige `reports.read` e `stock.read`, verificadas também no servidor e após aguardar os locks de autorização e catálogo.

## Saldo atual e período

Os cartões de **estoque atual** representam o momento da consulta: produtos cadastrados, ativos e inativos, custo estimado, venda potencial e margem estimada. Os valores incluem os saldos de produtos inativos. As contagens de estoque baixo e sem estoque consideram somente produtos ativos.

O **período** limita os indicadores de movimentação, o ranking de produtos movimentados e os gráficos temporais. Ele não transforma os cartões atuais em saldos da data final. As datas e agrupamentos usam **America/Sao_Paulo**, indicada na tela. O padrão são os últimos 30 dias, incluindo hoje; é possível consultar até 366 dias, sem datas futuras. Períodos de até 31 dias são agrupados por dia; os demais, por mês, preservando os limites selecionados e os intervalos sem movimento.

## Critérios de cálculo

| Informação | Critério |
| --- | --- |
| Custo estimado atual | Quantidade atual × custo atual do cadastro, arredondado em centavos por produto e depois somado. |
| Venda potencial | Quantidade atual × preço atual, também arredondado por produto. |
| Margem estimada | Venda potencial menos custo estimado. Pode ser negativa e não representa lucro realizado ou custo médio contábil. |
| Estoque baixo | Produto ativo com saldo positivo menor ou igual ao mínimo. |
| Sem estoque | Produto ativo com saldo zero, independentemente do mínimo. |
| Entradas e saídas do período | Contagens e soma dos totais históricos dos lançamentos originais, pela data da operação. |
| Ajustes e compensações | Apresentados separadamente. Compensar não apaga o original nem reduz retroativamente o indicador bruto de entradas ou saídas. |
| Quantidades | Agrupadas pela unidade atual do cadastro; não há soma única de UN, KG ou outras unidades. Se a unidade mudou, consulte o histórico do produto. |
| Mais movimentados | Até dez produtos ordenados pela contagem de entradas e saídas do período, com desempate estável. Não compara volumes de unidades diferentes. |
| Maior valor em estoque | Até dez produtos com saldo positivo, ordenados pelo custo estimado atual, inclusive inativos identificados na tabela. |
| Categorias | Quantidade de produtos e custo estimado atual por categoria; após as dez primeiras, as demais são reunidas em “Outras categorias”, preservando os totais. |

O gráfico de entradas e saídas compara **custos históricos em reais**. Os valores recebidos do banco e exibidos nos rótulos e tabelas preservam a precisão decimal; apenas as proporções dos desenhos são aproximadas. Os cálculos de negócio são realizados no servidor, sem depender do gráfico.

## Evolução do valor estimado

A série reconstrói o saldo por produto ao fim de cada intervalo a partir das movimentações **registradas** até esse momento. Aplica o custo de aquisição do histórico vigente e já registrado naquele fechamento, arredonda cada produto em centavos e soma os valores. A última posição de hoje considera o momento da consulta. Produtos inativos permanecem no valor, pois o sistema não possui um histórico completo de ativação para reconstruir esse filtro no passado.

Uma operação retroativa aparece no período pela sua data de operação, mas afeta a evolução somente a partir do registro. Por exemplo, uma saída com data de operação em 1º de outubro, registrada no dia 5, entra nos indicadores do dia 1 e na reconstrução dos saldos a partir do dia 5. Alterar hoje o custo do cadastro não substitui o custo dos fechamentos antigos.

Essa reconstrução utiliza os horários armazenados e não substitui um registro contábil ou um snapshot observado na época. O servidor recusa resultados quando encontra saldo incompatível com o histórico, saldo histórico negativo, custo necessário ausente ou ambiguidade de valores no horário de um fechamento. O histórico deve ser conferido antes de apresentar esses números.

A migration `202611060011_dashboard_history` acrescenta índices para as consultas e usa `clock_timestamp()` nos novos registros de custo/preço, após a aquisição dos locks. O padrão antigo registrava o início da transação, que poderia preceder uma alteração enquanto a solicitação aguardava. A correção não reescreve os registros históricos existentes.

## Acesso e atualização

`GET /api/dashboard` valida os filtros, a origem, a sessão e ambas as permissões. Toda a agregação utiliza uma única instrução PostgreSQL em uma transação de leitura com locks compartilhados, evitando misturar fontes de momentos diferentes. A resposta é privada e não é armazenada em cache. A consulta não cria movimentações, altera saldo ou registra uma exportação.

O painel oferece atualização e consulta por período. Requisições antigas são canceladas ao trocar de conta ou filtro. Consultas de outras pessoas podem aparecer após atualizar o painel; o horário da consulta identifica a posição apresentada. A apresentação inclui estados de carregamento, erro, ausência de dados e tabelas para consultar os valores dos gráficos.

## Repetir a validação

```powershell
npm.cmd run db:generate
npm.cmd run db:deploy
npm.cmd run db:check
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run check:dashboard
```

A integração utiliza banco `prevision_dashboard_test_<sufixo aleatório>` e servidor descartável na porta `3019`, com identidade de teste, credenciais efêmeras e limpeza restrita aos recursos criados. Seus produtos e movimentos de conferência não são gravados no ambiente principal. Não execute outro build enquanto a integração utiliza a compilação.

Validação executada em **06/11/2026**:

- TypeScript e build de produção aprovados; **725 testes unitários em 41 arquivos** aprovados.
- **21 verificações de dashboard** aprovadas em banco e servidor descartáveis. Os casos incluem valores históricos diferentes dos atuais, registro retroativo, compensações dentro e fora do período, unidades diferentes, produtos inativos, dias sem movimento, arredondamento por produto, valores acima da precisão binária, datas de São Paulo, permissões revogadas e histórico inconsistente.
- Regressões de catálogo (**41 verificações**) e importação (**20 verificações**) aprovadas com os novos defaults do histórico.
- As onze migrations estão aplicadas ao desenvolvimento. A consulta dos indicadores também passou sobre os dados atuais, sem gravar registros. As contagens de produtos, movimentos, inventários, notificações e preferências permaneceram iguais antes e depois. Não restaram bancos descartáveis.
- O servidor foi reiniciado em `http://127.0.0.1:3000`; saúde e login retornaram 200, a página inicial sem sessão redirecionou ao login e `/api/dashboard` sem sessão retornou 401 com `Cache-Control: no-store`.

A inspeção visual automática não pôde ser realizada porque o serviço de acesso ao navegador estava indisponível. A revisão de layout, foco do teclado e largura móvel continua no roteiro abaixo. A paleta dos gráficos foi conferida por cálculo de contraste nos dois temas, com razão mínima de 6,29:1 contra a superfície.

## Conferência no navegador

1. Entre na visão geral e confira os cartões com o estoque e os relatórios correspondentes.
2. Consulte períodos com e sem movimentos. Confira o horário de São Paulo e a troca de agrupamento diário para mensal.
3. Compare entradas e saídas com seus totais históricos. Confira que uma compensação permanece separada do lançamento original.
4. Confira as tabelas de quantidades por unidade e os rankings, inclusive produtos inativos com saldo.
5. Abra os dados dos gráficos e use os links para consultar o produto e seu histórico.
6. Confira foco do teclado, tabelas, filtros e gráficos nos temas claro e escuro e em largura móvel.
