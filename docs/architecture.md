# Arquitetura do PREVISION

## Correções de segurança de 07/11/2026

Corpos HTTP são lidos incrementalmente com teto e prazo, e o validador XML utiliza scanner linear. A recuperação pública persiste uma solicitação cifrada antes da resposta e processa a elegibilidade e o envio por worker; `after()` acelera o trabalho e o comando `mail:process` recupera pedidos persistidos após interrupções. A aplicação pública exige identificação do cliente por ingresso confiável para os limites de frequência.

Prévias temporárias possuem quotas atômicas e limpeza limitada de payloads expirados, com metadados e importações concluídas preservados. As migrations 12 e 13 implementam essas garantias e a fila privada de recuperação. O SMTP usa Nodemailer corrigido por alias independente do peer opcional não utilizado do Auth.js. Consulte [o registro completo das correções](security-hardening-2026-11-07.md), incluindo limites operacionais e validação.

## Decisão inicial

O PREVISION adota uma aplicação modular em um único repositório. O Next.js atende a interface React e as entradas HTTP do backend. A separação entre frontend e backend é feita por responsabilidades, contratos e limites de importação; nesta etapa, não exige dois serviços publicados separadamente.

TypeScript fornece os contratos de dados, Tailwind CSS organiza a apresentação e Prisma acessa o PostgreSQL. O runtime de servidor é Node.js, utilizado também na autenticação e no processamento de arquivos de importação e exportação.

## Responsabilidades

| Camada | Responsabilidade |
| --- | --- |
| Interface | Páginas, formulários, tabelas, navegação e apresentação dos resultados. |
| Componentes compartilhados | Elementos reutilizáveis sem regras específicas de estoque. |
| Entradas do backend | Receber requisições, validar o contrato de entrada, identificar o usuário e converter o resultado em resposta. |
| Serviços de aplicação | Executar os casos de uso, verificar permissões e coordenar transações. |
| Domínio | Expressar regras e cálculos independentes da interface e do transporte HTTP. |
| Repositórios | Consultar e persistir os dados, sem expor detalhes do Prisma à interface. |
| Infraestrutura | Conexão com o banco e integrações externas. |

O fluxo previsto é:

```text
Interface → entrada HTTP → serviço de aplicação → repositório → PostgreSQL
                              ↓
                         regras de domínio
```

As entradas HTTP e a interface não devem duplicar as regras dos serviços. A validação de formulário melhora a experiência, mas o servidor continua responsável por validar e autorizar cada operação.

Módulos que acessam banco, credenciais ou integrações devem ser exclusivos do servidor, com `server-only` onde aplicável. Componentes executados no navegador recebem apenas os dados necessários à tela. Os nomes das variáveis de ambiente não tornam uma credencial pública: segredos nunca devem usar o prefixo `NEXT_PUBLIC_`.

## Organização dos módulos

Os módulos de negócio serão organizados por assunto: identidade e acesso, catálogo, estoque, inventário, auditoria, notificações, importações, relatórios e análises. Cada módulo poderá conter seus contratos, validações, regras, serviços e repositórios conforme a necessidade real surgir.

A estrutura deve distinguir o roteamento do Next.js, componentes compartilhados, módulos de negócio, infraestrutura de servidor, schema/migrations Prisma, scripts operacionais, testes e documentação. Não é necessário preencher todos os módulos com implementações vazias na fundação.

## Modelo de dados

O schema Prisma evolui por migrations. As entidades abaixo descrevem a estrutura atual; cada fluxo operacional é introduzido e validado em sua etapa.

