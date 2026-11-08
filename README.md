# PREVISION

Sistema web de gestão de estoque desenvolvido como Trabalho de Conclusão de Curso. Usuários autorizados compartilharão um único estoque, com histórico de operações e indicadores de apoio à gestão.

## Estado do projeto

A etapa 1 estabeleceu a aplicação Next.js, TypeScript, Tailwind CSS, Prisma e PostgreSQL. A etapa 2 implementou acesso com senha e Google, ativação, recuperação, sessões revogáveis, perfis e administração de usuários. A etapa 3 implementou os cadastros; a etapa 4, o controle de estoque; a etapa 5, a leitura por código e os alertas de mínimo; a etapa 6, o inventário físico e a auditoria; a etapa 7, a importação e exportação; a etapa 8, a central de notificações e as preferências de aparência; a etapa 9, o dashboard e os indicadores. A **etapa 10: análises avançadas** acrescenta Curva ABC, estimativas de reposição e exportação das análises e dos indicadores em Excel ou PDF.

O fluxo Google exige credenciais do provedor e autorização prévia por usuário. Neste ambiente de trabalho, a vinculação e o login com uma conta Google real foram confirmados pelo responsável e pelos registros de acesso no banco. Novas instalações precisam configurar suas próprias credenciais. O envio real de e-mails exige SMTP, ainda não configurado; o desenvolvimento utiliza uma caixa de mensagens local. Por decisão do responsável, a etapa 11 foi limitada aos testes funcionais, de segurança e recuperação. O preparo da demonstração pública ficou fora desse escopo; publicação e documentação final continuam previstas para a etapa 12. A ampliação de compatibilidade da câmera ficou adiada pelo responsável.

## Publicação da demonstração

