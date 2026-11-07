# Etapa 8 — Central de notificações e preferências

## Acompanhar a equipe

**Notificações** reúne o histórico de avisos do ambiente com tipo, data e hora, indicação de leitura e acesso ao módulo relacionado. O sino mostra quantas notificações autorizadas ainda não foram lidas por você. A leitura é individual: marcar um aviso não muda o estado para outra pessoa.

É possível pesquisar pelo texto, filtrar por tipo, período e leitura, consultar páginas do histórico e marcar uma ou todas como lidas. A marcação geral considera o momento da consulta e todas as notificações autorizadas até esse momento, inclusive fora do filtro atual. Avisos posteriores continuam não lidos. Repetir a marcação não altera a primeira data de leitura.

O sino e a central atualizam a cada 30 segundos enquanto a aba está visível, ao recuperar o foco e após operações locais. Eles não exigem conexão permanente ou serviço externo.

## O que gera uma notificação

| Tipo | Quando é registrado |
| --- | --- |
| Estoque baixo | Quando o produto ativo entra na condição de saldo positivo menor ou igual ao mínimo. |
| Produto sem estoque | Quando o produto ativo entra na condição de saldo zero. |
| Movimentação relevante | Ajustes positivos, negativos e compensações confirmados. Entradas e saídas comuns podem gerar os avisos de condição acima. |
| Inventário concluído | Ao confirmar a conclusão de uma conferência física. |
| Divergências de inventário | Ao concluir um inventário com diferenças, em um aviso agrupado que direciona à conferência. |
| Aviso administrativo | Publicação explícita de um administrador autorizado, após conferir título e mensagem. |

Uma movimentação dentro da mesma condição não gera outro aviso de estoque baixo. Reabertura ou mudança de condição gera uma nova ocorrência. Ajustes internos de inventário ficam agrupados na conclusão e nas divergências; não geram um aviso de movimentação por item. Repetições idempotentes não duplicam eventos.

Os avisos automáticos são gravados na transação da operação original. Um rollback desfaz também a notificação. O histórico preserva a condição registrada naquele momento, mesmo quando o saldo atual ou o cadastro já mudou. Os alertas do painel inicial continuam mostrando as condições atuais.

A migration inicializa somente as condições de estoque realmente abertas no momento da atualização e identifica essa origem no texto. Não recria notificações de movimentações ou inventários antigos como novas atividades.

## Permissões e avisos administrativos

Cada consulta, contador e marcação revalida a sessão e as permissões atuais. Notificações de estoque e inventário exigem `stock.read`; sem essa permissão, não aparecem nem no contador ou na pesquisa. As páginas de destino também verificam o acesso. Avisos administrativos ficam disponíveis aos usuários autenticados do ambiente.

A publicação exige perfil **Administrador** e `settings.manage`, inclusive no servidor. O administrador confere a mensagem antes de publicar. O pedido mantém a mesma identificação quando há resposta incerta e pode ser retomado na mesma aba, evitando duplicação. A auditoria registra responsável e metadados da publicação; não copia o corpo da mensagem. Não há envio de e-mail, mensagem externa ou exclusão do histórico pela interface.

## Aparência

Em **Configurações**, escolha **Claro**, **Escuro** ou **Conforme o sistema** e clique em **Salvar aparência**. A preferência pertence à sua conta e é usada nos próximos acessos, inclusive em outros dispositivos. Ela não muda o tema dos colegas. O modo conforme o sistema acompanha a preferência do dispositivo por CSS.

O servidor usa a preferência da conta para renderizar as páginas autenticadas. Um cookie validado armazena somente uma indicação visual para páginas públicas; ele não autentica nem concede acesso. Edições concorrentes são detectadas pela versão e exigem recarregar a preferência antes de sobrescrever.

## Estrutura e verificações

A migration `202611010010_notifications_preferences` acrescenta eventos imutáveis (`Notification`), leituras individuais imutáveis (`NotificationRead`) e preferência versionada (`UserPreference`). Não altera produtos, saldos ou movimentos. O backend e a interface reutilizam as dependências existentes.

```powershell
npm.cmd run db:generate
npm.cmd run db:deploy
npm.cmd run db:check
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run check:notifications
```

A integração utiliza um banco descartável identificado e servidor próprio na porta `3018`, com credenciais efêmeras e limpeza restrita aos recursos criados. Não gere outro build durante sua execução.

Validação concluída em **06/11/2026**:

- TypeScript e build de produção aprovados; **659 testes unitários em 37 arquivos** aprovados.
- **20 verificações de notificações e preferências** aprovadas em banco e servidor descartáveis: leitura individual, concorrência, corte temporal, filtros, permissões atuais, avisos administrativos, idempotência, auditoria, triggers, rollback e tema por usuário.
- Regressões aprovadas: autenticação (61), estoque (44), importação (20), códigos e alertas (33) e inventários (25).
- Conexão e identidade do PostgreSQL verificadas, com as dez migrations aplicadas. Os bancos descartáveis foram removidos e as contagens do banco principal permaneceram iguais antes e depois das verificações.
- Servidor de desenvolvimento iniciado em `http://127.0.0.1:3000`. Saúde e login retornaram 200; páginas protegidas redirecionaram ao login e APIs sem sessão retornaram 401.
- Os três modos de tema foram conferidos no HTML renderizado pelo servidor; um cookie com valor desconhecido utiliza o modo sistema. As cores das notificações foram verificadas por cálculo de contraste, com mínimos de 5,08:1 no claro e 7,43:1 no escuro.

A conferência visual automática não foi concluída: a ferramenta de controle do navegador interrompeu o acesso por não conseguir identificar sua URL com segurança. A revisão de layout, navegação por teclado e largura móvel no navegador permanece no roteiro abaixo.

## Conferência de uso

1. Abra a central e confira o sino, filtros, paginação e links para produto, movimentação e inventário.
2. Com duas contas, marque um aviso como lido em uma delas e confira que a outra continua com o aviso não lido.
3. Faça uma reposição e um consumo sob seu controle; confira que avisos históricos permanecem e o painel inicial representa a situação atual.
4. Como administrador, confira e publique um aviso de teste deliberado. Gerentes e operadores devem conseguir consultá-lo, sem ação de publicar.
5. Em Configurações, salve cada modo, navegue entre tabelas, formulários e modais e confira contraste, foco e legibilidade. Confira também em largura móvel.
6. Abra a aparência em duas abas, salve na primeira e confira o conflito ao tentar salvar uma versão antiga na segunda.