| Entidade ou grupo | Relações e finalidade |
| --- | --- |
| `User`, `Role`, `Permission` e `RolePermission` | Cada usuário tem um perfil; a relação entre perfis e permissões define as ações autorizadas. Os códigos iniciais de perfil são administrador, gerente e operador. |
| `Account` | Vincula uma identidade de provedor externo a um usuário, preservando os nomes de campos esperados pelo adaptador Auth.js. A vinculação Google explícita pertence à etapa 2. |
| `LoginSession` | Registro de expiração, inatividade e revogação das sessões JWT. Não é o modelo de sessão de banco do Auth.js e não armazena o cookie bruto. |
| `AccessToken` | Representação segura de tokens de definição ou recuperação de senha, com finalidade, expiração, uso e revogação. Não corresponde a um token de autenticação do navegador. |
| `Category` | Agrupa produtos, preservando referências históricas. |
| `Supplier` | Pode ser fornecedor padrão de vários produtos, participar das entradas e ter um prazo de reposição cadastrado. |
| `Customer` | Pode ser associado às saídas quando aplicável. |
| `Product` | Possui SKU único, código de barras opcional único, unidade, categoria, fornecedor padrão, parâmetros de estoque e valores comerciais. |
| `StockBalance` | Mantém no máximo um saldo por produto, com versão para apoiar o controle de concorrência. O cadastro de produto cria também seu saldo zero na mesma transação. |
| `StockMovement` | Representa uma operação confirmada, com variação de quantidade, saldos anterior e posterior, valores históricos, responsável, identificação da operação e chave de idempotência. Compensações referenciam a movimentação original. |
| `StockAlert` | Uma linha por produto, com condição sem estoque ou estoque baixo, datas da transição e resolução. Os triggers sincronizam a linha na transação que altera o saldo ou os parâmetros do produto. |
| `Inventory`, `InventoryItem` e `InventoryOperation` | Guardam abertura, responsáveis, snapshots dos produtos, referência do saldo, contagens, ajustes vinculados e requisições idempotentes. Inventários encerrados e suas operações ficam protegidos contra alteração. |
| `ProductValueHistory` | Registra alterações de custo de aquisição ou preço de venda e o usuário responsável, sem substituir os valores históricos das movimentações. |
| `AuditEvent` | Identifica responsável quando disponível, ação, módulo, registro afetado e alterações relevantes. |
| `ProductImport` | Guarda a prévia privada dos dados reconhecidos, erros, validade e resultado da confirmação. A conclusão é protegida contra repetição; o arquivo bruto não é persistido. |
| `ReportExport` | Guarda o conjunto de dados de uma prévia privada e imutável, com responsável, filtros e validade para downloads em Excel ou PDF. |
| `Notification` e `NotificationRead` | Eventos imutáveis do ambiente e primeira leitura por usuário. A permissão exigida pela origem filtra histórico, pesquisa, contador e marcação. |
| `UserPreference` | Preferência de aparência da conta, com versão para detectar edições concorrentes. |
| `EnvironmentSentinel` | Identifica o banco conectado por uma única sentinela operacional, separadamente das tabelas de negócio. |

O schema atual possui onze migrations, incluindo `202611060011_dashboard_history`. A última ajusta os horários de inserção do histórico de valores e acrescenta índices para a reconstrução do dashboard, sem reescrever registros antigos. As notificações preservam acontecimentos históricos e leituras individuais; `StockAlert` continua representando a condição atual de cada produto. A aparência possui persistência por conta. Outras configurações serão introduzidas junto dos respectivos casos de uso.

A quantidade exibida em um produto é alterada exclusivamente pelos casos de uso de estoque. O schema usa decimais com quatro casas para quantidades e valores unitários, duas casas para totais monetários e datas PostgreSQL com fuso horário. O servidor calcula quantidades e totais por inteiros escalados, arredondando valores monetários pela regra de meio centavo para cima e recusando overflow antes de gravar.

## Regras de integridade

- SKU e código de barras informado têm unicidade garantida também no banco. Os cadastros são inativados, preservando identidade e referências.
- Entrada, saída, ajuste e compensação registram evento, saldo e auditoria de forma atômica. Saídas concorrentes não podem produzir saldo negativo.
- Movimentações confirmadas não são apagadas ou reescritas. A correção gera uma compensação vinculada à original.
- A operação armazena os custos e preços praticados; relatórios históricos não devem usar o preço atual como substituto.
- Ajustes exigem justificativa. A confirmação de inventário registra movimentações e auditoria e recusa referências de saldo desatualizadas durante a contagem.
- Repetir uma solicitação de estoque com a mesma chave, ator e conteúdo não duplica seus efeitos; reutilizar a chave com outro conteúdo gera conflito.
- Toda consulta e alteração protegida verifica o usuário ativo e suas permissões no servidor, inclusive em exportações.
- Importar o cadastro de produtos cria saldo zero. Qualquer entrada de estoque exige uma operação explícita e validada.

