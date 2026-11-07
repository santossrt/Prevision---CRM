# Etapa 2 — autenticação e autorização

Registro de 30/10/2026. A implementação local passou nas verificações automáticas abaixo, e o responsável confirmou o login Google real. A inspeção visual completa e o SMTP externo permanecem pendentes; a etapa 3 não foi iniciada.

## Implementado

- Login com e-mail e senha para usuários previamente cadastrados e ativos, com hash scrypt e senha entre 12 e 128 caracteres.
- Bootstrap do primeiro administrador por terminal, sem credenciais padrão, com senha e confirmação ocultas, validação por campo e nova tentativa quando a entrada é inválida.
- Páginas de login, ativação, recuperação, redefinição de senha, perfil e gerenciamento de usuários.
- Cadastro administrativo, atribuição de perfil, autorização individual de Google, ativação/desativação e reenvio de convite.
- Perfis administrador, gerente e operador, com permissões verificadas no servidor e revalidação do ator nas transações.
- Proteção do último administrador ativo com uma forma utilizável de acesso.
- Sessão em cookie HttpOnly e registro de revogação no PostgreSQL; duração absoluta de oito horas e limite de 30 minutos de inatividade.
- Logout e invalidação das sessões anteriores na redefinição de senha ou alteração relevante de autorização.
- Convites de 24 horas e recuperação de 30 minutos, com tokens aleatórios armazenados por hash, expiração e uso único.
- Resposta genérica de recuperação, sem confirmar se o e-mail possui cadastro.
- Vinculação Google explícita por convite ou confirmação da senha, com cadastro e autorização prévios; sem criação automática de usuários.
- Transporte de mensagens local e suporte SMTP configurável.
- Proteção de origem e CSRF, limites de requisições compartilhados no PostgreSQL, validação de entrada e CSP com nonce.
- Auditoria dos eventos de acesso e alterações de usuários, sem incluir senhas ou tokens.
- Logs de requisições do servidor de desenvolvimento desabilitados para não registrar links privados nas URLs.
- Terceira migration para autorização Google, finalidade de vinculação, unicidade do vínculo e contadores de limite.

## Verificações

| Verificação | Estado nesta revisão |
| --- | --- |
| Testes unitários | 124 testes aprovados em dez arquivos, incluindo bootstrap, importação Google e origem canônica. |
| `npm.cmd run typecheck` | Aprovado. |
| `npm.cmd run build` | Aprovado, sem avisos. |
| `npm.cmd run db:status` e `db:check` | Aprovados: três migrations aplicadas e identidade correta. Checksums das migrations e índice único por usuário/provedor conferidos. |
| Integração de integridade e privilégios do banco | 28 verificações aprovadas no PostgreSQL Docker. |
| `npm.cmd run check:auth` | 45 verificações aprovadas em servidor e banco descartáveis, incluindo o redirecionamento de localhost para a origem canônica; processo e fixtures removidos após execução. |
| Docker Compose do projeto | Serviço saudável em `127.0.0.1:55432`, com dados transferidos e conferidos nas 18 tabelas. Backup e cluster anterior preservados. |
| Login e vinculação com Google real | Aprovados no ambiente local: responsável confirmou o funcionamento. Banco conferido com um vínculo Google ativo e dois eventos de login Google bem-sucedido; nenhum access token, refresh token ou ID token OAuth persistido. Início com PKCE S256, state e callback exato também verificado. |
| Entrega por SMTP real | Pendente: provedor e credenciais não configurados. |
| Interação e inspeção visual desktop/mobile | Pendente: ferramenta de controle interrompeu a tentativa por não conseguir identificar a URL do navegador com segurança. |

A integração HTTP verificou proteção anônima, login, permissões, CSRF, criação e ativação de usuário, convite invalidado após desativar/reativar, expiração/finalidade/uso único de tokens, recuperação concorrente, inatividade, revogação por senha/perfil/status, proteção do último administrador, logout da aplicação e do Auth.js com cópia do cookie, auditoria sem segredos e limite concorrente compartilhado no PostgreSQL.

