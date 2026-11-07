# Diagnóstico do Docker Desktop

Registro de 30/10/2026. **O Docker foi recuperado e o PostgreSQL do projeto está funcionando no Compose.** O diagnóstico inicial abaixo foi preservado como histórico.

## Configuração validada na retomada

- Docker Desktop `4.97.0.244584`, servidor Linux e CLI `29.9.2`, Compose `v5.6.1`.
- `docker version` respondeu com Client e Server; a configuração do Compose foi validada.
- Serviço `prevision-local-db-1` saudável, somente em `127.0.0.1:55432`, com volume persistente `prevision-local_prevision_local_data`.
- `.env`, `.env.example` e Compose usam a porta `55432`; a publicação do Compose aceita `POSTGRES_PORT`. As duas URLs devem usar a mesma porta.
- Três migrations aplicadas e identidade `development / prevision-local-development` conferida.
- As 28 verificações de integração de precisão, unicidade, histórico e privilégios passaram no PostgreSQL do Docker.

Na retomada, o engine já respondeu e as permissões permitiam seu funcionamento. Não foi necessário repetir alterações de ACL. Os backups anteriores continuam em `.cache`, sem exposição de credenciais.

O Windows reservou as faixas TCP `54133–54232` e `54233–54332`. A porta antiga `54329` pertence à segunda faixa e recusou o bind mesmo sem outro processo escutando. A publicação mudou para `55432`, sem alterar as reservas do Windows.

O cluster portátil foi aberto temporariamente apenas em `127.0.0.1:55431` para extrair um backup com `pg_dump`, após conferir sua identificação e diretório. O destino Docker era novo e sem tabelas de aplicação antes do `pg_restore`. O backup está em `.cache/docker-transfer/prevision-portable.dump`, ignorado pelo Git.

A verificação comparou a sentinela, as contagens e os digests do conteúdo das 18 tabelas entre origem e destino, com UTC nos dois servidores para normalizar timestamps. Todos coincidiram; o registro privado está em `.cache/docker-transfer/verification.json`. O cluster portátil foi encerrado depois da conferência, preservando seus arquivos em `.cache/postgres/data`. Nenhum volume anterior de outro projeto foi utilizado ou removido.

```powershell
npm.cmd run db:up
npm.cmd run db:check
npm.cmd run db:status
```

Para parar preservando o volume, use `npm.cmd run db:down`.

A política atual do PowerShell bloqueia scripts `.ps1`, incluindo `npm.ps1`. Usar `npm.cmd` executa o npm sem alterar essa política. Abrir um `.ps1` pelo aplicativo associado pode abrir o Bloco de Notas; isso não executa o reparo. **Não é necessário executar novamente `repair-docker.ps1`.**

## Estado observado inicialmente

- Docker Desktop instalado: `4.97.0.244584`; Docker CLI: `29.9.2`.
- Contexto selecionado: `desktop-linux`.
- O CLI responde, mas o pipe `dockerDesktopLinuxEngine` não existe; ainda não há um engine disponível para esse contexto.
- Fora do sandbox, o WSL responde e lista `docker-desktop` como distribuição WSL 2 parada. Dentro do sandbox, a enumeração retorna `E_ACCESSDENIED`.
- Iniciar o Docker Desktop no usuário real, com janela oculta, criou os processos do aplicativo, mas não disponibilizou o engine.
- Os logs dessa tentativa registram `Access is denied` ao criar arquivos temporários de `config.json`, `daemon.json` e `windows-daemon.json` na pasta `.docker` do perfil do usuário.

## Causa identificada

A pasta `.docker` e os arquivos examinados pertencem ao grupo Administradores. As ACLs herdadas concedem apenas leitura aos grupos de usuários e controle total a Administradores e SYSTEM. A herança está habilitada.

