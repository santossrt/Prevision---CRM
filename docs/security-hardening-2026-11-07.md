# Correções da auditoria de segurança — 07/11/2026

O responsável autorizou implementar o plano da auditoria. As mudanças abaixo tratam os achados identificados e preservam o acesso por senha/Google, o estoque compartilhado, a auditoria e os históricos imutáveis. A publicação na internet e a configuração de serviços externos continuam separadas deste trabalho.

## Leitura de requisições

`src/server/security/body-reader.ts` lê o corpo uma única vez, em chunks, com teto real de 16 ou 64 KiB, cancelamento imediato e prazo de dez segundos. O leitor também trata cancelamento do cliente e cabeçalhos de tamanho inválidos; não espera um callback de cancelamento que fique pendente indefinidamente.

O helper JSON usa esse leitor antes de interpretar o conteúdo. A rota Auth.js aplica o limite de frequência antes de ler o corpo e reconstrói uma `NextRequest` a partir dos bytes aprovados, preservando URL, cookies e demais opções. Corpos acima do teto retornam 413 na autenticação; timeout retorna 408. A clonagem e a leitura irrestrita foram removidas. As quatro regressões anteriormente marcadas como falhas esperadas passaram a ser testes comuns.

## Validação de Excel

O validador de referências XML utiliza um scanner com cursor explícito, em vez da expressão regular global com tentativas repetidas. Comentários, CDATA e instruções sem fechamento são recusados sem reiniciar a busca em cada posição. A validação mantém limites de linhas/colunas, nomes, namespaces, atributos, duplicidades e referências.

O ensaio local do mesmo validador, com ZIPs somente em memória, apresentou medianas de 0,872 ms para 147.479 bytes, 1,101 ms para 294.935 bytes e 1,600 ms para 589.847 bytes de XML malformado. O ensaio anterior de 147.479 bytes consumia 310,81 ms. Tempos dependem do equipamento e não substituem os testes funcionais de formatos e referências.

## Identificação do cliente no rate limit

Na Vercel, o runtime usa `x-vercel-forwarded-for`. Fora dela, uma aplicação pública precisa configurar `REQUEST_IP_HEADER` com o nome de um cabeçalho que um ingresso confiável **remova e substitua por um único IP validado**. A infraestrutura deve impedir acesso direto que contorne esse ingresso. Não se deve simplesmente confiar no `X-Forwarded-For` enviado pelo visitante.

Cabeçalhos ausentes, cadeias de endereços e valores inválidos são recusados. Sem Vercel ou uma política explícita, o fallback compartilhado é permitido somente em desenvolvimento/teste com origem de loopback. Uma configuração pública incompleta falha com 503, em vez de atribuir todos os usuários ao mesmo bucket.

## Dependências de e-mail e planilhas

O transporte SMTP passou a usar o alias npm `nodemailer-smtp`, fixado em `npm:nodemailer@10.3.1`. O alias permite atualizar o transporte utilizado pela aplicação sem instalar a versão vulnerável do peer opcional dos provedores de e-mail do Auth.js. O Prevision utiliza os provedores Credentials e Google; o provedor de e-mail do Auth.js não está habilitado. Nenhum peer incompatível foi forçado e não houve downgrade de Auth.js.

O transporte mantém TLS obrigatório nas portas suportadas, valida certificados e bloqueia acesso a arquivos e URLs. O objeto de envio continua limitado a remetente, destinatário, assunto e texto. A composição real de uma mensagem foi testada somente em memória; nenhuma mensagem de teste foi enviada pela internet.

O override do ExcelJS fixa `uuid@11.1.1`, versão corrigida que ainda oferece a exportação CommonJS usada pela biblioteca. Importação e exportação precisam continuar cobertas pelas regressões de CSV/XLSX/PDF. Não foi usado `npm audit fix --force`.

## Retenção e quotas de prévias

A migration `202611060012_transfer_retention` permite apenas descartar o **payload temporário expirado**, substituindo-o por `{}`. Identificador, proprietário, datas, contagens e demais metadados permanecem imutáveis. Exclusões continuam bloqueadas. Importações concluídas são histórico de negócio e não são expurgadas por essa manutenção.

Cada prévia nova inicia uma manutenção separada e confirmada antes da admissão da nova solicitação. A limpeza processa até cem conteúdos expirados por lote e continua fazendo progresso mesmo quando uma nova prévia é recusada por quota. A criação revalida permissões e verifica as quotas após adquirir o lock de autorização, catálogo e, por último, o lock global de quota, com `READ COMMITTED`.

Limites de conteúdo temporário retido, incluindo expirados ainda não limpos:

- Cem payloads e 32 MiB por usuário.
- 256 MiB no ambiente.
- O limite de oito MiB por relatório e a validade de trinta minutos continuam existentes.

