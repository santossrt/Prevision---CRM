# Redefinição administrativa de senha

Implementada em 31/10/2026, antes do início da etapa 4.

Em **Usuários**, o perfil **Administrador** possui o botão **Redefinir senha** em cada cadastro. O diálogo confirma o destinatário e gera instruções para que o próprio usuário escolha a nova senha. O link expira em 30 minutos e só pode ser usado uma vez. Um novo pedido invalida os links e concessões pendentes anteriores.

A solicitação mantém a senha e as sessões atuais. Ao concluir a definição, o hash é substituído e as sessões e os tokens anteriores são revogados na mesma transação. O administrador não informa nem visualiza a senha escolhida pelo destinatário.

A ação atende usuários ativos, inativos, ainda sem senha, vinculados ao Google, outros administradores e o próprio administrador. Uma conta inativa continua inativa; o vínculo Google é preservado. A recuperação pública mantém suas regras anteriores e não emite essa autorização administrativa.

O endpoint `POST /api/users/[id]/password-reset` aceita somente um objeto JSON vazio, exige sessão válida, CSRF, perfil `ADMINISTRATOR` e permissão `users.manage`. O papel atual é conferido novamente sob o lock de autorização. Ter apenas `users.manage` em outro perfil não permite a operação. Há limites compartilhados de 30 solicitações por administrador em 15 minutos e cinco por destinatário em 30 minutos.

O banco armazena somente o hash do token, com a finalidade `ADMIN_PASSWORD_RESET`, introduzida na migration `202610310005_admin_password_reset`. A entrega ocorre fora da transação. Se falhar, o serviço tenta revogar apenas o token daquela solicitação e registrar a falha. Solicitação, falha de entrega e conclusão são auditadas sem incluir senha, link ou token. A resposta da API também não inclui esses valores.

## Entrega local

O ambiente atual utiliza `MAIL_TRANSPORT=local`. As instruções ficam na caixa privada `.cache/mail`; nenhum e-mail é enviado pela internet. Depois de gerar as instruções, execute no terminal:

```powershell
npm.cmd run mail:read
```

O comando mostra o link privado mais recente. Abra-o para definir a senha; não compartilhe a saída. Para entregar mensagens pela internet, configure o SMTP conforme [ambientes](environments.md).

## Verificação

- TypeScript e build aprovados, sem avisos.
- 208 testes unitários aprovados, incluindo 18 casos administrativos, recarga do cliente Prisma e privacidade dos diagnósticos.
- 61 cenários HTTP/PostgreSQL aprovados em banco e servidor descartáveis.
- Cobertura inclui bloqueio de operador e de gerente com `users.manage`, revalidação de papel após espera por lock, CSRF, expiração, uso único, troca de link, auditoria, revogação de sessões e os diferentes tipos de conta.
- Testes e implementação não redefiniram senhas de usuários reais. Banco descartável e mensagens de teste foram removidos.
- Inspeção visual manual do botão e do diálogo permanece pendente; o acesso automatizado ao navegador está indisponível nesta sessão.

## Falha genérica durante o desenvolvimento

O cache global antigo mantinha a mesma instância Prisma mesmo após regenerar o cliente. Assim, a recarga do código podia usar o schema anterior, sem a finalidade `ADMIN_PASSWORD_RESET`. Durante o desenvolvimento, o cache agora associa cada instância ao construtor gerado que a criou e preserva requisições em andamento. Produção mantém um único pool por processo e recebe o schema atual ao reiniciar no deploy. Depois de atualizar o schema, gere o cliente, aplique as migrations e reinicie o servidor conforme [ambientes](environments.md).

Erros inesperados registram apenas categorias fixas e códigos Prisma/SQLSTATE permitidos no terminal do servidor. Mensagens de drivers, stack, queries e dados de acesso permanecem omitidos. A mensagem genérica da interface, isoladamente, não identifica a causa. Na retomada desta correção, PostgreSQL e servidor estavam parados; o banco foi iniciado e suas cinco migrations e a finalidade administrativa foram conferidas.