A conta local do responsável utiliza um processo com token filtrado: o grupo Administradores aparece como usado apenas para negação, e o processo não está elevado. Assim, iniciar o aplicativo fora do sandbox resolve a limitação de enumeração do WSL, mas não fornece a permissão de escrita necessária às configurações do Docker.

O serviço `com.docker.service` foi observado parado, e `WslService` e `vmcompute`, em execução. O bloqueio de escrita acima foi reproduzido; esse resultado não demonstra necessidade de reinstalar o WSL ou resetar o Docker.

## Backup e reparo proposto

Foi salvo `.cache/docker-repair-acl.json`, fora do versionamento, contendo somente identidade do usuário, proprietário e DACL em SDDL da pasta `.docker` e dos três arquivos de configuração examinados. O conteúdo desses arquivos, incluindo possíveis credenciais, não foi copiado nem exibido.

O reparo proposto é acrescentar permissão de modificação somente ao usuário real no diretório `.docker`, com herança para seus filhos, preservando as demais regras e o proprietário:

```powershell
icacls 'C:\Users\SEU_USUARIO\.docker' /grant:r 'SEU_COMPUTADOR\SEU_USUARIO:(OI)(CI)M'
```

Esse exemplo usa marcadores: substitua `SEU_USUARIO` e `SEU_COMPUTADOR` pela sua conta e máquina. O comando exige um processo Windows elevado. A tentativa automatizada fora do sandbox foi aprovada, mas o Windows respondeu `Acesso negado`, com zero arquivos processados com sucesso: sair do sandbox não eleva o token UAC. Nenhuma ACL foi alterada por essa tentativa. O comando não utiliza `/T`, não toma posse dos arquivos e não altera permissões do perfil inteiro.

Após eventual aplicação autorizada, a verificação deve reiniciar o Desktop quando necessário e consultar `docker version` para confirmar a resposta do servidor. Uma alteração de ACL deve ser conferida com o backup disponível para eventual reversão restrita aos alvos examinados.

## Procedimento preparado para o reparo inicial

Abra o PowerShell **como administrador**, usando sua própria conta, e execute:

```powershell
Set-Location -LiteralPath (Join-Path $env:USERPROFILE 'Downloads\TCC')
& .\scripts\repair-docker.ps1
```

O script verifica a elevação antes de qualquer alteração. Ele identifica a pasta `.docker` do perfil atual, recusa um diretório redirecionado, salva outro backup das DACLs em `.cache/docker-acl-<timestamp>.json` e concede modificação ao SID do próprio usuário apenas nessa pasta, com herança. Não altera o proprietário nem substitui regras de outras contas.

Depois, inicia o Desktop com janela oculta e consulta somente o estado do engine por até 45 segundos. Código de saída `0` significa que o servidor respondeu; `1`, que o preparo foi interrompido; `2`, que a permissão foi aplicada, mas o engine ainda não respondeu no prazo. Nenhuma dessas verificações inicia containers do projeto.

Se a política de execução impedir o script, mantenha a política e use os comandos diretos abaixo no PowerShell administrativo. O backup inicial já registrado em `.cache/docker-repair-acl.json` permanece disponível.

```powershell
icacls 'C:\Users\SEU_USUARIO\.docker' /grant:r 'SEU_COMPUTADOR\SEU_USUARIO:(OI)(CI)M'
Start-Process -FilePath 'C:\Program Files\Docker\Docker\Docker Desktop.exe' -WindowStyle Hidden
docker version
```

Se o Desktop ainda estiver preso na mensagem de erro anterior, feche e abra o aplicativo manualmente antes de repetir `docker version`. Um servidor Docker respondendo deve aparecer na seção `Server`; a seção `Client` sozinha não confirma a recuperação.

## Limites da tentativa inicial

Não foram alteradas ACLs, proprietários, configurações, volumes, imagens ou containers. Não houve reset, reinstalação ou exclusão de dados. O banco PostgreSQL do projeto e a porta `54329` não foram utilizados nem interrompidos.