As operações de estoque pertencem à etapa 4; inventário e consulta de auditoria, à etapa 6; importação e exportação, à etapa 7; notificações e preferências, à etapa 8; dashboard e indicadores, à etapa 9; Curva ABC e previsão de reposição, à etapa 10. A autenticação e a autorização dos fluxos de acesso e usuários são implementadas na etapa 2, descrita abaixo.

## Análises avançadas na etapa 10

`src/server/analyses` atende `/api/analyses`; `/analises` apresenta a Curva ABC, a previsão, os critérios e os gráficos. A consulta exige `reports.read` e `stock.read`, revalidados após os locks compartilhados de autorização e catálogo. Uma consulta parametrizada reúne a coorte completa e suas estatísticas no mesmo snapshot; cálculos financeiros e razões usam inteiros escalados, preservando strings decimais nos contratos. O frontend apresenta os resultados e aproxima somente as proporções dos desenhos.

Os filtros incluem período de até 366 dias em `America/Sao_Paulo`, pesquisa e situação, limites A/B e horizonte. São critérios da consulta, sem alterar configurações globais. Acima de 1.000 produtos, a análise é recusada para evitar classificar uma amostra com denominador incompleto. Não há novas dependências ou migrations: permanecem onze, e saldo, segurança e prazos já existem no schema.

A ABC soma os totais históricos de saídas e subtrai compensações cujo original é uma saída, pela data da própria compensação. Quantidades e valores negativos são limitados a zero e identificados. A classificação compara valores exatos com o acumulado antes do grupo de mesmo valor; o grupo que atravessa o limite fica na classe em que começou. Valores financeiros iguais recebem a mesma classe, e custo líquido zero fica sem classe. Percentuais exibidos são arredondados; limites padrão de 80% e 95% são aproximados e configuráveis.

A previsão calcula dias observados a partir do maior entre início do período e data de cadastro. Exige 30 dias e consumo líquido positivo em dois dias distintos. Média diária é consumo líquido dividido pelos dias, incluindo dias sem consumo; cobertura é saldo atual dividido pela média. O prazo do produto prevalece, inclusive zero; ausente, utiliza o fornecedor padrão. Ponto de reposição é o maior entre mínimo e segurança mais média vezes prazo. O alvo inclui também o horizonte; a recomendação é a diferença positiva entre alvo e saldo, arredondada para cima em quatro casas.

As datas usam o saldo atual e o dia da consulta em São Paulo, com limite de 3.650 dias para apresentar uma data. Inativos, mudança de unidade e insuficiência de histórico impedem previsão; ausência de prazo impede sugestão de compra e data de reposição. A detecção de mudança de unidade consulta apenas os campos operacionais necessários da auditoria, sem expor os snapshots. As estimativas não garantem consumo futuro e não criam pedidos.

Os relatórios `abc`, `replenishment` e `indicators` reutilizam a prévia privada de exportação, com critérios, resultados, validade e verificação de permissões no download. Indicadores e análises são exportados em Excel/PDF com a mesma precisão textual dos relatórios existentes. Consulte [a validação da etapa 10](validation-step-10.md).

## Dashboard e indicadores na etapa 9

`src/server/dashboard` atende `/api/dashboard` e a visão geral apresenta os indicadores e gráficos. A consulta exige `reports.read` e `stock.read`. Uma transação `ReadCommitted` adquire os locks compartilhados de autorização e catálogo na mesma ordem das escritas e revalida a sessão e as permissões após a espera. Uma única instrução SQL agrega as fontes, mantendo um snapshot coerente também diante de manutenção administrativa que não utilize os locks da aplicação. Não há gravação de estado de negócio na consulta.

O contrato aceita `from` e `to` como datas de calendário, ambas informadas ou ambas ausentes. O padrão são os últimos 30 dias; o limite é 366 dias, sem datas futuras, no fuso `America/Sao_Paulo`. Até 31 dias, os fechamentos são diários; períodos maiores são agrupados por mês e limitados às datas selecionadas. A série inclui intervalos sem movimentos.

