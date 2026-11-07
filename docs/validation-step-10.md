# Etapa 10 — Curva ABC e previsão de reposição

A página **Análises** (`/analises`) reúne a classificação financeira dos produtos e estimativas de reposição. Os cálculos pertencem ao servidor; o navegador apresenta os valores, os critérios, o gráfico e as tabelas. A consulta não altera saldos ou parâmetros, não cria pedidos de compra e não envia mensagens.

Esta etapa utiliza os dados e dependências existentes. **Não acrescenta migration**: o schema continua com onze migrations. A etapa 11, de preparação do ambiente de demonstração e validação, ainda não foi executada.

## Período, filtros e conjunto analisado

As datas são dias civis em **America/Sao_Paulo**, incluindo o início e o fim selecionados. O padrão são os últimos 90 dias, incluindo hoje; o limite é de 366 dias, sem datas futuras. As duas datas devem ser informadas juntas. A pesquisa considera nome, SKU e código de barras; a situação permite ativos, inativos ou ambos.

Os critérios padrão são A = 80%, B = 95% e horizonte de reposição = 30 dias. Os limites aceitam duas casas decimais e devem respeitar `0 < A < B < 100%`; o horizonte aceita de 1 a 365 dias. São critérios da consulta e não configurações globais. Filtros desconhecidos, repetidos ou inválidos são recusados.

A classificação considera **todo o conjunto filtrado, até 1.000 produtos**. Ao encontrar mais produtos, o servidor pede para refinar a consulta: não classifica uma amostra nem apenas a página visível. A paginação da tela é uma forma de apresentação dos resultados completos. O gráfico mostra até os vinte maiores consumos financeiros, mantendo o denominador do conjunto completo para a participação acumulada.

## Critérios da Curva ABC

| Informação | Critério |
| --- | --- |
| Saídas e custo bruto | Quantidades e custos históricos das movimentações originais de saída pela data da operação, dentro do período. |
| Compensações | Desconta somente compensações de saídas, pela data da própria compensação, inclusive quando o lançamento original está fora do período. |
| Consumo líquido | Saídas menos suas compensações. Entradas e ajustes não são considerados consumo. |
| Líquido negativo | Quantidades ou custos negativos são limitados a zero para a análise e a linha recebe uma observação. |
| Ordenação | Consumo financeiro decrescente, com desempate por nome e identificador. |
| Participação | Consumo financeiro líquido do produto dividido pelo consumo financeiro líquido total do conjunto filtrado. |
| Classe | Usa o percentual acumulado antes do grupo de mesmo valor. O grupo que cruza um limite permanece na faixa em que começou; empates recebem a mesma classe. |
| Sem consumo financeiro | Valor líquido zero permanece sem classe, em vez de receber automaticamente a classe C. |

As faixas A/B/C são aproximadas em participação, pois produtos e grupos empatados não são divididos. Um produto dominante pode permanecer em A mesmo ultrapassando 80%, e alguma classe pode ficar vazia. A classificação utiliza os valores exatos; percentuais arredondados da tela não determinam a classe.

Se a unidade do produto foi alterada desde o início do período, inclusive depois do fim selecionado, a quantidade líquida não é apresentada como comparável à unidade atual. O custo histórico continua disponível para a classificação financeira, com aviso sobre a alteração.

## Critérios da previsão de reposição

A previsão aplica o consumo histórico ao **saldo e aos parâmetros atuais**. O período observado começa no início selecionado ou na data de cadastro do produto, o que ocorrer depois, e termina na data final escolhida. Dias sem consumo também entram no divisor da média.

Uma estimativa exige ao menos **30 dias observados**, consumo líquido total positivo e **dois dias distintos com saída líquida positiva**. As compensações reduzem o consumo do dia em que ocorreram. Não é suficiente cadastrar hoje um produto e lançar operações antigas para demonstrar 30 dias de observação.