A demonstração foi publicada em [prevision-iota.vercel.app](https://prevision-iota.vercel.app),
com aplicação na Vercel e PostgreSQL no Supabase. O acesso exige uma conta autorizada.
Consulte [a configuração e a validação da publicação](docs/deployment-vercel-supabase.md),
incluindo TLS, credenciais privadas, SMTP e as pendências operacionais.

## Executar localmente

Requisitos: Node.js 24.12 ou superior na linha 24, npm 11 e Docker Desktop com servidor Linux disponível. A configuração validada utiliza Node.js 24.22. Os scripts TypeScript usam o suporte nativo do Node. As permissões de instalação de Prisma e esbuild estão declaradas em `allowScripts` no `package.json`.

Os exemplos usam `npm.cmd` para funcionar no PowerShell mesmo quando a política do Windows bloqueia `npm.ps1`. Não é necessário alterar essa política.

```powershell
npm.cmd install
npm.cmd run env:setup
npm.cmd run auth:setup
npm.cmd run db:up
npm.cmd run db:generate
npm.cmd run db:deploy
npm.cmd run db:identify
npm.cmd run db:check
npm.cmd run auth:bootstrap
npm.cmd run dev
```

Abra [http://127.0.0.1:3000](http://127.0.0.1:3000). Esse é o endereço configurado em `AUTH_URL`; utilize-o também nos links de ativação e recuperação.

`env:setup` cria o `.env` com senhas aleatórias distintas de administração e runtime. `auth:setup` acrescenta a chave de autenticação e a configuração de mensagens locais. Ambos preservam os campos existentes, sem imprimir segredos. Confira os nomes dos campos em [.env.example](.env.example), sem versionar o `.env`.

`auth:bootstrap` solicita o e-mail, a senha e sua confirmação no terminal. A senha fica oculta, sem letras ou asteriscos, e deve conter de 12 a 128 caracteres. Se o e-mail ou a senha forem inválidos, ou a confirmação não coincidir, o comando explica o problema e permite tentar novamente. Não há credenciais padrão. O comando exige o banco local identificado e não altera um administrador já existente. Em execução sem terminal interativo, recebe `BOOTSTRAP_ADMIN_EMAIL` e `BOOTSTRAP_ADMIN_PASSWORD` pelo ambiente do processo.

O PostgreSQL Docker publica somente `127.0.0.1:55432` por padrão, com a porta configurável por `POSTGRES_PORT`. O serviço mantém `prevision_dev` em volume e usa credenciais diferentes: `prevision_app` para a aplicação e `prevision_admin` para migrations. `db:up` inicia o serviço; `db:deploy` aplica as migrations. `db:identify` registra a sentinela apenas em banco sem identidade, e `db:check` confirma a identidade configurada. Os comandos de migrations recusam destinos fora do desenvolvimento local esperado.

No Windows x64, `db:local:up` oferece uma alternativa portátil sem Docker, com PostgreSQL oficial e checksum fixo em `.cache/postgres`. Pare com `db:local:down`. O portátil usa `127.0.0.1:54329` e armazenamento independente. Para utilizá-lo, pare o Docker, ajuste as URLs para a porta `54329` e confirme que o Windows não a reservou. Apenas alternar os comandos não transfere dados nem reconfigura as URLs; consulte [os ambientes](docs/environments.md).

## Primeiro acesso e usuários

Entre com a conta criada no bootstrap. Em **Usuários**, o administrador pode cadastrar usuários, atribuir o perfil, autorizar Google, alterar dados, ativar ou desativar o acesso e reenviar convites de quem ainda não ativou a conta. O usuário convidado define sua própria senha pelo link recebido.

O botão **Redefinir senha** é exclusivo do perfil **Administrador**, com confirmação e validação também no servidor. Ele gera um link de uso único, válido por 30 minutos, para qualquer usuário cadastrado, inclusive contas Google e inativas. O usuário escolhe a nova senha; ao salvá-la, as sessões anteriores são encerradas. A ação preserva o vínculo Google e não ativa uma conta inativa. No desenvolvimento, consulte as instruções com `npm.cmd run mail:read`; o envio pela internet depende do SMTP. Veja [a redefinição administrativa](docs/admin-password-reset.md).

Com `MAIL_TRANSPORT=local`, as mensagens ficam em `.cache/mail`, ignorada pelo Git. Após criar um usuário ou solicitar recuperação, consulte a mensagem mais recente no seu terminal:

```powershell
npm.cmd run mail:read
```

O comando exibe o link privado de ativação ou recuperação. Abra-o no navegador; não compartilhe esse conteúdo nem publique a pasta de mensagens. Essa caixa está disponível somente no desenvolvimento e não envia e-mails pela internet.

A ativação expira em 24 horas e a recuperação em 30 minutos, ambas com uso único. Redefinir a senha revoga as sessões anteriores. A recuperação apresenta uma resposta genérica para não confirmar o cadastro de um e-mail.

## Cadastros

Depois de entrar, utilize **Produtos**, **Categorias**, **Fornecedores** e **Clientes** no menu. As quatro áreas permitem pesquisar, paginar, cadastrar, editar, inativar e reativar registros. A consulta exige `catalog.read`; alterações exigem `catalog.write`, verificadas também no servidor.

Comece por uma categoria ativa e, se necessário, um fornecedor. Ao cadastrar um produto, informe nome, SKU, categoria e unidade; código de barras e fornecedor padrão são opcionais. O SKU é normalizado em maiúsculas, e o código de barras preserva zeros à esquerda. Ambos continuam únicos mesmo quando o produto é inativado. Categorias não podem repetir o nome apenas mudando maiúsculas e minúsculas.

Quantidades e valores unitários aceitam até quatro casas decimais. Nos formulários, use vírgula ou ponto, sem separador de milhar. O produto começa com **saldo zero**; o cadastro não permite alterar a quantidade diretamente. A criação registra o custo e o preço iniciais, e alterações desses valores acrescentam histórico com data e responsável, preservando os registros anteriores.

Produtos podem ser filtrados por categoria, fornecedor, situação do cadastro e estoque: sem estoque, baixo ou acima do mínimo. Fornecedores e clientes possuem documento, contato e endereço opcionais. O documento aceita letras e números, remove espaços e a pontuação usual e fica em maiúsculas; essa validação não comprova autenticidade nem verifica dígitos de CPF/CNPJ.

As alterações usam a versão do cadastro para detectar uma edição concorrente. Se outra operação tiver salvo antes, o formulário informa o conflito e permite carregar a versão atual. Os cadastros são inativados em vez de excluídos, preservando referências e histórico. Uma nova associação ou a reativação de produto exige categoria e fornecedor padrão ativos; associações inativas já existentes podem ser preservadas em outras edições.

O schema possui onze migrations versionadas. A quarta acrescenta as versões dos cadastros e a unicidade do nome de categoria; a quinta prepara a redefinição administrativa de senha; a sexta, a idempotência do estoque; a sétima cria e sincroniza os alertas; a oitava acrescenta inventários e suas operações; a nona guarda prévias e resultados de importação e exportação; a décima, notificações, leituras individuais e preferências de aparência. A décima primeira ajusta o horário das novas gravações do histórico de valores e acrescenta índices para o dashboard, preservando os registros antigos. Para atualizar uma instalação existente, execute `npm.cmd run db:deploy`, gere o cliente com `npm.cmd run db:generate` e reinicie `npm.cmd run dev` antes de usar os novos recursos. Consulte [a validação da etapa 3](docs/validation-step-3.md) para o roteiro dos cadastros.

## Dashboard e indicadores

Em **Visão geral**, consulte produtos cadastrados, ativos e inativos, condições de estoque, custo estimado, venda potencial e margem estimada. O painel exige `reports.read` e `stock.read`, verificadas no servidor. Os valores atuais consideram todos os produtos, inclusive inativos; os indicadores de estoque baixo e vazio consideram somente ativos.

Escolha as duas datas para consultar até 366 dias, no calendário de `America/Sao_Paulo`; sem filtro, o período é dos últimos 30 dias. Os gráficos mostram entradas e saídas em custos históricos, evolução do valor estimado, produtos mais movimentados, maior valor em estoque e distribuição por categoria. Entradas e saídas são os lançamentos originais brutos por data da operação; ajustes e compensações ficam separados. As quantidades são agrupadas pela unidade atual do produto, sem somar unidades diferentes.

A evolução usa o saldo dos movimentos registrados e o custo de aquisição histórico em cada fechamento. Uma operação retroativa afeta seu período de operação e passa a compor a evolução a partir do registro. Custos atuais não substituem os custos antigos. Os valores são calculados no servidor, com arredondamento por produto antes da soma; estimativas de estoque não representam lucro realizado nem custo médio contábil. Consulte [a etapa 9](docs/validation-step-9.md) para critérios, limitações e roteiro de conferência.

## Estoque

Abra **Estoque** no menu para consultar saldos e registrar operações. Entradas exigem produto ativo, quantidade, custo unitário, fornecedor e data. Saídas exigem quantidade, preço unitário e data, com cliente opcional. Administradores e gerentes também podem fazer ajustes positivos ou negativos, sempre com justificativa.

O saldo é atualizado junto do movimento e da auditoria, sem permitir quantidade negativa. Solicitações repetidas com a mesma chave não duplicam o lançamento. Custos e preços praticados ficam preservados no histórico; os lançamentos não alteram automaticamente os valores do cadastro.

Movimentações confirmadas são imutáveis. A ação **Compensar**, nos detalhes, exige justificativa e permissão de ajuste e registra uma operação inversa vinculada à original. A compensação também respeita o saldo disponível. Os indicadores financeiros dos saldos são estimativas pelos valores atuais dos produtos, sem representar lucro realizado ou custo médio contábil. Consulte [a etapa 4](docs/validation-step-4.md) para regras, verificações e roteiro de uso.

## Código de barras e alertas

No formulário de nova movimentação, digite o código ou use um leitor USB configurado como teclado no campo **Localizar por código de barras**, finalizando com Enter. A consulta exige o código completo e preserva os zeros à esquerda. Confira o resultado e escolha **Usar este produto**; a leitura não salva um lançamento. Um código desconhecido permite abrir o cadastro de produtos com o código preenchido, sujeito às permissões e à confirmação normal.

O botão **Ler com câmera** solicita acesso somente quando acionado e depende dos recursos oferecidos pelo navegador. Se indisponível ou sem autorização, continue pelo campo ou leitor USB. A leitura utiliza processamento local e libera a câmera ao encerrar.

Configure o mínimo em **Produtos → Editar**. Produtos ativos com saldo zero geram alerta de **sem estoque**; saldo positivo menor ou igual ao mínimo gera **estoque baixo**. O painel de alertas na visão geral mostra essas condições e abre o estoque com filtros. Reposição acima do mínimo e inativação resolvem o alerta. As operações e alterações no mínimo sincronizam o mesmo registro por produto, evitando duplicação. O sino abre a central de notificações, com seu histórico e contador de não lidas.

Os alertas são internos ao sistema, sem envio de e-mail. As telas atualizam após operações locais, ao recuperar o foco e a cada 30 segundos enquanto visíveis. Veja [a etapa 5](docs/validation-step-5.md) para detalhes, verificações e teste do leitor ou câmera no seu dispositivo.

## Inventários e auditoria

Em **Inventários**, selecione todos os produtos ativos, produtos específicos ou categorias, até 200 itens por conferência. A abertura guarda a referência de saldo e sua versão. Informe e salve a quantidade física em páginas de até 20 itens, justificando cada divergência. Abrir e contar não alteram o saldo.

Operadores podem preencher a conferência; administradores e gerentes podem confirmar os ajustes. Se algum produto for movimentado durante a contagem, atualize explicitamente sua referência e conte-o novamente. A confirmação recusa versões desatualizadas e grava todos os ajustes, vínculos, alertas e auditoria na mesma transação. Inventários encerrados ficam somente para consulta.

Em **Auditoria**, administradores e gerentes consultam responsáveis, ações, módulos, entidades, datas, origem e valores anteriores e registrados. Há pesquisa, filtros, paginação e detalhes, sem edição ou exclusão. Campos de credenciais e tokens são omitidos da consulta. Veja [a etapa 6](docs/validation-step-6.md) para regras, limites e validação.

## Importação e exportação

Em **Importar e exportar → Importar produtos**, baixe o modelo CSV ou Excel e preencha até 200 produtos, em arquivo de até 2 MiB. Categorias e fornecedores devem existir e estar ativos. SKU e código de barras devem ser texto para preservar zeros. Gere a prévia, corrija os erros por linha e confirme o lote inteiro. A operação exige `catalog.read` e `catalog.write`, cria os produtos com saldo zero e não altera cadastros existentes. A confirmação repetida não duplica os produtos.

Em **Exportar relatórios**, selecione produtos, estoque, movimentações, inventários, auditoria, indicadores, Curva ABC ou previsão de reposição e aplique os filtros disponíveis. A prévia congela até 1.000 registros por 30 minutos; refine os filtros quando exceder o limite. Excel e PDF usam os dados dessa prévia, com responsável, data e filtros. O acesso exige `reports.read` e a permissão de consulta da fonte, verificadas novamente no download. As prévias são privadas por usuário.

O Excel preserva códigos e decimais como texto. O PDF apresenta relatórios largos por registro; na auditoria, **Valores anteriores** e **Valores registrados** ocupam seções próprias, com nomes de campos legíveis. Somente campos disponíveis para consulta são exportados, com avisos quando houver omissão ou limitação. Consulte [a etapa 7](docs/validation-step-7.md) para regras e roteiro de uso e [a revisão de dependências](docs/dependency-review-step-7.md) para os avisos dos pacotes utilizados.

## Notificações e aparência

Em **Notificações**, consulte o histórico, pesquise por texto, filtre por tipo, período e leitura e abra o módulo relacionado. O sino indica as notificações autorizadas ainda não lidas por você. Marcar uma ou todas como lidas afeta somente sua conta e mantém o histórico. A marcação geral considera o horário da consulta; notificações posteriores continuam não lidas.

O sistema registra mudanças para estoque baixo ou vazio, ajustes e compensações, inventários concluídos e suas divergências agrupadas. Permanecer na mesma condição não repete o alerta. As notificações de estoque e inventário exigem `stock.read`, inclusive na pesquisa e no contador. Avisos administrativos são visíveis aos usuários autenticados; publicar exige perfil **Administrador** e `settings.manage`, com revisão e proteção contra duplicação em respostas incertas.

Em **Configurações**, escolha **Claro**, **Escuro** ou **Conforme o sistema** e salve a aparência. A preferência pertence à sua conta e será usada nos próximos acessos e dispositivos. Alterações concorrentes são detectadas pela versão; recarregue a preferência quando houver conflito. Consulte [a etapa 8](docs/validation-step-8.md) para regras e roteiro de uso.

## Curva ABC e previsão de reposição

Em **Análises**, consulte a Curva ABC e a previsão de reposição. O acesso exige `reports.read` e `stock.read`. Selecione um período de até 366 dias no calendário de `America/Sao_Paulo`, pesquise produtos e filtre a situação. Os limites A/B e o horizonte de reposição são critérios da consulta; não alteram parâmetros globais ou cadastros. O padrão são os últimos 90 dias, A até aproximadamente 80%, B até aproximadamente 95% e horizonte de 30 dias.

A Curva ABC considera o custo histórico das saídas, descontando as compensações de saídas pela data da própria compensação. Saldos líquidos negativos são limitados a zero e sinalizados. A classificação utiliza os valores exatos: o grupo de produtos com o mesmo valor permanece na faixa em que começou, inclusive ao atravessar um limite. Produtos sem consumo financeiro ficam sem classe. A tabela e o gráfico apresentam participação individual e acumulada; a classificação considera todo o conjunto filtrado, limitado a 1.000 produtos. Se exceder esse limite, refine os filtros; não há classificação de uma amostra.

A previsão exige pelo menos 30 dias observados e consumo líquido positivo em dois dias distintos. Usa o saldo atual, consumo médio, estoque mínimo, segurança e prazo do produto; quando o prazo não estiver preenchido, utiliza o fornecedor padrão. Prazo zero é válido. Falta de histórico, ausência de prazo, inativação ou alteração de unidade são informadas, sem inventar uma recomendação. As datas partem do dia atual em São Paulo; estimativas além de 3.650 dias ficam sem data. As quantidades sugeridas são estimativas explicadas, sem criação automática de pedidos ou garantia de consumo futuro.

Confira e exporte as análises em Excel ou PDF; os indicadores do estoque também estão disponíveis em **Importar e exportar**. A prévia preserva os resultados e critérios selecionados. Consulte [a etapa 10](docs/validation-step-10.md) para fórmulas, limites e roteiro de uso.

## Google e envio de e-mails

Para habilitar Google, configure `GOOGLE_CLIENT_ID` e `GOOGLE_CLIENT_SECRET` no `.env` e registre o callback exato `http://127.0.0.1:3000/api/auth/callback/google` no cliente OAuth. Reinicie a aplicação após alterar a configuração. O administrador também precisa autorizar Google para o usuário. A primeira vinculação ocorre pelo convite de ativação ou, em **Perfil**, após confirmar a senha atual. O e-mail verificado pelo Google deve corresponder ao cadastro autorizado; entrar com Google não cria usuários automaticamente.

Se baixou o JSON do cliente Web no Google Cloud, importe as credenciais localmente com `npm.cmd run auth:google -- "C:\caminho\arquivo.json"`. O comando confere o callback e preenche somente os campos Google no `.env`, sem imprimir os valores. Campos Google já configurados com outros valores são preservados; use o `.env` diretamente para uma troca deliberada. O arquivo baixado contém o segredo: mantenha-o privado e fora do versionamento.

Para envio real, configure `MAIL_TRANSPORT=smtp`, `MAIL_FROM`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER` e `SMTP_PASSWORD`. O transporte aceita TLS na porta 465 ou STARTTLS na 587. Preencha os valores no `.env`, sem enviá-los pelo chat. A configuração detalhada está em [ambientes](docs/environments.md).

## Comandos

| Comando | Finalidade |
| --- | --- |
| `npm.cmd run env:setup` | Criar o `.env` local, preservando arquivo existente. |
| `npm.cmd run auth:setup` | Acrescentar a configuração de autenticação e mensagens locais. |
| `npm.cmd run auth:google -- "arquivo.json"` | Importar o JSON do cliente Google Web para o `.env` local. |
| `npm.cmd run auth:bootstrap` | Criar o primeiro administrador com credenciais escolhidas no terminal. |
| `npm.cmd run mail:read` | Ler a mensagem local mais recente. |
| `npm.cmd run dev` | Iniciar a aplicação em desenvolvimento. |
| `npm.cmd run build` | Gerar a compilação de produção. |
| `npm.cmd run start` | Servir a compilação gerada por `build`. |
| `npm.cmd run typecheck` | Verificar os tipos TypeScript. |
| `npm.cmd test` | Executar os testes unitários. |
| `npm.cmd run db:generate` / `db:validate` | Gerar o client / validar o schema Prisma. |
| `npm.cmd run db:deploy` | Aplicar migrations versionadas no banco local configurado. |
| `npm.cmd run db:migrate` | Criar e aplicar uma migration de desenvolvimento; revisar o SQL gerado. |
| `npm.cmd run db:identify` / `db:check` | Registrar a identidade inicial / conferir conectividade e sentinela. |
| `npm.cmd run db:status` | Consultar migrations pendentes. |
| `npm.cmd run check:integration` | Verificar integridade e privilégios do banco com fixtures revertidas. |
| `npm.cmd run check:auth` | Verificar autenticação HTTP em banco descartável; exige `build` atualizado e porta 3010 livre. |
| `npm.cmd run check:catalog` | Verificar cadastros HTTP e regras de banco em ambiente descartável; exige `build` atualizado e porta 3011 livre. |
| `npm.cmd run check:stock` | Verificar operações de estoque, histórico, idempotência e concorrência em banco descartável; exige `build` atualizado e porta 3012 livre. |
| `npm.cmd run check:stock-tools` | Verificar códigos de barras e transições dos alertas em banco descartável; exige `build` atualizado e porta 3013 livre. |
| `npm.cmd run check:inventory` | Verificar inventários, contagens, ajustes atômicos e concorrência; exige `build` atualizado e porta 3014 livre. |
| `npm.cmd run check:audit` | Verificar consulta, filtros, permissões e privacidade da auditoria; exige `build` atualizado e porta 3015 livre. |
| `npm.cmd run check:transfers-import` | Verificar importação, prévia, confirmação, duplicação e permissões em banco descartável; exige `build` atualizado e porta 3016 livre. |
| `npm.cmd run check:transfers-export` | Verificar prévias, Excel, PDF, filtros e permissões em banco descartável; exige `build` atualizado e porta 3017 livre. |
| `npm.cmd run check:notifications` | Verificar notificações, leitura individual, permissões, avisos e preferências em banco descartável; exige `build` atualizado e porta 3018 livre. |
| `npm.cmd run check:dashboard` | Verificar indicadores, períodos, precisão, evolução histórica e permissões em banco descartável; exige `build` atualizado e porta 3019 livre. |
| `npm.cmd run check:analyses` | Verificar Curva ABC, previsão, precisão, critérios, permissões e exportações em banco descartável; exige `build` atualizado e porta 3020 livre. |
| `npm.cmd run check:recovery` | Verificar rollback, desconexão e backup/restauração reais em dois bancos descartáveis; exige PostgreSQL 17 do Docker local. |
| `npm.cmd run check:transfer-retention` | Verificar quotas, limpeza de prévias e preservação de histórico em banco descartável. |
| `npm.cmd run check:security` | Verificar cifra, concorrência, expiração e retomada da fila de recuperação em banco descartável. |
| `npm.cmd run mail:process` | Processar até dez pedidos persistidos de recuperação; configurar execução periódica na implantação. |
| `npm.cmd run maintenance:transfers` | Limpar conteúdos temporários expirados no desenvolvimento local, preservando metadados e importações concluídas. |
| `npm.cmd run db:up` / `db:down` | Iniciar / parar o PostgreSQL Docker, preservando o volume. |
| `npm.cmd run db:local:up` / `db:local:down` | Iniciar / parar o cluster portátil deste projeto, preservando os dados. |

As verificações exigem dependências instaladas e, quando aplicável, configuração válida e PostgreSQL disponível. A descrição de um comando não representa um registro de execução ou aprovação.

## Próximas etapas

A etapa 11 foi executada no escopo solicitado de **testes funcionais, de segurança e recuperação**; seu [registro de validação](docs/validation-step-11.md) preserva os resultados daquela execução. As correções posteriormente autorizadas tratam leitura HTTP limitada, validação XML, dependências, retenção de prévias, identificação de clientes e recuperação de senha por fila durável. Consulte [as correções de segurança de 07/11/2026](docs/security-hardening-2026-11-07.md) para o estado atual e a configuração operacional. O preparo da demonstração pública não foi executado; publicação e documentação final continuam previstas para a etapa 12.

Leia [a arquitetura](docs/architecture.md), [os ambientes](docs/environments.md), [a validação da etapa 1](docs/validation-step-1.md), [a validação da etapa 2](docs/validation-step-2.md), [a validação da etapa 3](docs/validation-step-3.md), [a validação da etapa 4](docs/validation-step-4.md), [a validação da etapa 5](docs/validation-step-5.md), [a validação da etapa 6](docs/validation-step-6.md), [a validação da etapa 7](docs/validation-step-7.md), [a validação da etapa 8](docs/validation-step-8.md), [a validação da etapa 9](docs/validation-step-9.md), [a validação da etapa 10](docs/validation-step-10.md) e [o diagnóstico do Docker](docs/docker-diagnosis.md).