Os indicadores atuais usam todos os produtos, inclusive inativos, com estoque baixo e vazio restritos aos ativos. Estimativas financeiras usam quantidade e valores atuais, com arredondamento de cada produto antes da soma. Os movimentos do período usam `occurred_at` e os totais históricos persistidos: entradas e saídas brutas, ajustes e compensações separados. As quantidades são agrupadas pela unidade atual do cadastro; o ranking de mais movimentados usa a contagem de entradas e saídas, evitando comparar volumes de unidades diferentes.

A evolução financeira reconstrói o saldo por `StockMovement.createdAt` e seleciona o custo em `ProductValueHistory` cujos horários de vigência e registro antecedem o fechamento. Não utiliza o custo atual como substituto do passado. A data de operação retroativa não antecipa o registro do movimento. Produto com saldo positivo sem custo histórico, saldo incompatível com o ledger, valores históricos ambíguos ou saldo histórico negativo impedem a apresentação dos indicadores até a conferência dos dados.

A migration `202611060011_dashboard_history` usa `clock_timestamp()` nos defaults de `effective_at` e `created_at` de `ProductValueHistory`, para que novas linhas recebam o horário da inserção após os locks, em vez do início da transação. Acrescenta índices em `(product_id, created_at)` dos movimentos e na linha temporal dos valores. O histórico antigo permanece imutável; a reconstrução explica a limitação de horários antigos empatados. Consultas usam PostgreSQL `NUMERIC` e retornam strings decimais exatas; SVG e tabelas apresentam esses resultados sem recalcular as regras de negócio. Consulte [a validação da etapa 9](validation-step-9.md).

## Notificações e preferências na etapa 8

`src/server/notifications` atende `/api/notifications`, com consultas paginadas, resumo de não lidas, marcação individual ou geral e publicação administrativa. `/notificacoes` reúne os filtros e o histórico. Leituras são imutáveis e possuem chave composta por evento e usuário; repetir a marcação preserva a primeira data. A marcação geral usa o horário da consulta como corte, evitando marcar avisos recebidos depois.

Triggers registram notificações na transação que altera a condição de estoque, confirma um ajuste ou compensação ou conclui um inventário. Divergências de inventário são agrupadas e seus ajustes internos não geram um aviso por item. Chaves de evento e verificação de transições evitam duplicação; um rollback desfaz os avisos da operação. A migration inicializa somente condições de estoque abertas, sem apresentar movimentações e inventários antigos como novas atividades.

Consultas, pesquisa, contadores e marcações revalidam a sessão e as permissões dentro da transação, sob o lock de autorização. Eventos de estoque e inventário exigem `stock.read`; avisos administrativos ficam disponíveis aos usuários autenticados. Publicar exige perfil administrador e `settings.manage`, com chave idempotente e auditoria de metadados. O navegador preserva um pedido incerto na mesma aba, por usuário, para conferir a publicação sem trocar a chave.

`src/server/preferences` atende `/api/preferences` e mantém a aparência em `UserPreference`, com atualização versionada e acesso restrito à conta da sessão. `/configuracoes` oferece os modos claro, escuro e conforme o sistema. As páginas autenticadas recebem a preferência da conta no servidor; um cookie visual validado auxilia as páginas públicas, sem participar da autorização. CSS acompanha a preferência do dispositivo no modo conforme o sistema. Consulte [a validação da etapa 8](validation-step-8.md).

## Importação e exportação na etapa 7

`src/server/transfers` concentra parsing, validação, persistência de prévias e renderização dos arquivos. `/transferencias` apresenta os fluxos e `/api/transfers` verifica sessão, permissões e propriedade de cada prévia. Escritas exigem CSRF e origem válida. Importações requerem `catalog.read` e `catalog.write`; relatórios requerem `reports.read` e a consulta da fonte correspondente, inclusive no download.

A importação aceita CSV UTF-8 ou XLSX de até 2 MiB e 200 produtos. A leitura do upload é limitada antes da interpretação. O XLSX passa por verificação ZIP de integridade, tamanho expandido, referências e estrutura antes de ser reconstruído e entregue ao ExcelJS. Macros, vínculos externos, entidades XML e fórmulas não são aceitos. Categorias e fornecedores são referências existentes; não há criação automática nem atualização de produtos existentes.

