# Etapa 7 — Importação e exportação

Esta etapa acrescenta **Importar e exportar** ao menu. A importação cria cadastros de produtos após conferência. A exportação gera Excel e PDF dos módulos já disponíveis. Indicadores avançados e Curva ABC continuam nas etapas 9 e 10.

## Preparar a planilha

Baixe o modelo CSV ou Excel na aba **Importar produtos**. Use CSV em UTF-8 ou Excel `.xlsx`, com até **2 MiB e 200 produtos**. O CSV aceita vírgula ou ponto e vírgula como delimitador, inclusive campos entre aspas. Arquivos `.xls`, `.xlsm`, fórmulas e estruturas não reconhecidas são recusados.

| Campo do modelo | Regra |
| --- | --- |
| Nome | Obrigatório. |
| SKU | Obrigatório, normalizado em maiúsculas e único, inclusive em produtos inativos. |
| Código de barras | Opcional, único e tratado como texto, preservando zeros. No Excel, use célula de texto. |
| Categoria | Nome de categoria ativa já cadastrada. |
| Fornecedor | Opcional; nome de fornecedor ativo. Se houver nomes repetidos, informe seu documento. |
| Documento do fornecedor | Opcional; identifica o fornecedor existente. Se o nome também for informado, ambos precisam corresponder. |
| Unidade | Opcional; padrão `UN`. |
| Estoque mínimo, custo de aquisição, preço de venda e estoque de segurança | Opcionais; padrão zero, sem separador de milhar e com até quatro casas decimais. |
| Prazo de reposição (dias) | Opcional, inteiro não negativo conforme os limites do cadastro. |
| Descrição | Opcional. |
| Ativo | Opcional; padrão Sim. Aceita Sim/Não, true/false ou 1/0. |

Categorias e fornecedores não são criados automaticamente. A importação não edita produtos existentes nem aceita uma coluna para definir saldo. Cada produto novo recebe saldo zero e seu histórico inicial de valores, usando as mesmas regras do cadastro manual.

## Conferir e confirmar

Selecione o arquivo e gere a prévia. A tela mostra os valores reconhecidos, o número da linha e os erros encontrados, incluindo campos obrigatórios, referências, formato, SKU e código de barras duplicados no arquivo ou no banco.

Se houver qualquer linha inválida, corrija o arquivo e envie novamente. A confirmação é do lote inteiro: não há importação parcial de linhas válidas. A prévia expira em **30 minutos**. Mudanças em categorias, fornecedores ou códigos depois da prévia são revalidadas; um conflito exige uma nova conferência.

A gravação exige `catalog.read` e `catalog.write`, sessão atual e o mesmo usuário que criou a prévia. Produtos, saldos zero, históricos e auditoria são gravados na mesma transação. Repetir a confirmação não duplica os produtos. Reenviar conteúdo já aplicado pelo mesmo usuário retorna o registro concluído; a unicidade dos códigos também protege contra duplicação entre usuários.

Pedidos de confirmação com resposta incerta mantêm a mesma chave e o ID da prévia por usuário e aba. O arquivo não é guardado no armazenamento do navegador. Consultar uma prévia expirada não cancela um pedido em andamento; a repetição da confirmação verifica o estado sob os locks antes de devolver uma expiração definitiva.

## Exportar relatórios

A aba **Exportar relatórios** oferece produtos, estoque atual, estoque baixo, produtos sem estoque, entradas, saídas, ajustes, movimentações, inventários e auditoria. Os filtros variam conforme o relatório. O acesso exige `reports.read` e também a permissão de consulta da fonte: catálogo, estoque ou auditoria.

Gere a prévia antes de baixar. Ela congela até **1.000 registros**, com identificação do Prevision, responsável, data e filtros, por **30 minutos**. Se houver mais registros, refine os filtros; o resultado não é truncado silenciosamente. Uma movimentação posterior não altera os dados da prévia já criada. Para obter dados atuais, gere outra prévia.