Prévia de importação expirada retorna o conflito específico antes de tentar ler o payload removido. Importações concluídas continuam disponíveis para histórico e reenvio idempotente. O comando local `npm.cmd run maintenance:transfers` executa lotes limitados, valida a identidade de desenvolvimento e não aceita destinos por argumento. A limpeza física é oportunista ou por manutenção; expiração de acesso não implica remoção instantânea dos bytes.

## Recuperação de senha sem dependência da latência SMTP

A migration `202611070013_password_reset_jobs` acrescenta uma fila durável privada. A solicitação pública grava o mesmo tipo de pedido para endereços existentes e desconhecidos, sem consultar elegibilidade ou aguardar SMTP antes da resposta genérica. O processamento imediato utiliza `after()` depois da resposta HTTP; a fila permanece recuperável se o processo for interrompido.

O destinatário é cifrado com AES-256-GCM, chave derivada de `AUTH_SECRET` e contexto ligado ao banco e ao identificador do pedido. Nenhum token de acesso é armazenado na fila. Payloads são apagados ao concluir, expirar ou detectar adulteração.

O worker usa `FOR UPDATE SKIP LOCKED`, lease de sessenta segundos com renovação, até três tentativas e backoff. Pedidos expiram em quinze minutos; a fila admite até 256 ativos. A manutenção é limitada por lote e remove terminais antigos sem destinatário após um dia.

```powershell
npm.cmd run mail:process
npm.cmd run mail:process -- --limit=25
```

O comando valida a identidade do ambiente e registra somente contagens. Na implantação, deve ser agendado periodicamente para retomar pedidos após interrupções; `after()` acelera o processamento, mas não substitui essa rotina de recuperação. Sem SMTP configurado, o desenvolvimento continua usando a caixa local.

A entrega é **pelo menos uma vez**: se o processo morrer após o SMTP aceitar a mensagem e antes de registrar a conclusão, a tentativa seguinte pode gerar outro link. O fluxo existente revoga os grants anteriores; só o link mais recente permanece válido. Rotacionar `AUTH_SECRET` invalida pedidos pendentes cifrados com a chave anterior; eles são encerrados sem revelar o conteúdo.

## Versionamento e dados privados

O `.gitignore` cobre `.env`, variantes privadas, credenciais Google, `.cache`, logs, backups e os formatos de chaves/certificados privados listados nele. `.env.example` contém apenas exemplos. Identificadores pessoais desnecessários foram retirados do diagnóstico público do Docker. A checagem do índice do Git não encontrou arquivos já adicionados. A revisão dos 376 arquivos candidatos ao primeiro commit não identificou credenciais reais, e-mails pessoais, logs, dumps ou arquivos privados; os marcadores de credenciais e documentos encontrados pertencem a fixtures sintéticas dos testes. Nenhum commit ou push foi realizado.

Um backup privado do desenvolvimento foi criado em `.cache/security-backups` antes das migrations. Seu conteúdo e credenciais não devem ser incluídos em commits, issues ou anexos públicos.

## Validação

Validação concluída em 07/11/2026:

- Typecheck e build de produção aprovados.
- 911 testes unitários em 54 arquivos aprovados, sem falhas esperadas.
- 398 verificações de integração, segurança e recuperação aprovadas: fundação (28), autenticação (61), cadastros (41), estoque (44), ferramentas de estoque (33), inventários (25), auditoria (21), importação (20), exportação (23), notificações (20), dashboard (21), análises (25), recuperação (15), retenção (6) e fila de recuperação de senha (15).
- `npm audit` sem vulnerabilidades conhecidas: zero informativas, baixas, moderadas, altas ou críticas.
- Treze migrations aplicadas no desenvolvimento após backup privado validado. As contagens de produtos, movimentos, inventários, notificações e preferências permaneceram iguais às anteriores; os bancos descartáveis foram removidos.
- Servidor local reiniciado: health e login retornaram 200; a página protegida de análises redirecionou o visitante com 307, e sua API retornou 401. Todas essas respostas usaram `Cache-Control: no-store`.

A recuperação restaurou um dump real em destino descartável e comparou contagens, hashes de todas as tabelas, constraints, índices, funções e triggers. A comparação normaliza apenas formas equivalentes que o PostgreSQL produz ao restaurar casts de arrays literais e um agrupamento associativo específico de `AND`; valores, limites e regex continuam comparados.

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run check:transfer-retention
npm.cmd run check:security
npm.cmd run check:integration
npm.cmd run check:auth
npm.cmd run check:catalog
npm.cmd run check:stock
npm.cmd run check:stock-tools
npm.cmd run check:inventory
npm.cmd run check:audit
npm.cmd run check:transfers-import
npm.cmd run check:transfers-export
npm.cmd run check:notifications
npm.cmd run check:dashboard
npm.cmd run check:analyses
npm.cmd run check:recovery
npm.cmd audit
```

Esses resultados não demonstram ausência geral de vulnerabilidades. TLS/SMTP/OAuth reais e configurações públicas dependem da infraestrutura que será usada na publicação.