`ProductImport` guarda por usuário a prévia dos dados reconhecidos, com validade de 30 minutos. A confirmação revalida autorização, referências e unicidade sob os locks de autorização e catálogo. O mesmo caso de uso de criação manual registra produto, saldo zero, valores iniciais e auditoria na transação do lote. A chave de confirmação e o hash normalizado do conteúdo evitam repetir efeitos; uma resposta incerta deve ser conferida com a mesma solicitação.

A exportação consulta os dados em `RepeatableRead` e grava um snapshot de até 1.000 registros e 8 MiB em `ReportExport`, válido por 30 minutos. O download usa esse conjunto sem reler a fonte e revalida as permissões atuais. ExcelJS gera células de texto para preservar códigos, decimais e conteúdo iniciado por caracteres de fórmula. Pdfmake gera o PDF com fontes Roboto locais, sem acesso a URLs ou arquivos arbitrários. Um limite de dois processamentos pesados por processo protege os recursos durante parsing de XLSX e geração dos arquivos; ele não armazena estado de negócio nem substitui o controle persistente de requisições.

Auditoria exportada passa pela mesma allowlist da consulta. Os estados anteriores e registrados são apresentados com rótulos legíveis, avisos de omissão e limitação e, no PDF, seções na largura do registro. Prévias e downloads registram metadados na auditoria, sem incluir o conteúdo do arquivo no evento.

Os procedimentos e limites estão em [validação da etapa 7](validation-step-7.md); os pacotes fixados e seus avisos conhecidos estão na [revisão de dependências](dependency-review-step-7.md).

## Controle de estoque na etapa 4

`src/server/stock` concentra validação, cálculos e casos de uso. As APIs em `/api/stock` expõem saldos, opções de parceiros, detalhes de produtos, histórico e operações. A interface em `/estoque` recebe apenas DTOs serializáveis, com quantidades e dinheiro como strings decimais, sem importar Prisma ou configurações privadas.

Uma transação `ReadCommitted` adquire primeiro o lock de autorização e depois o lock de cadastros. A autorização é revalidada após a espera; produto e parceiros são verificados no estado atual. O saldo é bloqueado com `FOR UPDATE`, atualizado junto do movimento e da auditoria e recebe uma nova versão. Essa ordem também é utilizada pelos serviços de cadastros e evita alterações simultâneas de status ou valores durante o snapshot financeiro. Os locks compartilhados serializam as escritas, uma escolha inicial adequada ao estoque único e ao volume deste projeto.

`StockMovement.requestHash` guarda o SHA-256 do contrato normalizado, ator e operação. A chave de idempotência é única no banco. Repetições autorizadas e idênticas devolvem o registro existente; reutilizações incompatíveis retornam conflito. Replays não criam auditoria ou alteração adicional de saldo. A interface conserva a mesma chave e conteúdo quando a resposta é incerta.

Entrada exige custo e fornecedor. Saída exige preço, com cliente opcional; seu custo é o custo atual do cadastro no momento da gravação. Ajustes usam esse custo e exigem justificativa. Os valores do cadastro não são alterados automaticamente pelas movimentações. Os totais apresentados em saldos usam valores atuais e são estimativas, enquanto detalhes de movimentos usam valores históricos.

Uma compensação exige `stock.adjust`, justificativa e uma original ainda não compensada. A quantidade é exatamente inversa; custos, preços e parceiros são preservados, inclusive com referências inativas. Não se compensa uma compensação e nenhuma inversão pode produzir saldo negativo. O registro original permanece protegido pelos privilégios e triggers de imutabilidade do PostgreSQL.

## Execução e validação

Na etapa 6, `/inventarios` e `/api/inventories` tratam abertura, contagens em lote, atualização explícita de referência, confirmação e cancelamento. A referência preserva quantidade e versão de saldo; uma diferença de versão bloqueia confirmação mesmo quando a quantidade voltou ao valor anterior. Atualizar a referência apaga a contagem do item para exigir nova conferência física. A mudança de unidade bloqueia o uso do snapshot antigo.

