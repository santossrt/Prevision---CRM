#Requires -Version 5.1

$ErrorActionPreference = 'Stop'

function Get-DockerServerVersion {
    param(
        [Parameter(Mandatory = $true)][string]$DockerCli,
        [Parameter(Mandatory = $true)][int]$TimeoutMilliseconds
    )

    $queryProcess = New-Object System.Diagnostics.Process
    $queryProcess.StartInfo = New-Object System.Diagnostics.ProcessStartInfo
    $queryProcess.StartInfo.FileName = $DockerCli
    $queryProcess.StartInfo.Arguments = 'version --format "{{.Server.Version}}"'
    $queryProcess.StartInfo.UseShellExecute = $false
    $queryProcess.StartInfo.CreateNoWindow = $true
    $queryProcess.StartInfo.RedirectStandardOutput = $true
    $queryProcess.StartInfo.RedirectStandardError = $true

    try {
        if (-not $queryProcess.Start()) { return $null }
        $queryOutput = $queryProcess.StandardOutput.ReadToEndAsync()
        $queryError = $queryProcess.StandardError.ReadToEndAsync()
        if (-not $queryProcess.WaitForExit($TimeoutMilliseconds)) {
            $queryProcess.Kill()
            $null = $queryProcess.WaitForExit(1000)
            return $null
        }
        if ($queryProcess.ExitCode -ne 0) { return $null }

        $serverVersion = $queryOutput.GetAwaiter().GetResult().Trim()
        $null = $queryError.GetAwaiter().GetResult()
        if ($serverVersion -match '^\d+\.\d+\.\d+') { return $serverVersion }
        return $null
    }
    finally {
        $queryProcess.Dispose()
    }
}

try {
    $currentIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $currentPrincipal = New-Object System.Security.Principal.WindowsPrincipal($currentIdentity)
    if (-not $currentPrincipal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Abra o PowerShell como administrador no seu proprio usuario e execute este script novamente. Nenhuma permissao foi alterada.'
    }

    $currentProfile = [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::UserProfile)
    $dockerDirectory = Join-Path $currentProfile '.docker'
    $dockerDirectoryItem = Get-Item -LiteralPath $dockerDirectory -Force
    if (-not $dockerDirectoryItem.PSIsContainer -or ($dockerDirectoryItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw 'A pasta .docker do perfil atual deve ser um diretorio real, sem redirecionamento. Nenhuma permissao foi alterada.'
    }

    $programFilesDirectory = [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::ProgramFiles)
    $dockerDesktop = Join-Path $programFilesDirectory 'Docker\Docker\Docker Desktop.exe'
    $dockerCli = Join-Path $programFilesDirectory 'Docker\Docker\resources\bin\docker.exe'
    if (-not (Test-Path -LiteralPath $dockerDesktop -PathType Leaf) -or -not (Test-Path -LiteralPath $dockerCli -PathType Leaf)) {
        throw 'Instalacao padrao do Docker Desktop nao encontrada. Nenhuma permissao foi alterada.'
    }

    $backupTargets = @($dockerDirectory)
    foreach ($configurationName in @('config.json', 'daemon.json', 'windows-daemon.json')) {
        $configurationPath = Join-Path $dockerDirectory $configurationName
        if (Test-Path -LiteralPath $configurationPath -PathType Leaf) { $backupTargets += $configurationPath }
    }
    $aclEntries = foreach ($backupTarget in $backupTargets) {
        $targetAcl = Get-Acl -LiteralPath $backupTarget
        [ordered]@{
            path = $backupTarget
            owner = $targetAcl.Owner
            daclSddl = $targetAcl.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Access)
        }
    }
    $backup = [ordered]@{
        identity = [ordered]@{ name = $currentIdentity.Name; sid = $currentIdentity.User.Value; administrativeToken = $true }
        entries = @($aclEntries)
    }
    $projectDirectory = Split-Path -Parent $PSScriptRoot
    $backupDirectory = Join-Path $projectDirectory '.cache'
    $null = New-Item -ItemType Directory -Path $backupDirectory -Force
    $timestamp = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmssfff')
    $backupPath = Join-Path $backupDirectory "docker-acl-$timestamp.json"
    [System.IO.File]::WriteAllText($backupPath, ($backup | ConvertTo-Json -Depth 6), [System.Text.UTF8Encoding]::new($false))
    Write-Host "Backup das permissoes salvo em: $backupPath"

    # SID evita depender da traducao dos nomes de contas. Nenhum /T ou /setowner.
    $grantArgument = '*{0}:(OI)(CI)M' -f $currentIdentity.User.Value
    & (Join-Path $env:WINDIR 'System32\icacls.exe') $dockerDirectory '/grant:r' $grantArgument | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw 'O Windows recusou a alteracao da permissao de .docker. O backup foi preservado; nenhuma outra tentativa de reparo sera feita.'
    }
    Write-Host 'Permissao de modificacao aplicada somente ao usuario atual na pasta .docker, com heranca para os filhos.'

    Start-Process -FilePath $dockerDesktop -WindowStyle Hidden
    Write-Host 'Docker Desktop iniciado. Verificando o engine por ate 45 segundos...'
    $readinessClock = [System.Diagnostics.Stopwatch]::StartNew()
    while ($readinessClock.ElapsedMilliseconds -lt 45000) {
        $remainingMilliseconds = 45000 - [int]$readinessClock.ElapsedMilliseconds
        if ($remainingMilliseconds -le 0) { break }
        $attemptTimeout = [Math]::Min(2000, $remainingMilliseconds)
        $version = Get-DockerServerVersion -DockerCli $dockerCli -TimeoutMilliseconds $attemptTimeout
        if ($version) {
            Write-Host "Docker engine disponivel. Versao do servidor: $version"
            exit 0
        }
        $remainingMilliseconds = 45000 - [int]$readinessClock.ElapsedMilliseconds
        if ($remainingMilliseconds -gt 0) { Start-Sleep -Milliseconds ([Math]::Min(1000, $remainingMilliseconds)) }
    }

    Write-Warning 'A permissao foi aplicada, mas o engine nao respondeu em 45 segundos. Se o Desktop estava preso em uma mensagem de erro anterior, feche e abra o aplicativo manualmente e consulte docker version. Nenhum container ou volume foi alterado.'
    exit 2
}
catch {
    Write-Error $_.Exception.Message -ErrorAction Continue
    exit 1
}
