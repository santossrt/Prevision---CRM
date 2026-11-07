# Etapa 6 — Inventário físico e auditoria

Implementada e verificada automaticamente em **31/10/2026**. Esta etapa acrescenta **Inventários** e **Auditoria** ao menu. A compatibilidade adicional da câmera ficou adiada conforme orientação do responsável; a leitura existente da etapa 5 permanece disponível nos navegadores compatíveis.

## Abrir e contar um inventário

Um usuário com `stock.write` pode abrir um inventário informando título, observações opcionais e o escopo: todos os produtos ativos, produtos selecionados ou categorias ativas selecionadas. A primeira versão aceita até **200 produtos por inventário**. Escopos maiores são recusados com orientação para dividir a conferência; a seleção não é truncada silenciosamente.

A abertura registra responsável, data e uma referência da quantidade e versão do saldo de cada produto. Nome, SKU, unidade e categoria são preservados para identificar os itens conferidos. Abrir ou contar não altera o estoque.

Informe a quantidade física encontrada, inclusive zero, com até quatro casas decimais. Uma diferença em relação à referência exige justificativa de até 600 caracteres. A contagem é salva em lotes de até 20 itens por página, registrando contador e data. Todos os produtos precisam ser contados antes de confirmar.

Operadores podem abrir e preencher a contagem. A confirmação exige `stock.adjust`, disponível inicialmente a administradores e gerentes. A consulta exige `stock.read`. O criador com `stock.write`, ou alguém com `stock.adjust`, pode cancelar um inventário aberto; o cancelamento não movimenta estoque.

## Movimentações durante a contagem

O estoque continua operacional. Se uma entrada, saída, ajuste ou compensação modificar o saldo de um item, sua referência fica desatualizada. A comparação usa quantidade **e versão**, detectando também um saldo que mudou e depois voltou ao mesmo valor.

A confirmação recusa o inventário inteiro quando houver referência desatualizada. Utilize **Atualizar referência e recontar** nos itens afetados: essa ação registra o saldo atual e apaga a contagem, justificativa, contador e data desses itens. Os outros itens permanecem conferidos. Faça a nova contagem física antes de tentar confirmar.

Uma alteração de unidade no cadastro também impede a confirmação. A referência da unidade é histórica e imutável; nesse caso, reinicie o inventário com a unidade correta, em vez de aceitar uma contagem com significado diferente. Um produto inativado durante a contagem também precisa ser tratado antes da confirmação.

## Confirmar e preservar o histórico

A confirmação compara o físico com a referência validada e cria ajustes positivos ou negativos para as diferenças. Cada ajuste preserva custo unitário e total, justificativa e responsável, fica vinculado ao item e compartilha a identificação da operação do inventário. Produtos sem divergência não geram movimentação nem incremento da versão do saldo.

Movimentos, saldos, vínculos, alertas, auditoria e conclusão pertencem à mesma transação. Uma falha ou conflito desfaz a operação inteira. Não existe atualização direta da quantidade sem movimento correspondente. O custo é o valor atual do cadastro no momento da confirmação, com o mesmo cálculo decimal da etapa 4.

O inventário concluído ou cancelado fica somente para consulta. A correção de um ajuste confirmado utiliza a movimentação compensatória do estoque, preservando o inventário original e a ligação com o movimento.

Todas as alterações recebem uma chave de idempotência. Repetir o mesmo pedido devolve o estado atual do inventário, sem repetir seu efeito ou auditoria. Reutilizar a chave com outro ator, tipo ou conteúdo é um conflito. O formulário preserva a solicitação quando a resposta é incerta; não cria outra intenção automaticamente após falha de rede.

## Consultar auditoria

**Auditoria** exige `audit.read`, concedida inicialmente a administradores e gerentes. A tela apresenta responsável, ação, módulo, entidade, data, origem e identificação da operação, com pesquisa, filtros e paginação. Os detalhes mostram os valores anteriores e posteriores disponíveis.