| Informação | Fórmula ou critério |
| --- | --- |
| Média diária | Saídas líquidas observadas ÷ dias observados. |
| Cobertura | Saldo atual ÷ média diária. |
| Prazo de entrega | Prazo do produto; se ausente, prazo do fornecedor padrão. Zero é válido e tem prioridade sobre o fornecedor. |
| Ponto de reposição | Maior entre o mínimo e `segurança + média diária × prazo`. |
| Estoque-alvo | Maior entre o mínimo e `segurança + média diária × (prazo + horizonte)`. |
| Quantidade sugerida | Maior entre zero e `estoque-alvo − saldo atual`. |
| Data de esgotamento | Dia atual da consulta em São Paulo + cobertura em dias inteiros, arredondada para baixo. |
| Data de iniciar reposição | Dia atual + a parte inteira não negativa de `(saldo − ponto de reposição exato) ÷ média diária`. |
| Atenção à reposição | A data de iniciar reposição corresponde ao dia atual. |
| Falta para o mínimo | Maior entre zero e `mínimo − saldo atual`, independentemente de haver previsão. |

Produtos inativos ou com unidade alterada não recebem estimativa de compra. Histórico insuficiente e consumo líquido zero têm motivos próprios. Sem prazo cadastrado, a média, a cobertura e o esgotamento ainda podem ser apresentados quando houver base; ponto de reposição, sugestão e data de iniciar reposição ficam ausentes. O prazo de fornecedor inativo é identificado e deve ser confirmado antes da compra.

Campos sem base ficam ausentes e são acompanhados do motivo; não são convertidos em previsões iguais a zero. Datas além de **3.650 dias** não são exibidas, mas a cobertura numérica permanece disponível. A estimativa não garante vendas futuras, não considera pedidos em trânsito e não cria pedidos automaticamente.

## Precisão e consistência

Os cálculos usam inteiros escalados e razões exatas no servidor, sem converter os valores de negócio para ponto flutuante. Quantidades usam quatro casas, valores financeiros usam centavos e a média diária é apresentada com oito casas. Percentuais e média diária são arredondados para exibição pelo critério de metade para cima. A cobertura é truncada em duas casas.

Ponto de reposição e quantidade sugerida são arredondados para cima em quatro casas. A recomendação e as datas utilizam a razão exata de consumo, antes de arredondar o ponto exibido. Somente as proporções dos desenhos são aproximadas no navegador. Valores e rótulos preservam strings decimais, inclusive acima da precisão inteira de um `Number`.

Uma consulta PostgreSQL parametrizada reúne produtos, movimentos, saldos e parâmetros no mesmo snapshot. O saldo atual deve corresponder à soma do histórico imutável; inconsistências impedem apresentar a análise e exigem conferência do histórico.

## Acesso e atualização

A página, a API `GET /api/analyses` e as exportações exigem **`reports.read` e `stock.read`**. O servidor revalida a sessão e as permissões atuais depois de adquirir os locks compartilhados de autorização e catálogo, sempre nessa ordem. A API valida a origem, limita solicitações e devolve `Cache-Control: no-store`, inclusive nos erros.

A tela identifica o horário e o período da consulta, oferece atualização e cancela requisições antigas ao trocar conta ou filtros. Alterações de estoque e catálogo e o retorno à janela podem solicitar nova consulta. Erros de acesso removem os dados da análise. Os valores consultados não são armazenados em cache compartilhado.

## Exportações de análises e indicadores

Curva ABC, reposição e indicadores reutilizam a prévia privada de relatórios. A partir de Análises, o botão de exportar usa os critérios da consulta concluída e realiza **uma nova consulta**, informando que alterações recentes podem aparecer na prévia. Confira os resultados antes de baixar.

Excel e PDF usam os mesmos dados congelados na prévia, com responsável, período, critérios, horário e avisos. A prévia pertence ao usuário que a gerou, dura 30 minutos e tem limites de 1.000 linhas e 8 MiB. As permissões são conferidas novamente no download. Textos e números decimais são preservados como conteúdo textual no Excel.

Os relatórios `abc` e `replenishment` apresentam os resultados das análises; `indicators`, disponível em **Importar e exportar**, reutiliza os cálculos do dashboard. Ele mantém indicadores atuais separados das movimentações do período, quantidades por unidade e referências dos agrupamentos temporais. Não recalcula os resultados com outra regra.

## Repetir a validação

Com o banco local disponível, use:

```powershell
npm.cmd run db:check
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run check:analyses
npm.cmd run check:transfers-export
```