As alterações do inventário seguem a mesma ordem de locks de autorização e catálogo do estoque, com bloqueio adicional do inventário e dos saldos envolvidos. A confirmação valida todos os itens e limites antes de aplicar os planos. Cada divergência cria um ajuste e vínculo com o item; saldo, histórico, alertas, auditoria e conclusão são atômicos. Um único identificador de operação correlaciona os ajustes e a conclusão. As requisições possuem registro append-only em `InventoryOperation` para impedir repetição dos efeitos.

`/auditoria` e `/api/audit` disponibilizam somente consulta, sob `audit.read`. Snapshots passam por allowlist de campos, proteção de credenciais e limites de profundidade e tamanho, com indicação de omissão ou truncamento. A consulta não substitui os dados históricos do banco e não oferece mutações. Os triggers append-only existentes continuam protegendo `AuditEvent`.

Na etapa 5, `/api/stock/barcode` pesquisa por igualdade no código de barras único e retorna o DTO de produto com saldo. A consulta exige `stock.read`, preserva zeros e diferencia maiúsculas e minúsculas. A interface usa um campo dedicado para teclado/USB e oferece `BarcodeDetector` nativo quando suportado. Câmera, tracks de mídia e timers têm ciclo de vida limitado à ação explícita de leitura; imagens não são enviadas a terceiros.

`StockAlert` é uma projeção das condições atuais dos produtos ativos. A migration `202610310007_stock_alerts` cria os triggers de produto e saldo e inicializa as condições existentes. A sincronização possui lock por produto, preserva os timestamps quando não há transição, resolve acima do mínimo ou ao inativar e reabre a mesma linha se necessário. Alterações em movimentos, compensações e mínimo ficam consistentes com o alerta na mesma transação. `/api/stock/alerts` e `/summary` exigem `stock.read`; o resumo é global e a lista possui filtros e paginação.

O painel de alertas consulta o servidor a cada 30 segundos quando visível, ao recuperar o foco e após eventos locais de alteração, representando as condições atuais do estoque. O sino e a central seguem o mesmo ciclo de atualização para o histórico e a contagem individual de notificações não lidas.

A aplicação será preparada para execução serverless, utilizando conexão compartilhada adequadamente configurada e sem depender de memória local para sessões, limites de requisições ou processamento persistente.

As migrations serão versionadas e não fixarão a identidade do ambiente de demonstração ou desenvolvimento. O registro inicial da sentinela é um procedimento separado. A aplicação usará uma credencial de runtime; a execução de migrations poderá utilizar uma conexão e permissões próprias. Alterações futuras deverão incluir testes proporcionais ao risco, especialmente para concorrência, autorização, cálculos históricos e isolamento entre ambientes.


## Identidade e acesso na etapa 2

A autenticação usa Auth.js com credenciais e Google. Senhas são processadas no servidor com scrypt, sal aleatório e parâmetros versionados; o banco armazena somente o hash. A senha aceita de 12 a 128 caracteres, sem remover espaços automaticamente.

O cookie de autenticação é HttpOnly, SameSite=Lax e Secure quando a origem usa HTTPS. O token de sessão contém a referência ao registro `LoginSession` e a versão de sessão do usuário. Cada acesso protegido consulta esse registro, verifica expiração, revogação, inatividade e usuário ativo, e obtém as permissões atuais. A duração absoluta é de oito horas, com limite de 30 minutos de inatividade.

As páginas autenticadas ficam no grupo `src/app/(protected)`; as APIs fazem sua própria autenticação e autorização. Esconder uma ação na interface não concede proteção à operação. Os serviços de usuários revalidam o ator dentro da transação, protegem o último administrador utilizável e registram alterações na auditoria.

### Perfis e permissões

O bootstrap cria três perfis e suas permissões iniciais:

| Perfil | Permissões iniciais |
| --- | --- |
| Administrador | Todas as permissões declaradas, incluindo gerenciar usuários, atribuir perfis e administrar configurações. |
| Gerente | Consultar usuários e auditoria; consultar e alterar catálogo e estoque; realizar ajustes; consultar relatórios. |
| Operador | Consultar e alterar catálogo e estoque; consultar relatórios. |

Consultas de estoque exigem `stock.read`; entradas e saídas, `stock.write`; ajustes e compensações, `stock.adjust`. A atribuição de perfis exige `roles.manage`, enquanto a administração de usuários exige `users.manage`. O gerenciamento atual altera o perfil do usuário; não oferece um editor de permissões personalizadas.