Excel e PDF utilizam esse mesmo conjunto de dados. Quantidades, códigos e valores no Excel são células de texto, preservando zeros e a precisão decimal. Conteúdos iniciados por caracteres de fórmula permanecem texto. O PDF possui identificação, paginação e formatação para leitura; quando uma célula longa for limitada na apresentação, haverá indicação, e o Excel preservará o conteúdo integral da prévia.

Cada download verifica novamente usuário, propriedade da prévia, validade e permissões. Auditoria exportada utiliza os mesmos campos permitidos da consulta, com indicação de omissão ou truncamento. Arquivos e imagens não são enviados a serviços externos para processamento.

Na auditoria, **Valores anteriores** e **Valores registrados** mostram o estado dos dados antes e depois da atividade. Essas seções fazem parte do histórico. Os campos são apresentados com nomes em português, sem o envelope JSON interno. No PDF, cada seção ocupa a largura do registro e preserva os campos da prévia, até o limite informado de 4.000 caracteres por seção. Quando a atividade não registra um dos estados, o PDF explica essa ausência.

## Estrutura e limites

A migration `202611010009_data_transfers` acrescenta `ProductImport`, `ReportExport` e os eventos de auditoria de transferências. Prévia e histórico são privados por usuário. O arquivo bruto de importação não é persistido; o banco guarda os dados reconhecidos e o resultado. Snapshots de exportação são imutáveis.

Uploads são lidos com limite antes da interpretação. XLSX passa por validação ZIP, limites de expansão e de estrutura e reconstrução a partir de entradas validadas; macros, referências externas e entidades XML não são aceitas. Fórmulas não são executadas. Consulte também [a revisão de dependências](dependency-review-step-7.md).

## Repetir as verificações

```powershell
npm.cmd run db:generate
npm.cmd run db:deploy
npm.cmd run db:check
npm.cmd test
npm.cmd run build
npm.cmd run check:transfers-import
npm.cmd run check:transfers-export
```

Reinicie o servidor de desenvolvimento após atualizar. As integrações usam bancos descartáveis com marcadores e credenciais efêmeras, nas portas `3016` e `3017`, sem inserir produtos ou movimentos no banco principal. Não gere outro build durante os testes.

Verificações executadas em **01/11/2026**, após a correção da apresentação dos valores da auditoria:

- TypeScript e build de produção aprovados; **559 testes unitários em 32 arquivos** aprovados.
- **20 verificações HTTP de importação** e **23 de exportação** aprovadas em bancos descartáveis, incluindo download real de Excel e PDF da auditoria, campos traduzidos e proteção de credenciais.
- Regressões aprovadas: autenticação (61), catálogo (41), estoque (44), códigos e alertas (33), inventários (25), auditoria (21) e integridade/privilégios (28).
- PostgreSQL Docker iniciado e identidade/conexão verificadas. Os testes de transferências utilizaram bancos próprios e foram removidos ao terminar.

Os testes verificam os dados, a estrutura do documento e a geração dos arquivos. A conferência visual e de uso dos arquivos no Excel e em leitor de PDF permanece necessária.

## Conferência pelo responsável

1. Abra **Importar e exportar**, baixe o modelo e preencha um produto sob seu controle com categoria existente e código de barras iniciado por zero.
2. Gere a prévia, confira dados e saldo inicial zero, confirme e consulte o produto e o registro da importação na auditoria.
3. Repita o envio e a confirmação e confira que não surgem produtos duplicados.
4. Envie um arquivo com erro de categoria, valor inválido ou SKU repetido e confira a indicação por linha e o bloqueio da confirmação.
5. Selecione um relatório, aplique filtros e confira a prévia. Baixe Excel e PDF e confira data, responsável, quantidade de registros, acentos, códigos e valores.
6. Altere dados depois de gerar uma prévia e confira que seu arquivo continua representando a conferência anterior. Gere uma nova para obter o estado atual.
7. Como operador, confira que não é possível exportar auditoria. Confira também a restrição de acesso a prévias de outro usuário.
8. Confira abas, tabelas, erros, confirmações e retomada de pedido em desktop e largura móvel.