A integração de análises utiliza banco `prevision_analyses_test_<sufixo aleatório>` e servidor descartável na porta `3020`, com sentinela de teste, credenciais efêmeras e limpeza limitada aos recursos próprios. A integração de exportação utiliza a porta `3017`. Execute-as com build atualizado e portas livres; não gere outro build durante a execução. **Nenhum dado de teste deve ser inserido no banco principal.**

Os cenários de análise verificam classificação e empates, compensações pela própria data, limites personalizados, precisão decimal, janelas observadas, dias positivos, prazo zero e fallback, ausência de prazo, inativos, troca de unidade, datas de São Paulo, limite de produtos, permissões e prévias privadas de Excel/PDF. Os resultados executados devem ser registrados abaixo; a lista de cenários não substitui a execução.

## Resultados registrados

Validação executada em **06/11/2026**:

- TypeScript e build de produção aprovados; **810 testes unitários em 47 arquivos aprovados**.
- **25 verificações de análises avançadas aprovadas** em banco e servidor descartáveis. Incluem ABC e empates, compensações, critérios, previsão com razões exatas, ausência de base, prazo zero, unidades alteradas, datas e precisão extrema, permissões revogadas, privacidade e arquivos Excel/PDF reais das análises e dos indicadores.
- Regressões de exportação (**23 verificações**) e dashboard (**21 verificações**) aprovadas em seus bancos descartáveis.
- Docker iniciado e PostgreSQL saudável; conexão e identidade local confirmadas. A consulta da nova análise também passou sobre os dados atuais, somente em leitura.
- As contagens do desenvolvimento permaneceram iguais antes e depois: um produto, nenhuma movimentação, um inventário, uma notificação, uma preferência e onze migrations aplicadas. Não restaram bancos de teste. Nenhum dado fictício foi inserido no banco principal.
- Servidor reiniciado em `http://127.0.0.1:3000`: saúde e login retornaram 200; sem sessão, `/analises` redirecionou ao login (307) e `/api/analyses` recusou acesso (401). Todas as respostas usaram `Cache-Control: no-store`; o log de erros permaneceu vazio após essas consultas.

A inspeção visual automática não pôde ser realizada porque o serviço de acesso ao navegador informou estar indisponível. A conferência de layout, foco e largura móvel permanece no roteiro abaixo, separada das verificações de API, cálculo e arquivos.

## Conferência no navegador

1. Entre com uma conta autorizada e abra **Análises**. Confira o padrão de 90 dias, o horário de São Paulo e os limites A/B.
2. Consulte um período com saídas e suas compensações. Compare os custos históricos e confira a participação e o acumulado com o relatório de movimentos. Use dados fictícios somente no ambiente de testes ou demonstração.
3. Teste limites diferentes, produtos empatados, um produto dominante e produtos sem consumo financeiro. Confira que a classe considera o conjunto completo e não muda ao trocar a página.
4. Confira produtos ativos e inativos, pesquisa por SKU/código e conjunto vazio. Um conjunto acima de 1.000 produtos deve pedir refinamento.
5. Abra **Previsão de reposição** e compare saldo, mínimo, segurança, prazo, consumo observado, média e cobertura. Verifique os motivos de ausência de estimativa e o prazo zero, quando aplicáveis aos dados do ambiente.
6. Confira as fórmulas exibidas, a diferença entre período histórico e posição atual, os avisos de unidade alterada e fornecedor inativo e os campos sem estimativa. Ausência de base não deve parecer recomendação de zero.
7. Exporte ABC e reposição: confira a nova prévia, baixe Excel/PDF e compare critérios, precisão, avisos e valores. Em **Importar e exportar**, repita para indicadores.
8. Com outra conta, confirme que a prévia privada não fica acessível. Uma conta sem qualquer uma das duas permissões não deve consultar análises ou gerar esses relatórios.
9. Confira teclado, foco, abas, tabelas e gráfico nos temas claro/escuro e em largura móvel. A inspeção visual deve ser registrada separadamente dos testes de API e cálculo.

Build e integrações desta etapa foram concluídos. Antes de avançar à etapa 11, confira a apresentação no navegador conforme o roteiro acima. A demonstração e a publicação não fazem parte desta execução.
