# Ambientes e banco de dados

## Atualização de segurança de 07/11/2026

O desenvolvimento possui treze migrations após as correções de retenção e fila de recuperação. Os registros por etapa abaixo preservam o esquema e os resultados da data original. Para os procedimentos atuais, consulte [as correções de segurança](security-hardening-2026-11-07.md).

Em publicação fora da Vercel, configure `REQUEST_IP_HEADER` somente com um cabeçalho substituído por um proxy confiável e impeça acesso direto que contorne esse proxy. Sem política confiável, o ambiente público recusa operações limitadas em vez de compartilhar o bucket de todos os visitantes. O fallback local continua restrito a loopback em desenvolvimento/teste.

A recuperação pública usa fila durável: `after()` processa depois da resposta, e `npm.cmd run mail:process -- --limit=25` retoma até 25 pedidos. Agende esse comando periodicamente na infraestrutura publicada. A fila não substitui SMTP; desenvolvimento/teste continuam com a caixa de mensagens local, e nenhuma credencial de provedor foi alterada nesta atualização.

## Desenvolvimento local

O ambiente atual é de desenvolvimento, com `APP_ENV=development`. A aplicação usa [http://127.0.0.1:3000](http://127.0.0.1:3000), e o serviço PostgreSQL do Docker publica a porta padrão `55432`, configurável por `POSTGRES_PORT`, apenas no endereço local `127.0.0.1`.

O banco padrão é `prevision_dev`, executado com a imagem `postgres:17-alpine`. Um volume Docker preserva os dados entre partidas e paradas do serviço.

Execute `npm.cmd run env:setup` para criar o `.env` local com senhas aleatórias independentes para administração e runtime. O comando não sobrescreve um `.env` existente nem imprime credenciais. Se o arquivo já existir, confira estes campos com `.env.example`:

| Variável | Uso |
| --- | --- |
| `APP_ENV` | Identificação do ambiente da aplicação; nesta etapa, `development`. |
| `DATABASE_ID` | Identidade esperada do banco; no desenvolvimento local, `prevision-local-development`. |
| `POSTGRES_USER` | Usuário administrativo criado pelo PostgreSQL local: `prevision_admin`. |
| `POSTGRES_PASSWORD` | Senha aleatória do usuário administrativo, não versionada. |
| `POSTGRES_APP_PASSWORD` | Senha aleatória independente da role de runtime `prevision_app`. |
| `POSTGRES_DB` | Nome do banco local; configuração padrão `prevision_dev`. |
| `POSTGRES_PORT` | Porta publicada pelo Docker; padrão `55432`. Deve corresponder à porta das URLs. |
| `DATABASE_URL` | Conexão da aplicação em execução, utilizando `prevision_app` e `POSTGRES_APP_PASSWORD`. |
| `DIRECT_URL` | Conexão de migrations e identificação inicial, utilizando `prevision_admin` e `POSTGRES_PASSWORD`. |

No Docker local, as duas URLs apontam para `prevision_dev` em `127.0.0.1:55432` por padrão, com usuários e senhas diferentes. `APP_ENV=development` e `DATABASE_ID=prevision-local-development` identificam essa configuração. Se as URLs forem preenchidas manualmente, caracteres especiais da senha precisam ser codificados corretamente.

Não mantenha senhas fixas no Compose ou no código. O `.env` contém configuração privada e não deve ser versionado. O `.env.example` documenta os campos necessários sem conter segredos reais.

## Rotina de banco

No Windows x64, a alternativa sem Docker é `npm.cmd run db:local:up`. Ela baixa os [binários oficiais EDB](https://www.postgresql.org/download/windows/) do PostgreSQL 17.11-4 e verifica o [SHA-256 publicado pelo fornecedor](https://github.com/EnterpriseDB/edb-installers/issues/706). Executáveis, logs e dados ficam em `.cache/postgres`, ignorado pelo Git. O servidor escuta somente em `127.0.0.1:54329`, usa autenticação SCRAM e não registra serviço no Windows.

Na sequência abaixo, `db:up` inicia o Docker na porta configurada por `POSTGRES_PORT` (padrão `55432`). O cluster portátil usa a porta fixa `54329`: antes de utilizá-lo, pare o Docker, ajuste `DATABASE_URL` e `DIRECT_URL` para essa porta e confirme que ela não está reservada pelo Windows. Os bancos têm armazenamento independente; alternar os comandos não transfere dados nem reconfigura as URLs.

```powershell
npm.cmd run db:up
npm.cmd run db:generate
npm.cmd run db:deploy
npm.cmd run db:identify
npm.cmd run db:check
```

`db:up` inicia somente o serviço, sem executar migrations. `db:generate` gera o cliente Prisma e não altera tabelas. `db:deploy` aplica as migrations já versionadas ao banco indicado pela configuração.

Os comandos `db:migrate`, `db:deploy` e `db:status` estão restritos nesta etapa a `APP_ENV=development`, identidade `prevision-local-development` e URLs de runtime/admin locais para `prevision_dev`, na mesma porta. Uma sentinela existente incompatível interrompe o comando; `db:migrate` também exige uma sentinela já inicializada. O bootstrap inicial com `db:deploy` permite a ausência da tabela/sentinela para preparar um banco novo. Não são aceitos argumentos que substituam URL, schema ou arquivo de configuração; `db:migrate` aceita `--name` e `--create-only`.

No primeiro preparo do banco, execute `db:identify` depois das migrations. O comando registra a sentinela de identificação apenas em banco sem sentinela, com `APP_ENV=development` e conexão local. O registro utiliza `id=primary`, ambiente `development` e `databaseId=prevision-local-development`. Ele não serve para reidentificar um banco existente como outro ambiente.

`db:check` executa `SELECT 1` e compara a sentinela com `APP_ENV` e `DATABASE_ID`, recusando ausência ou divergência. O registro da identidade é separado das migrations para que o mesmo esquema possa ser usado futuramente em ambientes independentes.

Após o preparo e a identificação do banco local, `npm.cmd run check:integration` verifica a integração utilizando fixtures em uma transação revertida ao final. Os dados dessas fixtures não são persistidos. A existência do comando e sua descrição não representam um registro de aprovação da verificação.

Para consultar o estado do banco, use `npm.cmd run db:status`. Para criar uma migration durante o desenvolvimento, use `npm.cmd run db:migrate`; revise a mudança antes de aplicá-la a outro ambiente.

Para encerrar o PostgreSQL local preservando os dados:

```powershell
npm.cmd run db:down
```

Se utilizou o PostgreSQL portátil com as URLs ajustadas para `54329`, pare com `npm.cmd run db:local:down`. O comando verifica a identificação, o diretório de dados, a porta e o processo antes de encerrar o servidor. Nenhuma das alternativas remove os dados.

Alterar as credenciais do `.env` não modifica automaticamente os usuários de um banco que já foi inicializado em um volume. Se houver divergência, confira qual configuração criou o volume e ajuste o acesso de forma controlada. Esta documentação não orienta apagar volumes ou executar resets.

## Demonstração: etapa futura

O ambiente público será separado do desenvolvimento, com aplicação, banco, usuários operacionais e credenciais próprios. A preferência de publicação é Vercel para a aplicação e Supabase para PostgreSQL; a configuração efetiva e seus limites serão verificados na etapa de implantação.

| Recurso | Desenvolvimento | Demonstração planejada |
| --- | --- | --- |
| Aplicação | Execução local | Publicação com endereço HTTPS |
| Banco | `prevision_dev` local | Banco/projeto independente |
| Dados | Desenvolvimento e testes | Somente dados fictícios coerentes |
| Credenciais | Exclusivas do desenvolvimento | Exclusivas da demonstração |
| Acesso da banca | Não previsto | Conta própria com permissões limitadas |
| Google OAuth | Cliente e credenciais próprios | Credenciais e callback próprios |

As variáveis de demonstração não devem ser copiadas para o desenvolvimento. Deploys temporários também não devem receber automaticamente acesso ao banco de demonstração.

No ambiente serverless, a conexão de runtime deverá utilizar o método de pooling recomendado para a combinação efetivamente instalada. Migrations utilizarão a conexão apropriada para operações de esquema, com credenciais restritas ao procedimento de implantação. A aplicação não deverá executar migrations automaticamente a cada requisição ou inicialização.

## Identificação do ambiente e futura restauração

`APP_ENV` expressa a intenção da aplicação, mas isoladamente não comprova qual banco está conectado. A verificação inicial combina `APP_ENV`, `DATABASE_ID` e a sentinela persistida no próprio banco. A demonstração terá identidade e procedimento de provisionamento próprios, ainda não disponíveis.

A restauração dos dados fictícios ainda não faz parte desta etapa. Quando implementada, deverá recusar a execução caso a configuração de demonstração, o identificador esperado ou a sentinela estejam ausentes ou divergentes. Não basta conferir o nome do banco ou confiar apenas em uma variável.

A futura inicialização será reproduzível e não duplicará registros. A restauração deverá atuar exclusivamente na demonstração, ser executada por procedimento administrativo autorizado e preservar o isolamento do desenvolvimento. A conta da banca não receberá acesso a esse procedimento, às credenciais ou à infraestrutura.

Backups e testes de restauração serão definidos na implantação. Eles são diferentes da restauração dos dados fictícios para uma apresentação e precisam ter procedimentos próprios.


## Autenticação e acesso

Execute `npm.cmd run auth:setup` após preparar o `.env`. O comando preserva a configuração existente e acrescenta somente os campos ausentes:

| Variável | Uso |
| --- | --- |
| `AUTH_SECRET` | Chave privada aleatória, com pelo menos 32 caracteres, usada pela autenticação e pelas assinaturas de segurança. |
| `AUTH_URL` | Origem canônica da aplicação; localmente, `http://127.0.0.1:3000`. |
| `MAIL_TRANSPORT` | `local` em desenvolvimento/teste ou `smtp` para envio real. |
| `MAIL_FROM` | Remetente; deve ser válido e autorizado pelo provedor no envio real. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Credenciais do cliente OAuth; ambas precisam estar preenchidas para habilitar o provedor. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD` | Servidor e credenciais de envio SMTP; portas aceitas: 465 ou 587. |

O endereço de acesso deve corresponder a `AUTH_URL`. A aplicação encaminha navegações para essa origem e recusa alterações provenientes de outra origem. HTTP só é permitido em endereço de loopback no desenvolvimento ou teste; os ambientes publicados exigirão HTTPS e cookies seguros.

O primeiro administrador é criado com `npm.cmd run auth:bootstrap`, depois das migrations e da identificação do banco. Em terminal interativo, o comando solicita e-mail, senha e confirmação. A senha não exibe letras nem asteriscos; digite e pressione Enter. Entradas inválidas podem ser corrigidas no próprio cadastro. O comando não cria credenciais padrão nem sobrescreve um administrador existente. Execuções automatizadas podem fornecer `BOOTSTRAP_ADMIN_EMAIL` e `BOOTSTRAP_ADMIN_PASSWORD` no ambiente do processo. Essas variáveis não são necessárias para o runtime da aplicação.

As sessões têm duração absoluta de oito horas e expiram após 30 minutos de inatividade. Um registro no PostgreSQL permite revogá-las mesmo quando o navegador ainda possui o cookie. Logout, redefinição de senha e alterações relevantes de autorização invalidam os acessos anteriores. O runtime consulta o usuário ativo e as permissões atuais no servidor.

### Mensagens locais

Como não há provedor de e-mail configurado neste ambiente, `MAIL_TRANSPORT=local` grava mensagens em `.cache/mail`. Para ler a mensagem mais recente, execute `npm.cmd run mail:read` no seu terminal. Links de ativação e recuperação dão acesso à conta: a pasta é privada, ignorada pelo Git e não possui endpoint HTTP de leitura.

O transporte local é recusado fora de desenvolvimento/teste. Nos testes isolados, as mensagens ficam em `.cache/mail-test`. Nenhuma mensagem desse transporte é enviada pela internet.

### SMTP

Para envio real, preencha no `.env`:

```dotenv
MAIL_TRANSPORT=smtp
MAIL_FROM=Prevision <remetente-autorizado@seu-dominio>
SMTP_HOST=servidor-do-provedor
SMTP_PORT=587
SMTP_USER=usuario-do-provedor
SMTP_PASSWORD=preencher-localmente
```

Na porta 587 o transporte exige STARTTLS; na 465 usa TLS desde a conexão. A verificação de certificado permanece habilitada. O remetente e eventuais requisitos de domínio dependem do provedor escolhido. Reinicie a aplicação após alterar as variáveis.

Não há provedor real configurado nem teste de entrega externa concluído neste ambiente. A caixa local permite validar ativação e recuperação enquanto essa configuração não existe.

### Google OAuth

Configure um cliente OAuth de aplicação web com as credenciais próprias deste ambiente, seguindo a [documentação oficial do Google](https://developers.google.com/identity/protocols/oauth2/web-server). Para o endereço local padrão, o callback é:

```text
http://127.0.0.1:3000/api/auth/callback/google
```

Preencha `GOOGLE_CLIENT_ID` e `GOOGLE_CLIENT_SECRET` no `.env` e reinicie a aplicação. Se mudar a origem em `AUTH_URL`, registre o callback correspondente no provedor. Desenvolvimento e demonstração usarão clientes e segredos separados.

Para importar o JSON baixado de um cliente Web, execute `npm.cmd run auth:google -- "C:\caminho\arquivo.json"`. A importação exige desenvolvimento local, confere o callback, preserva as demais configurações e não exibe credenciais. Ela recusa substituir valores Google já preenchidos por outros diferentes. O arquivo JSON contém o segredo e deve ser mantido privado.

O cadastro deve existir antes do login, estar ativo e ter Google autorizado pelo administrador. A primeira vinculação exige um convite de ativação válido ou uma sessão autenticada com confirmação da senha, quando existente. A identidade Google deve apresentar e-mail verificado correspondente ao cadastro. A aplicação não cria usuários nem vincula contas automaticamente pela coincidência do e-mail. Após a vinculação, o acesso continua sujeito ao estado e às permissões do mesmo usuário.

Sem as duas credenciais, a interface informa que Google está indisponível. Neste ambiente, as credenciais foram importadas e o responsável concluiu com sucesso a vinculação e o login Google, confirmados também pelos registros de acesso no banco. Para vincular outra conta já cadastrada: em **Usuários**, edite a conta e marque **Permitir acesso com Google**. A alteração revoga a sessão atual; entre novamente com senha. Em **Perfil → Sua conta Google**, confirme a senha atual e clique em **Vincular conta Google**, escolhendo o mesmo e-mail do cadastro.

O processo que serve a aplicação precisa acessar HTTPS no Google para descoberta OAuth, troca do código e validação da identidade. Um servidor iniciado pelo agente dentro de um sandbox sem rede falhou na descoberta com `EACCES`; executar no terminal normal do Windows resolve essa restrição sem alterar credenciais ou permissões globais. Nesta sessão, o servidor já foi reiniciado com esse acesso e continua escutando somente em `127.0.0.1:3000`.

Use `http://127.0.0.1:3000` para repetir o vínculo. O redirecionamento de localhost foi corrigido e não deve ser guardado em cache, mas o navegador pode conservar o redirect permanente anterior. Abrir diretamente a origem configurada evita reutilizar essa entrada antiga, preservando os demais cookies.

## Validação da etapa 2

Consulte [o registro da etapa 2](validation-step-2.md) para separar recursos implementados de verificações efetivamente executadas. Testes HTTP de autenticação devem usar banco descartável próprio, com identidade de teste, credenciais efêmeras e limpeza restrita ao recurso criado. Não use dados ou credenciais reais para essas fixtures.

## Atualização e validação da etapa 3

A etapa 3 introduziu a quarta migration, `202610300004_catalog_management`, com versões nos quatro cadastros e índice de unicidade do nome de categoria sem distinção de maiúsculas. A extensão de redefinição administrativa acrescentou `202610310005_admin_password_reset`. A etapa 4 acrescentou `202610310006_stock_control`, com o hash da solicitação e um índice do histórico. A etapa 5 acrescentou `202610310007_stock_alerts`, com alertas persistentes e sincronização transacional. A etapa 6 acrescentou `202610310008_physical_inventory`, com inventários, itens e operações idempotentes. A etapa 7 acrescentou `202611010009_data_transfers`, com prévias e resultados de importação e exportação. A etapa 8 acrescentou `202611010010_notifications_preferences`, com notificações, leituras individuais e aparência da conta. A etapa 9 acrescenta `202611060011_dashboard_history`, com ajustes nos defaults do histórico financeiro e índices para as consultas, totalizando onze migrations versionadas. O desenvolvimento usa PostgreSQL Docker em `127.0.0.1:55432`. Atualize o schema antes de usar os novos recursos:

```powershell
npm.cmd run db:up
npm.cmd run db:generate
npm.cmd run db:deploy
npm.cmd run db:check
```

Depois de alterar o schema ou aplicar uma atualização, encerre o servidor de desenvolvimento com `Ctrl+C` e inicie novamente com `npm.cmd run dev`. A alteração do `.env` também exige reinício. Durante o desenvolvimento, o cache de runtime diferencia os construtores do Prisma gerado, evitando reutilizar um cliente com schema antigo durante a recarga dos módulos. Cada construtor reutiliza seu próprio cliente, inclusive entre os módulos do servidor; conexões ociosas expiram após dez segundos, sem interromper transações em andamento. Produção mantém um único pool por processo e exige novo build e reinício para receber alterações do schema.

O preparo não insere produtos de exemplo nem altera saldos. O cadastro normal de produto cria saldo zero e o histórico inicial de custo/preço na mesma transação. As alterações de cadastro preservam histórico e usam uma versão para detectar edição concorrente. Não há exclusão de cadastros pela API; utilize inativação.

Para repetir as verificações HTTP de catálogo, com a porta `3011` livre:

```powershell
npm.cmd run build
npm.cmd run check:catalog
```

O script exige o ambiente de desenvolvimento local identificado para criar seu próprio banco `prevision_catalog_test_<sufixo aleatório>`. As fixtures usam identidade de teste, credenciais efêmeras e um servidor de produção separado em `127.0.0.1:3011`. A limpeza só remove o banco e o processo criados pela execução, após conferir o marcador do banco. Os cadastros de teste não são gravados em `prevision_dev`. Não execute outro build enquanto o teste estiver usando a compilação.

Os resultados do catálogo e seu roteiro manual estão em [validação da etapa 3](validation-step-3.md). A autenticação Google já validada e as credenciais de runtime do ambiente principal são preservadas; o script isolado não depende de Google ou SMTP reais.

## Validação do controle de estoque

Com o build atualizado, execute `npm.cmd run check:stock` com a porta `3012` livre. Esse script cria seu próprio banco `prevision_stock_test_<sufixo aleatório>`, com sentinela de teste e credenciais efêmeras, e sobe um servidor de produção separado. Entradas, saídas, ajustes, compensações e cenários concorrentes são exercitados somente nesse banco. A limpeza confere o marcador antes de remover os recursos criados. Não gere outro build durante o teste.

O procedimento não cria movimentações no banco principal nem modifica suas senhas ou vínculos Google. Consulte [a validação da etapa 4](validation-step-4.md) para regras, resultados e conferência manual.

## Código de barras e alertas

A etapa 5 não exige novas variáveis de ambiente ou serviços externos. A digitação e leitores USB configurados como teclado utilizam o campo dedicado de código no formulário de movimentação. O código completo é preservado como texto, inclusive os zeros iniciais.

A câmera depende das APIs oferecidas pelo navegador e de contexto seguro, como HTTPS ou o endereço de loopback local. O acesso é solicitado apenas ao clicar em **Ler com câmera**. A política da aplicação permite câmera da própria origem; não é necessário conceder microfone. Negar o acesso ou não possuir suporte mantém a alternativa manual/USB.

A migration de alertas inicializa as condições reais dos produtos existentes, sem inserir produtos ou movimentações. Triggers sincronizam os alertas nas alterações de saldo, mínimo e ativação. O painel mostra condições atuais, sem enviar e-mails. O sino passou a abrir a central de notificações e indicar as não lidas da conta na etapa 8. Configurações SMTP e Google permanecem independentes.

Com build atualizado e porta `3013` livre, `npm.cmd run check:stock-tools` executa as verificações de barcode e alertas em banco próprio `prevision_stock_tools_test_<sufixo aleatório>`, com marcador, identidade de teste e credenciais efêmeras. A limpeza confere o recurso criado antes de removê-lo. Não execute outro build durante o teste. Consulte [a validação da etapa 5](validation-step-5.md), inclusive a conferência física do leitor e da câmera.

## Inventários e auditoria

A etapa 6 não exige novas variáveis de ambiente. A atualização do schema cria as tabelas e proteções dos inventários, sem abrir conferências ou registrar contagens e movimentos. As permissões existentes são reutilizadas: `stock.read` para consultar, `stock.write` para abrir e contar, `stock.adjust` para confirmar e `audit.read` para consultar o histórico de atividades.

Os corpos JSON de inventário aceitam até 64 KiB para acomodar lotes de 20 justificativas de até 600 caracteres com texto Unicode. As outras APIs mantêm o limite padrão de 16 KiB. Essa ampliação não altera CSRF, origem, autenticação, validação de campos ou limites de requisições.

Com build atualizado, `npm.cmd run check:inventory` usa a porta `3014` e banco `prevision_inventory_test_<sufixo aleatório>`; `npm.cmd run check:audit` usa `3015` e `prevision_audit_test_<sufixo aleatório>`. Ambos criam identidades de teste, credenciais efêmeras e marcadores de limpeza. Não execute outro build durante os testes. As fixtures permanecem isoladas e a remoção confere o banco criado pela própria execução.

O histórico de auditoria continua append-only. A consulta apresenta somente os campos permitidos dos snapshots e não disponibiliza rotas de edição ou exclusão. A compatibilidade adicional da câmera permanece adiada, sem mudanças nessa etapa. Consulte [a validação da etapa 6](validation-step-6.md).

## Importação e exportação

A etapa 7 não exige novas variáveis de ambiente ou serviços externos. A migration `202611010009_data_transfers` cria `ProductImport` e `ReportExport` e amplia os eventos de auditoria, sem importar produtos nem gerar relatórios automaticamente. Reinicie a aplicação depois de atualizar o schema e o cliente Prisma.

O processamento ocorre no servidor Node.js. ExcelJS, yauzl e pdfmake estão fixados no `package-lock.json`; as fontes Roboto acompanham o pdfmake e são incluídas no rastreamento do build para a rota de download. Não é necessário baixar fontes em runtime. Consulte [a revisão de dependências](dependency-review-step-7.md), inclusive os avisos que precisam ser reavaliados antes de publicar ou ativar SMTP.

Uploads aceitam CSV ou XLSX de até 2 MiB e 200 produtos; o corpo multipart tem limite de 3 MiB. A estrutura e a expansão ZIP são verificadas antes da leitura da planilha. O arquivo bruto não é salvo. Prévia e resultado ficam privados no banco, com confirmação em até 30 minutos. A importação exige permissões de consulta e escrita do catálogo e não registra entradas de estoque.

Exportações têm até 1.000 registros e snapshot de até 8 MiB. As prévias privadas expiram em 30 minutos e são usadas tanto no Excel quanto no PDF. O download exige novamente `reports.read` e a permissão da fonte. Não há dependência de pasta local para armazenar os arquivos gerados.

Com build atualizado, `npm.cmd run check:transfers-import` usa a porta `3016` e banco `prevision_import_test_<sufixo aleatório>`; `npm.cmd run check:transfers-export` usa `3017` e `prevision_exports_test_<sufixo aleatório>`. Os scripts criam sentinelas de teste, credenciais efêmeras e marcadores para conferir a limpeza dos próprios recursos. Não gere outro build durante os testes. Consulte [a validação da etapa 7](validation-step-7.md) para executar as verificações e conferir os arquivos.

## Notificações e preferências

A etapa 8 reutiliza as dependências existentes e não exige novas variáveis de ambiente ou serviços externos. A migration `202611010010_notifications_preferences` cria `Notification`, `NotificationRead` e `UserPreference`, com proteções de histórico e versão da preferência. Ela inicializa avisos apenas para condições de estoque atualmente abertas, com essa origem indicada no texto; não altera produtos, saldos ou movimentos e não recria eventos antigos como novas atividades.

As notificações automáticas abrangem transições para estoque baixo ou vazio, ajustes e compensações, inventários concluídos e suas divergências agrupadas. São gravadas junto da operação original. Consultas e leituras respeitam as permissões atuais; eventos de estoque e inventário exigem `stock.read`. Avisos administrativos são internos e exigem administrador com `settings.manage` para publicar. Nenhum aviso depende de SMTP.

A aparência é salva por conta nos modos claro, escuro ou conforme o sistema, com detecção de edições concorrentes. O cookie de tema contém somente a opção visual validada para páginas públicas; a sessão e as permissões continuam independentes. As páginas autenticadas usam a preferência persistida da conta, inclusive em outros dispositivos.

Com o build atualizado e a porta `3018` livre, execute `npm.cmd run check:notifications`. A integração cria banco e servidor descartáveis, com identidade de teste, credenciais efêmeras e marcador para limpar somente os próprios recursos. Não gere outro build durante a execução. Consulte [a validação da etapa 8](validation-step-8.md) para as verificações de notificações e preferências e o roteiro de conferência visual.

## Dashboard e indicadores

A etapa 9 reutiliza as dependências e credenciais existentes, sem novas variáveis de ambiente ou serviços externos. Antes de utilizar o dashboard, aplique `202611060011_dashboard_history` com `npm.cmd run db:deploy`, gere o cliente Prisma e reinicie a aplicação. A migration altera somente os defaults de horário para novas linhas do histórico de valores e acrescenta índices; não reescreve históricos nem modifica produtos, saldos ou movimentos.

A visão geral e `/api/dashboard` exigem `reports.read` e `stock.read`. O período aceita até 366 dias no calendário de `America/Sao_Paulo`, com padrão dos últimos 30 dias e sem datas futuras. O fuso dos filtros é explícito e não depende do fuso do navegador ou da máquina que executa o servidor.

Os valores atuais incluem produtos inativos; as contagens de estoque baixo e vazio consideram somente ativos. Movimentos do período usam a data da operação e valores históricos brutos, com ajustes e compensações separados. A evolução usa os horários de registro e custos históricos armazenados; inconsistências impedem apresentar um valor estimado sem base. Quantidades permanecem agrupadas pela unidade atual do produto. A Curva ABC e a previsão de reposição são descritas na etapa 10 abaixo.

Com o build atualizado e a porta `3019` livre, execute `npm.cmd run check:dashboard`. O script utiliza banco `prevision_dashboard_test_<sufixo aleatório>` e servidor descartáveis, com sentinela de teste, credenciais efêmeras e marcador para restringir a limpeza aos recursos criados. Não gere outro build durante o teste. Consulte [a validação da etapa 9](validation-step-9.md) para os critérios e o roteiro de conferência dos indicadores.

## Curva ABC e previsão de reposição

A etapa 10 usa os dados e dependências já existentes, sem nova migration, credencial ou serviço externo. O schema permanece com onze migrations. `/analises` e `/api/analyses` exigem `reports.read` e `stock.read`, com revalidação no servidor. Não há envio de mensagens externas ou criação automática de pedidos.

O período padrão são os últimos 90 dias; o limite é 366 dias em `America/Sao_Paulo`, sem datas futuras. Pesquisa, situação, limites A/B e horizonte definem somente a consulta. A análise recusa mais de 1.000 produtos em vez de classificar um subconjunto. As exportações `abc`, `replenishment` e `indicators` usam as mesmas prévias privadas, limites, validade e permissões de Excel/PDF.

A Curva ABC usa o custo histórico líquido de saídas, com compensações pela própria data, limite zero para líquidos negativos e agrupamento de empates na classificação. A previsão exige 30 dias observados e consumo positivo em dois dias; considera saldo, mínimo e segurança atuais e o prazo do produto ou, se ausente, do fornecedor. Zero é um prazo válido. Mudanças de unidade, inativação e histórico insuficiente impedem estimar; ausência de prazo impede sugerir compra. Datas são estimativas a partir do dia atual, com limite de 3.650 dias para apresentação.

Para uma demonstração futura, os dados fictícios devem possuir datas de cadastro e movimentações coerentes com a janela observada; criar produtos hoje com saídas antigas não comprova 30 dias de histórico. A preparação do ambiente de demonstração e sua validação pertencem à etapa 11, e a publicação à etapa 12. Os bancos continuam separados.

Com build atualizado e a porta `3020` livre, execute `npm.cmd run check:analyses`. O script usa banco `prevision_analyses_test_<sufixo aleatório>` e servidor descartáveis, com sentinela de teste, credenciais efêmeras e marcador para limitar a limpeza aos próprios recursos. Não gere outro build durante a integração. Consulte [a validação da etapa 10](validation-step-10.md) para fórmulas, limites e roteiro de conferência.

