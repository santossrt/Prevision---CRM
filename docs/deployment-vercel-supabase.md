# Preparação da publicação na Vercel e no Supabase

## Estado em 08/11/2026

O projeto `prevision` foi criado na Vercel e vinculado ao repositório
`santossrt/Prevision---CRM`, branch `main`. A configuração utiliza Next.js,
Node.js 24, instalação com `npm ci` e build com `npm run build`.
O endereço configurado em `AUTH_URL` é `https://prevision-iota.vercel.app`.
O endereço atribuído não comprova que uma versão funcional já foi publicada.

As variáveis iniciais são exclusivas de Production: `APP_ENV=demo`,
`DATABASE_ID=prevision-demo`, `AUTH_URL`, `MAIL_TRANSPORT=smtp` e uma
`AUTH_SECRET` gerada exclusivamente para a demonstração. `DATABASE_URL` e
`DATABASE_SSL_CA` também foram cadastradas. A chave e a URL do banco foram
salvas como variáveis sensíveis na Vercel. Preview não recebe essas credenciais.

O banco Supabase utiliza PostgreSQL 17.11. Após a confirmação de que estava
vazio e a autorização explícita do responsável, foram aplicadas as 13 migrations
e registrada a identidade `demo/prevision-demo`. O usuário `prevision_app` foi
criado sem privilégios administrativos, com senha exclusiva e conexão TLS.

O Supabase habilitou RLS automaticamente nas tabelas criadas. Foram adicionadas
políticas de acesso exclusivamente para `prevision_app` nas 27 tabelas de domínio,
preservando RLS e as restrições SQL de cada tabela. O papel não possui BYPASSRLS.
Os papéis `anon` e `authenticated` continuam sem acesso ao schema de domínio.
A tabela `_prisma_migrations` permanece fora do acesso do runtime.

Uma transação Prisma pelo transaction pooler confirmou a identidade e as leituras
de usuários e produtos. O primeiro administrador foi criado com o e-mail escolhido
pelo responsável. A senha inicial foi gerada e salva apenas no arquivo privado;
seu hash e as permissões foram verificados pelo runtime.

## Arquivos privados e conexões

`.env.demo.local` recebe `DIRECT_URL` para administração e
`SESSION_POOLER_URL` para identificar o endpoint do pooler. Esse arquivo,
`.env.local`, `.cache` e `.vercel` estão excluídos do Git e do upload pela CLI.
As senhas administrativas não devem ser cadastradas no runtime da Vercel.

A conexão de runtime usa `prevision_app` no transaction pooler, porta
6543. A administração usa a conexão direta ou o session pooler na porta 5432.
O host do pooler deve vir do botão Connect do projeto, sem ser deduzido a partir
da região. Consulte a [documentação do Supabase](https://supabase.com/docs/guides/database/connecting-to-postgres).

Em `APP_ENV=demo`, o runtime sempre exige TLS, certificado válido e hostname
compatível. `DATABASE_SSL_CA` recebe o conteúdo PEM da autoridade do Supabase.
Parâmetros TLS da URL não podem desativar a validação nem substituir essa CA.
O desenvolvimento e os testes locais preservam sua configuração anterior.

O certificado foi obtido na [distribuição usada pelo painel oficial](https://github.com/supabase/supabase/blob/master/apps/studio/hooks/custom-content/custom-content.json),
pela URL `https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt`.
Ele é público, tem assunto `Supabase Root 2021 CA` e validade até 26/04/2031.
Seu fingerprint SHA-256 é
`807025AD50D4ED219D2C9C7D299C004F824EB00CF7F65AFEF607D07B72E6CAFA`.

## Procedimento administrativo executado

O procedimento administrativo preparado em `.cache/provision-supabase-demo.mjs`
confere o projeto Supabase, a ausência de tabelas não identificadas e o estado
de uma eventual execução anterior antes de modificar o banco. Foram executadas
as seguintes etapas:

1. Criar `prevision_app` com senha aleatória e sem privilégios administrativos.
2. Restringir o acesso dos papéis `anon`, `authenticated` e `PUBLIC` ao schema
   `public` deste projeto exclusivo da demonstração.
3. Aplicar as 13 migrations versionadas, com a conexão administrativa e TLS.
4. Registrar `demo/prevision-demo` na sentinela, sem reidentificar outro ambiente.
5. Configurar as políticas RLS de backend com `.cache/configure-supabase-rls.mjs`,
   preservando o bloqueio dos papéis públicos e sem conceder BYPASSRLS.
6. Conferir o acesso do runtime e a ausência de privilégios para alterar
   históricos, a sentinela ou as tabelas de controle das migrations.

`.cache/configure-supabase-runtime.mjs` validou a conexão pelo pooler e cadastrou
`DATABASE_URL` na Vercel. `.cache/bootstrap-demo-admin.mjs` criou o administrador
inicial solicitado. Os auxiliares e suas credenciais ficam privados; eles não
integram o build nem são executados nas requisições da aplicação.

Esse procedimento não importa os dados do desenvolvimento. Os comandos
`db:deploy`, `db:identify` e `auth:bootstrap` existentes continuam restritos ao
desenvolvimento local. Não devem ser usados para modificar o Supabase.

## Pendências para a publicação funcional

- Definir a execução periódica de recuperação da fila e da retenção de prévias.
- Publicar a versão atualizada e conferir login, autorização, estoque e arquivos.

Google OAuth permanece opcional e requer o callback do endereço publicado e
autorização prévia de cada usuário. As credenciais locais não são copiadas.

O responsável escolheu configurar SMTP antes de publicar. A configuração usa
Gmail em `smtp.gmail.com:465`, com TLS, remetente da própria conta e uma senha
de app gerada pelo responsável. A autenticação foi validada e as variáveis
foram cadastradas na Vercel, com `SMTP_PASSWORD` sensível. Um único e-mail de
teste, autorizado pelo responsável, foi aceito pelo servidor SMTP; essa
aceitação não comprova a entrega na caixa de entrada.
Veja as [instruções de senhas de app do Google](https://support.google.com/accounts/answer/185833?hl=pt-BR)
e os [endereços SMTP oficiais](https://developers.google.com/workspace/gmail/imap/imap-smtp).

## Validação desta preparação

- 24 testes aprovados nos módulos de configuração, conexão TLS e cache do Prisma.
- Build de produção e verificação TypeScript aprovados.
- Conexões administrativa e de runtime com certificado e hostname verificados.
- As 13 migrations, a sentinela, as políticas e o administrador foram conferidos.
- A simulação de upload confirmou a exclusão dos arquivos privados e a inclusão
  do módulo de TLS no código enviado.
- Autenticação SMTP validada e mensagem de teste aceita pelo Gmail.

Essas verificações precedem o deploy. Login HTTP, infraestrutura publicada e
os fluxos de e-mail da aplicação precisam de validação no ambiente publicado.
