# Etapa 4 — Controle de estoque

Implementada e verificada automaticamente em **31/10/2026**. Esta etapa acrescenta **Controle de estoque** ao menu, com saldos, entradas, saídas, ajustes e histórico de movimentações do estoque compartilhado. Inventário físico, leitor de código de barras, alertas e relatórios avançados continuam nas etapas posteriores.

## Utilização

Em **Estoque**, pesquise o produto e consulte quantidade, unidade e valores estimados. Os filtros limitam a tabela e os totais apresentados. O custo estimado utiliza o saldo e o custo atual do cadastro; a venda potencial utiliza o preço atual. A margem é a diferença entre essas estimativas. Esses valores não constituem lucro realizado, custo médio contábil ou fluxo de caixa.

Uma **entrada** exige produto ativo, quantidade positiva, custo unitário, fornecedor ativo e data da operação. Uma **saída** exige produto ativo, quantidade positiva, preço unitário e data; o cliente é opcional. Uma operação registra um produto por lançamento. O fornecedor padrão e os valores atuais do cadastro podem preencher o formulário, mas o responsável deve conferir os valores praticados.

Entradas e saídas exigem `stock.write`. Ajustes positivos, negativos e compensações exigem `stock.adjust`, concedida inicialmente a administradores e gerentes. Toda consulta exige `stock.read`. A interface apresenta somente as ações permitidas; o servidor verifica novamente o acesso e a sessão durante a transação.

O ajuste informa a quantidade a acrescentar ou retirar, em vez de substituir diretamente o saldo. Sua justificativa é obrigatória. O histórico mostra os saldos anterior e posterior, responsável, data da operação, data do registro, valores históricos, parceiro e observações. Uma data de operação anterior não reordena o cálculo do saldo: os saldos refletem a ordem em que os lançamentos foram confirmados.

Uma movimentação confirmada permanece imutável. Para corrigir uma operação, abra os detalhes e solicite sua **compensação**, com justificativa. Ela cria outra movimentação com a quantidade inversa e os mesmos valores históricos. Cada original pode receber uma compensação; não é possível compensar uma compensação. Se a inversão retiraria quantidade indisponível, a operação é recusada. A correção preserva as referências históricas mesmo que um cadastro tenha sido inativado.

## Precisão e integridade

Quantidades e valores unitários aceitam até quatro casas decimais; os totais monetários são arredondados para duas casas, com meio centavo arredondado para cima. O servidor calcula com decimais exatos e verifica os limites das colunas. Não são aceitos valores negativos nos campos de quantidade ou valor unitário; o tipo de operação define a direção.

Entradas preservam o custo informado. Saídas e ajustes registram o custo atual do produto; saídas também preservam o preço de venda informado. Lançamentos não alteram automaticamente o custo ou o preço do cadastro. Uma alteração posterior no produto não modifica o histórico financeiro já registrado.

Cada intenção de gravação possui uma chave de idempotência. Repetir a mesma chave, ator e conteúdo devolve o lançamento original sem alterar novamente saldo ou auditoria. Reutilizar a chave com outro conteúdo é um conflito. O formulário preserva a solicitação durante uma resposta incerta para permitir sua repetição segura.

Se a conexão cair ou o servidor responder sem confirmar a gravação, o pedido fica pendente nessa aba e para esse usuário, em `sessionStorage`, sem credenciais de autenticação. A tela permite consultar o histórico e repetir o mesmo pedido; novos lançamentos nessa aba aguardam sua resolução. Recarregar a página recupera a pendência. Fechar a aba ou apagar o armazenamento pode perder essa recuperação e não cancela uma operação que o servidor tenha recebido.

Saldo, movimento e auditoria são gravados na mesma transação. A operação revalida a autorização após os locks compartilhados com a administração de acesso e de cadastros, e bloqueia o saldo do produto durante a atualização. Saídas, ajustes negativos e compensações são recusados se produziriam saldo negativo. As restrições de quantidade e imutabilidade também existem no PostgreSQL.

## Atualizar e verificar

A migration `202610310006_stock_control` acrescenta o hash da solicitação para idempotência e o índice de consulta histórica. Movimentos legados podem permanecer sem hash; as novas solicitações gravam o hash. Ela preserva os dados existentes.

```powershell
npm.cmd run db:up
npm.cmd run db:generate
npm.cmd run db:deploy
npm.cmd run db:check
npm.cmd test
npm.cmd run build
npm.cmd run check:stock
```

Reinicie `npm.cmd run dev` depois de atualizar. A integração usa banco descartável próprio, identidade de teste, credenciais efêmeras e servidor na porta `3012`. A limpeza verifica o marcador e remove somente os recursos criados pela execução. Não execute outro build enquanto a integração estiver utilizando a compilação.

## Resultados registrados

- TypeScript, geração do cliente Prisma e build de produção aprovados, sem avisos.
- **265 testes unitários**, em 18 arquivos, aprovados. Incluem cálculos exatos, limites, validação, autorização, idempotência, snapshots, repetição após falha de rede e respostas incompletas.
- **44 grupos de verificações HTTP/PostgreSQL de estoque** aprovados. Incluem entradas e saídas, ajustes, compensações únicas e concorrentes, saldo insuficiente, filtros, referências inativas, precisão, arredondamento, auditoria e revalidação de perfil e sessão após espera por lock.
- Uma falha controlada de auditoria, criada apenas no banco descartável, confirmou o rollback de movimento e saldo. Saídas concorrentes e repetições simultâneas confirmaram a ausência de saldo negativo e de efeitos duplicados.
- Regressões aprovadas: **61 verificações de autenticação**, **41 de cadastros** e **28 de integridade e privilégios**.
- Os bancos descartáveis e seus servidores foram removidos. O banco principal manteve um produto e zero movimentações; não recebeu lançamentos de teste. As seis migrations estão aplicadas e sua identidade foi conferida.
- O servidor local foi reiniciado. Saúde e login responderam HTTP 200; `/estoque` sem sessão redirecionou ao login e as APIs de estoque sem sessão responderam HTTP 401.

A inspeção visual completa em desktop e celular permanece pendente: o navegador e o acesso nativo automatizados estão indisponíveis nesta sessão. O roteiro abaixo permite conferir a apresentação e o uso com a conta do responsável. Não houve publicação nem avanço para a etapa 5.

## Conferência pelo responsável

1. Entre em `http://127.0.0.1:3000` e abra **Estoque**. Confira os produtos existentes, pesquisa, filtros, saldos e unidade.
2. Com um produto e fornecedor sob seu controle, registre uma entrada. Confira o aumento do saldo e o registro no histórico.
3. Registre uma saída parcial e confira seu preço e custo históricos. Tente retirar mais que o saldo e confira a recusa.
4. Como administrador ou gerente, faça um ajuste com justificativa e consulte o saldo anterior e o resultante. Como operador, confirme que ajustes não são disponibilizados.
5. Abra um lançamento e compense-o. Confira o vínculo entre os dois registros, os valores preservados e o efeito inverso no saldo.
6. Abra duas abas e tente saídas que, somadas, ultrapassem a quantidade disponível. Apenas a operação que ainda couber no saldo deve ser confirmada.
7. Altere o custo ou o preço no cadastro do produto e confira que os lançamentos anteriores conservam seus valores.
8. Confira formulários, confirmações, mensagens e tabelas em desktop e largura móvel.
