# Etapa 5 — Código de barras e estoque mínimo

Implementada e verificada automaticamente em **31/10/2026**. Esta etapa implementa busca exata por código de barras e alertas persistentes de estoque, integrados às movimentações, ao cadastro de produtos e à visão geral. Não exige equipamento específico: a digitação manual continua disponível.

## Localizar e movimentar por código

Em **Controle de estoque → Registrar entrada/saída → Localizar produto**, utilize o campo de código. Digite ou leia com um dispositivo USB configurado como teclado e finalize com **Enter**. A leitura ocorre nesse campo, sem capturar teclas enquanto o usuário preenche outros formulários. O código mantém os zeros à esquerda e não é convertido em número.

A consulta compara o código de barras completo, com diferenciação entre maiúsculas e minúsculas. Um fragmento ou SKU não substitui o código. O resultado apresenta produto e saldo; a seleção preenche o produto da movimentação. Quantidade, parceiro, valores e confirmação continuam sendo necessários. Ler um código não grava uma movimentação.

Se o código não estiver cadastrado, a tela permite abrir o cadastro de produtos com o código preenchido. Criar o produto ainda exige permissão de catálogo, os demais campos e confirmação. A unicidade é validada também no banco. Produtos inativos podem ser identificados, mas não podem ser selecionados para uma nova movimentação.

## Câmera

O botão **Ler com câmera** utiliza os recursos nativos do navegador quando disponíveis. O acesso à câmera é solicitado somente após essa ação; áudio não é solicitado. O usuário pode negar o acesso e continuar com digitação ou leitor USB.

A implementação verifica contexto seguro, `getUserMedia`, `BarcodeDetector` e os formatos suportados. A disponibilidade varia conforme navegador e dispositivo. A detecção ocorre localmente no navegador, sem envio de imagens para um serviço externo. Ao encerrar, encontrar um código, sair da tela ou ocultar a aba, os recursos da câmera são liberados.

Referências primárias: [Barcode Detection API](https://developer.mozilla.org/en-US/docs/Web/API/Barcode_Detection_API), [getUserMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia) e [MediaStreamTrack.stop](https://developer.mozilla.org/en-US/docs/Web/API/MediaStreamTrack/stop).

## Configurar e acompanhar alertas

O estoque mínimo continua configurável em **Produtos → Editar**, na unidade do produto, com até quatro casas decimais. As situações são:

| Situação | Condição para produto ativo |
| --- | --- |
| Sem estoque | Quantidade igual a zero, inclusive com mínimo zero. |
| Estoque baixo | Quantidade maior que zero e menor ou igual ao mínimo. |
| Acima do mínimo | Quantidade maior que o mínimo; sem alerta ativo. |

O sino e o painel **Alertas de estoque**, na visão geral, mostram os alertas atuais. As contagens são globais para o estoque compartilhado; o tipo e a paginação limitam a lista apresentada. Os links abrem o estoque com os filtros correspondentes, onde também é possível pesquisar produtos. A consulta exige `stock.read`.

Há uma única linha de alerta por produto. Permanecer na mesma situação não cria outro aviso nem altera sua data de transição. A mudança entre baixo e sem estoque atualiza o mesmo registro. A reposição acima do mínimo ou a inativação resolve o alerta; uma nova falta reabre a mesma linha com nova data de abertura.

A migration `202610310007_stock_alerts` cria a estrutura e sincroniza os produtos existentes. Triggers atualizam os alertas na mesma transação de alterações do saldo, do mínimo ou da ativação do produto. Uma operação revertida também reverte a mudança do alerta. A sincronização não altera quantidades nem cria movimentações.

A interface atualiza após operações na mesma aba, ao recuperar o foco e, enquanto visível, a cada 30 segundos. Mudanças feitas por outra pessoa podem levar até esse intervalo para aparecer. O sino indica condições atuais; marcação individual como lida e central de notificações com histórico continuam para a etapa 8.

## Repetir as verificações

```powershell
npm.cmd run db:generate
npm.cmd run db:deploy
npm.cmd run db:check
npm.cmd test
npm.cmd run build
npm.cmd run check:stock-tools
```

Reinicie o servidor de desenvolvimento após a atualização. A integração utiliza banco descartável com prefixo `prevision_stock_tools_test_`, marcador exclusivo e servidor na porta `3013`. Não gere outro build durante sua execução. As fixtures não devem ser persistidas no banco principal.

## Resultados registrados

- TypeScript, geração Prisma e build de produção aprovados, sem avisos.
- **312 testes unitários**, em 20 arquivos, aprovados. Os novos casos cobrem códigos exatos e inválidos, zeros iniciais, autorização, formatos de detecção, liberação da câmera e contratos dos alertas.
- **33 grupos de verificações HTTP/PostgreSQL** da etapa 5 aprovados: backfill da migration, lookup exato e case-sensitive, permissões, referência inativa, filtros, mínimo exato, saldo zero, resolução, reabertura, deduplicação e timestamps.
- A integração confirmou sincronização em entradas, saídas, ajustes e compensações; preservação em replay; rollback do alerta junto do saldo e movimento quando a auditoria falha; e consistência em saídas concorrentes e em duas ordens de alterações cruzadas de mínimo e quantidade.
- Regressões aprovadas: **44 verificações de estoque**, **61 de autenticação**, **41 de cadastros** e **28 de integridade e privilégios**.
- O banco descartável da etapa e o servidor da porta 3013 foram removidos. Os testes não criaram movimentações no banco principal.
- Conferência final: sete migrations aplicadas, um produto e zero movimentações no banco principal, um alerta correspondente à sua condição atual e nenhum banco descartável remanescente. Servidor reiniciado; saúde e login HTTP 200 e novas APIs sem sessão HTTP 401.

Leitor USB físico, câmera real e inspeção visual permanecem para conferência no dispositivo do responsável. O acesso automatizado ao navegador e aos aplicativos está indisponível nesta sessão. Os testes de liberação de mídia usam objetos simulados e não comprovam o comportamento de uma câmera específica. Não houve instalação de dependências, publicação ou avanço para o inventário da etapa 6.

## Conferência no dispositivo

1. Cadastre ou escolha um produto sob seu controle com código de barras e mínimo configurado.
2. Na nova entrada ou saída, digite o código com zeros à esquerda e pressione Enter. Confira resultado, saldo e seleção; confirme que a leitura não salva um lançamento.
3. Repita com o leitor USB configurado como teclado, mantendo o foco no campo de código. Confira também a busca manual por nome e SKU.
4. Informe um código desconhecido e confira a opção de cadastrar com o código preenchido. A tentativa de repetir um código já utilizado deve ser recusada.
5. Em navegador compatível, acione a câmera, aceite o acesso, leia um código e confira que a câmera encerra. Repita negando a permissão e fechando a leitura. Em navegador incompatível, confira a alternativa manual/USB.
6. Com um produto ativo, confira alerta de quantidade zero, quantidade positiva igual ao mínimo e reposição acima do mínimo. Repita alterando apenas o mínimo no cadastro.
7. Confira que uma operação que mantém a mesma situação não duplica o alerta. Inative e reative o produto e confira resolução e reabertura.
8. Abra o link de um alerta e confira os filtros aplicados no estoque. Verifique o sino, o painel, o leitor e os formulários em desktop e largura móvel.