As verificações identificaram e corrigiram um ciclo de redirecionamento causado pela normalização de `127.0.0.1` no `NextURL` e a criação de sessão com `lastSeenAt` anterior ao `createdAt` do PostgreSQL. Há regressões para o endereço canônico e para transições de autorização durante o login. A criação da sessão passou também no banco real.

Após uma tentativa com dados de senha inválidos, o bootstrap foi ajustado para repetir a entrada com mensagem específica, sem encerrar o cadastro, e exigir confirmação. Cinco testes verificam nova tentativa, confirmação, e-mail inválido, credenciais do ambiente e encerramento da entrada. Um terminal real confirmou ocultação da senha, rejeição de senha curta, nova tentativa após confirmação diferente e cancelamento por Ctrl+C, sem criar usuário de teste no banco principal. A verificação de tipos passou após a correção.

O início Google revelou duas falhas adicionais: o processo Next iniciado no sandbox não conseguia consultar a descoberta OAuth (`EACCES`), e o Next transformava o redirect absoluto de `127.0.0.1` em relativo a `localhost`, gerando um ciclo. O servidor local foi iniciado fora do sandbox, ainda restrito a `127.0.0.1:3000`. A emissão do redirect canônico passou para um Route Handler interno, com origem fixa, `no-store` e `no-referrer`. A regressão HTTP confirmou `/login` e `/login?error=Configuration` por localhost chegando à origem correta com HTTP 200. Foram conferidos também HEAD, rejeição de POST em host diferente, bloqueio de acesso direto à rota interna e sobrescrita de cabeçalho injetado.

Para repetir o teste HTTP, execute `npm.cmd run build` e depois `npm.cmd run check:auth`. O script cria um banco com nome aleatório e marcador próprio, usa a role restrita no servidor e só remove o banco cuja identificação corresponde à execução. A porta `3010` precisa estar livre. Não execute outro build durante essa verificação.

Os testes de autenticação devem usar banco descartável com identificação própria, mensagens em `.cache/mail-test` e credenciais efêmeras. Não devem criar usuários de teste no banco de desenvolvimento principal.

## Conferência local pelo responsável

Com o banco preparado e identificado:

```powershell
npm.cmd run auth:setup
npm.cmd run auth:bootstrap
npm.cmd run dev
```

1. Abra `http://127.0.0.1:3000` e entre com as credenciais escolhidas no bootstrap.
2. Confira a navegação autenticada, **Perfil**, **Usuários** e o comportamento em largura móvel.
3. Cadastre um usuário operador. Execute `npm.cmd run mail:read` no seu terminal e abra o link privado de ativação.
4. Defina uma senha, entre como operador e confira que ações administrativas não estão disponíveis.
5. Solicite recuperação, consulte a mensagem local, redefina a senha e confira que a sessão anterior perdeu o acesso.
6. Com o administrador, teste desativação e alteração de perfil de uma segunda conta, preservando o último administrador.
7. Confira logout e a exigência de novo login ao retornar a uma página protegida.

Não há envio de mensagens pela internet enquanto `MAIL_TRANSPORT=local`. O comando de leitura mostra um link que permite ativar ou recuperar uma conta; não compartilhe sua saída.

A configuração de Google e SMTP está em [ambientes](environments.md). Nenhum segredo deve ser enviado no chat. Depois de configurar os serviços externos, valide seus fluxos reais separadamente.

## Limites da entrega

O login Google real está validado neste ambiente local. O SMTP real e a inspeção visual completa continuam pendentes. Auth.js 5 permanece beta, conforme a decisão de arquitetura da etapa 1. Não há publicação externa nem funcionalidades operacionais de estoque nesta etapa. A próxima etapa contempla os cadastros operacionais.