A consulta usa uma lista explícita de campos permitidos para os snapshots. Credenciais, senhas, hashes de senha, tokens, cookies e campos desconhecidos não são devolvidos. Limites de tamanho e profundidade são apresentados quando parte dos dados foi omitida. A tela não oferece edição ou exclusão; privilégios e triggers também preservam os registros no PostgreSQL.

## Atualizar e verificar

A migration `202610310008_physical_inventory` acrescenta inventários, itens, operações idempotentes e o módulo de auditoria `INVENTORY`, com restrições e proteção do histórico. Ela não abre inventários nem cria contagens ou movimentos no banco principal.

```powershell
npm.cmd run db:generate
npm.cmd run db:deploy
npm.cmd run db:check
npm.cmd test
npm.cmd run build
npm.cmd run check:inventory
npm.cmd run check:audit
```

Reinicie o servidor local após a atualização. As integrações utilizam bancos descartáveis próprios, marcadores de limpeza e credenciais efêmeras; as portas são `3014` para inventário e `3015` para auditoria. Não gere outro build durante sua execução.

## Resultados registrados

- TypeScript, geração Prisma e build de produção aprovados, sem avisos de compilação.
- **399 testes unitários**, em 23 arquivos, aprovados. Incluem regras de inventário, idempotência do cliente, precisão, limite Unicode e privacidade da consulta de auditoria.
- **25 grupos HTTP/PostgreSQL de inventário** aprovados: seleção e limite de escopo, contagem e justificativa, permissões, versões, rebase seletivo, mudança de unidade, saldo que mudou e voltou, confirmação com itens divergentes e sem diferença, alertas e proteção do inventário encerrado.
- A integração confirmou rollback depois de três ajustes, confirmação simultânea da mesma chave, disputa entre dois inventários dos mesmos produtos e revogação de perfil e sessão durante a espera por lock. Lotes Unicode acima de 16 KiB foram salvos pelo limite específico de 64 KiB.
- **21 grupos HTTP/PostgreSQL de auditoria** aprovados: consultas e filtros, módulo de inventário, agrupamento por operação, snapshots sanitizados, ausência de inferência de origens e JSON privados pela busca, privilégios e revogação de acesso.
- Regressões aprovadas: **44 verificações de estoque**, **33 de código de barras e alertas**, **61 de autenticação**, **41 de cadastros** e **28 de integridade e privilégios**.
- Todos os bancos descartáveis foram removidos. O banco principal manteve um produto, zero movimentações, zero inventários, zero itens e zero operações de inventário; os testes não criaram contagens reais. As oito migrations e a identidade do banco foram conferidas.
- Servidor local reiniciado: saúde e login HTTP 200, páginas novas sem sessão redirecionando ao login e APIs novas sem sessão HTTP 401.

A inspeção visual completa e a conferência de uso permanecem pendentes: o acesso automatizado ao navegador e aos aplicativos foi novamente verificado e continua indisponível. O roteiro abaixo permite a validação pelo responsável. Não houve publicação, alteração da câmera ou avanço para a etapa 7.

## Conferência pelo responsável

1. Abra **Inventários**, crie um inventário com produtos sob seu controle e confira as referências registradas.
2. Informe quantidades iguais, maiores e menores que a referência; confira a exigência de justificativa para diferenças e o salvamento da página.
3. Com um operador, confira que a contagem pode ser preenchida e que a conclusão exige permissão adicional.
4. Movimente um dos produtos em outra aba. Tente confirmar e confira o bloqueio, a indicação do item e a atualização explícita da referência, seguida de nova contagem.
5. Como administrador ou gerente, confirme um inventário completo. Confira saldos, ajustes vinculados, alertas e data e responsável pela conclusão.
6. Repita a confirmação do mesmo pedido e confira a ausência de duplicação. Abra o inventário concluído e confira que ele não permite alterar os itens.
7. Cancele outro inventário aberto e confira que nenhum saldo foi alterado.
8. Abra **Auditoria**, filtre por inventário, produto, responsável e período e consulte os detalhes e a identificação da operação. Como operador, confira a restrição de consulta.
9. Confira pesquisa, formulários, tabelas, confirmações e mensagens em desktop e largura móvel.