### Ativação, recuperação e Google

`AccessToken` armazena o hash de tokens aleatórios, sua finalidade, expiração, uso e revogação. Convites de ativação duram 24 horas; recuperação de senha, 30 minutos; autorizações temporárias de vinculação Google, até dez minutos. A confirmação é transacional e de uso único. Redefinir a senha também invalida sessões e outros tokens pendentes.

Não existe cadastro público. O administrador cadastra o usuário e envia um convite. A recuperação responde de forma genérica para e-mails elegíveis ou desconhecidos. Contas que usam exclusivamente Google recuperam o acesso pelo próprio provedor.

A redefinição administrativa usa a finalidade separada `ADMIN_PASSWORD_RESET`, disponível somente ao perfil `ADMINISTRATOR` com `users.manage`. O papel e a sessão atuais são revalidados após adquirir o lock de autorização, antes de emitir o link de 30 minutos. Essa autorização explícita permite escolher uma senha também para contas sem senha ou inativas, preservando o estado de ativação e a identidade Google. A recuperação pública continua limitada a contas ativas com senha. A conclusão altera o hash, incrementa a versão de sessão e revoga sessões e tokens anteriores na mesma transação. Solicitação e conclusão são auditadas sem registrar tokens ou senhas. Veja [o fluxo administrativo](admin-password-reset.md).

A integração Google exige usuário previamente cadastrado e ativo, autorização individual, e-mail verificado e vinculação explícita. Um convite de ativação ou a confirmação da senha atual autoriza a primeira vinculação. A configuração do adaptador bloqueia a criação automática de usuários e a vinculação implícita de contas. A tabela `Account` identifica o vínculo; a aplicação não precisa armazenar tokens de acesso ou atualização do Google para esse caso de uso.

A entrega de links é isolada em `src/server/mail`. O transporte local grava arquivos privados no cache somente em desenvolvimento/teste; SMTP permite envio real após configuração. Nenhuma leitura dessa caixa é exposta por HTTP.

### Proteções HTTP

O proxy estabelece a origem canônica, aplica CSP com nonce por requisição e emite o cookie de proteção CSRF. As operações JSON verificam origem, tipo e tamanho do corpo e o token CSRF assinado, vinculado à sessão. Os endpoints próprios do Auth.js mantêm o protocolo CSRF da biblioteca e os controles adicionais de origem.

No Next instalado, redirects de proxy entre localhost e o IP de loopback podem ser convertidos em endereços relativos ao bind do servidor. GET/HEAD em host alternativo são reescritos para uma rota interna que emite o redirect absoluto. A rota constrói o destino com a origem fixa de `AUTH_URL`, atribuindo caminho e consulta separadamente; não aceita trocar o host. O proxy sobrescreve o cabeçalho interno, rejeita acesso direto à rota e mantém a recusa de mutações em host diferente. `skipProxyUrlNormalize` preserva a origem esperada pelo fluxo OAuth.

`RateLimitBucket` mantém contadores compartilhados no PostgreSQL por operação e janela de tempo. As chaves usam HMAC para não persistir e-mails ou identificadores de origem em texto claro. O limite é atualizado atomicamente; falhas no armazenamento não liberam a operação. Fora da infraestrutura explicitamente reconhecida, o código não confia em cabeçalhos arbitrários de IP encaminhado.

Dados enviados à interface usam contratos públicos que excluem hash de senha, segredos, tokens e identificadores internos de sessão. Logs e respostas de erro não devem revelar esses valores.

## Limites atuais

O envio SMTP depende de configuração externa ainda ausente. O login Google real está configurado e validado no desenvolvimento local. As etapas possuem documentação própria, incluindo [acesso](validation-step-2.md), [estoque](validation-step-4.md), [notificações e preferências](validation-step-8.md) e [dashboard e indicadores](validation-step-9.md); os registros distinguem implementação de verificações executadas. Curva ABC e previsão de reposição pertencem à etapa 10; a ampliação da compatibilidade da câmera continua adiada.

## Catálogo na etapa 3

Os serviços em `src/server/catalog` concentram validação, autorização, consultas Prisma/SQL parametrizado e transações dos cadastros. As rotas HTTP compartilham adaptação em `src/server/http/catalog-routes.ts`, sem duplicar as regras nos componentes. Os contratos públicos em `src/lib/catalog/types.ts` usam datas e decimais em strings, sem transportar objetos Prisma para o navegador. A interface usa páginas protegidas, listas consultadas no servidor, formulários em diálogos e componentes compartilhados em `src/components/catalog`.

### Entradas HTTP e consultas

| Entrada | Operações |
| --- | --- |
| `/api/catalog/products`, `/api/catalog/categories`, `/api/catalog/suppliers` e `/api/catalog/customers` | `GET` para lista e `POST` para cadastro. |
| `/api/catalog/{tipo}/{id}` | `GET` para detalhe e `PATCH` para edição, ativação ou inativação. |
| `/api/catalog/products/{id}/values` | `GET` para histórico paginado de custo e preço. |
| `/api/catalog/options` | `GET` para categorias e fornecedores ativos e inativos, com sua situação. |

Listas e históricos retornam `items`, `total`, `page`, `pageSize` e `totalPages`. As listas aceitam pesquisa, situação ativa/inativa/todas e paginação; produtos também aceitam categoria, fornecedor e situação do estoque. As comparações de saldo e mínimo são executadas no PostgreSQL. Estoque vazio é quantidade zero; estoque baixo é quantidade positiva menor ou igual ao mínimo; normal é quantidade acima do mínimo. A etapa não produz alertas nem movimenta essas quantidades.

Consultas exigem `catalog.read`, e alterações exigem `catalog.write`. As APIs verificam identidade, origem, CSRF e limites compartilhados; os serviços verificam a permissão novamente. As consultas paginadas usam uma transação de leitura consistente para manter contagem e página no mesmo snapshot. Campos de ordenação e nomes de tabelas são constantes do serviço, e a pesquisa é parametrizada com caracteres de `LIKE` tratados como texto.

### Integridade das alterações

A migration `202610300004_catalog_management` adiciona `version` não negativa a `Category`, `Supplier`, `Customer` e `Product`, além do índice de categoria por `lower(btrim(name))`. A API exige `expectedVersion` em cada edição e incrementa a versão no mesmo comando que altera o registro. Uma versão desatualizada gera conflito HTTP 409, permitindo ao usuário recarregar o cadastro antes de tentar novamente.

As escritas adquirem o lock de autorização antes do lock de catálogo e revalidam a sessão e a permissão do ator dentro da transação. Em `ReadCommitted`, cada consulta obtém um novo snapshot, conforme a [documentação do PostgreSQL 17](https://www.postgresql.org/docs/17/transaction-iso.html); a revalidação pode observar uma revogação confirmada enquanto aguardava o lock. Os locks serializam as escritas coordenadas e as versões impedem sobrescritas de formulários antigos. Cadastro, histórico e auditoria são confirmados ou revertidos juntos.

Criar produto inclui seu `StockBalance` com zero e dois registros iniciais em `ProductValueHistory`, um de custo e outro de venda. Alterar um valor acrescenta apenas o histórico correspondente, com valor anterior, novo valor, responsável e o mesmo identificador de operação da auditoria. O histórico continua protegido contra alteração e exclusão. Nenhum campo do formulário ou da API permite escrever o saldo.

Quantidades e valores unitários usam `Decimal(18,4)`, com até 14 dígitos inteiros e quatro decimais. O contrato HTTP usa strings com ponto; a interface aceita vírgula ou ponto e converte sem passar por `Number`. Valores negativos, `NaN`, excesso de precisão e estouro são rejeitados antes da persistência. SKU é aparado, convertido para maiúsculas e não aceita espaços; código de barras opcional preserva zeros à esquerda. Inativar não libera esses identificadores para outro registro.

Documento de fornecedor/cliente é opcional, normalizado para letras e números em maiúsculas após remoção de espaços, pontos, barras e hífens. A validação não verifica autenticidade ou dígitos de CPF/CNPJ. Uma categoria ou fornecedor inativo pode permanecer associado ao produto já existente. Criar, trocar a associação ou reativar o produto exige referências ativas. As opções retornam também inativos para permitir filtros históricos, enquanto o formulário oferece ativos e preserva a referência atual.
