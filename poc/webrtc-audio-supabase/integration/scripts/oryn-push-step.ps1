#Requires -Version 7.0
<#
.SYNOPSIS
  POC-02C — aplica (ou simula com --dry-run) UMA etapa de migração no Supabase, com autenticação explícita
  no banco e limpeza garantida da senha. 02C.3A.1.

.DESCRIPTION
  - Monta um --workdir TEMPORÁRIO, fora do repositório, com as N primeiras migrações (N = etapa) e confere
    o SHA-256 de cada arquivo contra o repositório.
  - Pede o ref e a senha do banco (a senha só como SecureString, nunca na tela, no histórico ou na linha
    de comando). A senha vai para SUPABASE_DB_PASSWORD SÓ durante a chamada da CLI. Assim a CLI conecta
    como `postgres` (direto ou pelo pooler) e NÃO cria o papel temporário `cli_login_postgres` (escrita
    persistente no projeto; documentação oficial). Na CLI 2.122.0 a variável vale com `db push
    --project-ref` (só o `gen types` com ref avulso a ignora); senha vazia também criaria o papel.
  - Remove a senha, as variáveis e o workdir num bloco `finally`, inclusive se a CLI falhar.
  - Exige a Supabase CLI EXATAMENTE 2.122.0 (`supabase --version`) antes de pedir credenciais e antes de
    qualquer conexão com o projeto (02C.3B.1). CLI ausente, outra versão ou versão não identificável = recusa.
  - Recusa rodar se SUPABASE_DB_PASSWORD já existir (não sobrescreve nem apaga segredo alheio) ou se
    houver mudança não commitada em supabase/.
  - Sem -Apply: só `--dry-run`. Com -Apply: exige a confirmação digitada `APLICAR <versão>` e mantém o
    prompt interativo da própria CLI (sem --yes). Esse prompt tem padrão SIM na CLI 2.122.0 (Enter vazio
    ou stdin sem terminal aplica): a trava é a confirmação deste script, não a da CLI.

  NÃO faz backup nem dump. NÃO roda verificações SQL (são feitas à parte, ver DEPLOY-CHECKLIST-02C.md).

.EXAMPLE
  pwsh -File integration/scripts/oryn-push-step.ps1 -Step 1            # dry-run da 0100
  pwsh -File integration/scripts/oryn-push-step.ps1 -Step 1 -Apply     # ⛔ só com autorização da etapa
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [ValidateRange(1, 3)] [int] $Step,
  [switch] $Apply,
  # Para testes locais com uma CLI falsa: executável e argumentos fixos antes dos da CLI.
  [string] $SupabaseCli = 'supabase',
  [string[]] $SupabaseCliPrefix = @(),
  # Só para testes não interativos (em uso real, os três são pedidos no terminal).
  [string] $ProjectRef,
  [securestring] $Password,
  [string] $Confirmation
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Versão em que todo o comportamento do procedimento foi lido (ajuda e binário). Não é parâmetro de propósito.
$RequiredCliVersion = '2.122.0'

$poc = (Resolve-Path (Join-Path $PSScriptRoot '..' '..')).Path
$migrationsDir = Join-Path $poc 'supabase' 'migrations'
$expected = @(Get-ChildItem -Path $migrationsDir -Filter '*.sql' | Sort-Object Name)
if ($expected.Count -ne 3) { throw "esperadas 3 migrações em supabase/migrations; encontradas $($expected.Count)" }
$selected = @($expected | Select-Object -First $Step)
$target = $selected[-1]
$targetVersion = $target.Name.Split('_')[0]
$others = @($expected | Where-Object { $_.Name -ne $target.Name })

# 1. Pré-condições locais.
if (Test-Path Env:SUPABASE_DB_PASSWORD) { throw 'SUPABASE_DB_PASSWORD já está definida neste processo: limpe-a antes (Remove-Item Env:SUPABASE_DB_PASSWORD).' }
$dirty = & git -C $poc status --porcelain -- supabase
if ($LASTEXITCODE -ne 0) { throw 'git status falhou' }
if ($dirty) { throw "há mudanças não commitadas em supabase/: $dirty" }

# 1b. Versão exata da CLI, ANTES do workdir, das credenciais e de qualquer conexão com o projeto. O
#     `--version` não recebe ref nem senha (pode só consultar se há versão nova, sem tocar no projeto).
#     A versão tem de vir numa linha sozinha; o aviso de atualização ("A new version ... v2.122.0
#     (currently installed v2.115.0)") não conta.
try {
  $versionOutput = @(& $SupabaseCli @SupabaseCliPrefix --version 2>&1 | ForEach-Object { "$_" })
  $versionCode = $LASTEXITCODE
} catch [System.Management.Automation.CommandNotFoundException] {
  throw "Supabase CLI não encontrada ('$SupabaseCli'): instale a $RequiredCliVersion. Nada foi executado."
}
if ($versionCode -ne 0) { throw "não foi possível identificar a versão da Supabase CLI (código $versionCode). Nada foi executado." }
$versions = @($versionOutput | ForEach-Object { if ($_ -match '^\s*v?(\d+\.\d+\.\d+)\s*$') { $Matches[1] } })
if ($versions.Count -ne 1) {
  $shown = ($versionOutput -join ' | ')
  if ($shown.Length -gt 200) { $shown = $shown.Substring(0, 200) + '…' }
  throw "não foi possível identificar a versão da Supabase CLI (saída: '$shown'). Nada foi executado."
}
if ($versions[0] -ne $RequiredCliVersion) { throw "Supabase CLI $($versions[0]) encontrada; o procedimento exige exatamente $RequiredCliVersion. Nada foi executado." }
Write-Host "Supabase CLI $RequiredCliVersion confirmada."

$base = Join-Path ([System.IO.Path]::GetTempPath()) ("oryn-push-" + [guid]::NewGuid().ToString('N'))
$workdir = Join-Path $base "step$Step"
$plain = $null
try {
  # 2. Workdir temporário com SÓ as N primeiras migrações, conferidas por SHA-256.
  New-Item -ItemType Directory -Force -Path (Join-Path $workdir 'supabase' 'migrations') | Out-Null
  Copy-Item (Join-Path $poc 'supabase' 'config.toml') (Join-Path $workdir 'supabase')
  foreach ($m in $selected) { Copy-Item $m.FullName (Join-Path $workdir 'supabase' 'migrations') }
  $copied = @(Get-ChildItem -Path (Join-Path $workdir 'supabase' 'migrations') -Filter '*.sql' | Sort-Object Name)
  if ($copied.Count -ne $Step) { throw "workdir com $($copied.Count) migrações; esperado $Step" }
  foreach ($c in $copied) {
    $orig = Join-Path $migrationsDir $c.Name
    if ((Get-FileHash $c.FullName -Algorithm SHA256).Hash -ne (Get-FileHash $orig -Algorithm SHA256).Hash) { throw "SHA-256 divergente: $($c.Name)" }
  }
  Write-Host "Etapa $Step — alvo: $($target.Name) (workdir temporário com $($copied.Count) migração(ões), SHA-256 conferido)"

  # 3. Credenciais (nunca exibidas).
  if (-not $ProjectRef) { $ProjectRef = Read-Host 'ref do projeto (<PROJECT_REF>)' }
  if ($ProjectRef -notmatch '^[a-z0-9]{20}$') { throw 'ref do projeto fora do formato (20 caracteres a-z0-9)' }
  if (-not $Password) { $Password = Read-Host 'senha do banco (não é exibida)' -AsSecureString }
  if ($Password.Length -eq 0) { throw 'senha vazia' }

  if ($Apply) {
    if (-not $Confirmation) { $Confirmation = Read-Host "Digite exatamente 'APLICAR $targetVersion' para aplicar a migração $($target.Name)" }
    if ($Confirmation -cne "APLICAR $targetVersion") { throw 'confirmação não confere: nada foi aplicado' }
  }

  # 4. CLI com a senha SÓ no ambiente deste processo e só durante a chamada.
  $cliArgs = @('--workdir', $workdir, 'db', 'push', '--project-ref', $ProjectRef, '--skip-vault')
  if (-not $Apply) { $cliArgs += '--dry-run' }
  $plain = [System.Net.NetworkCredential]::new('', $Password).Password
  $env:SUPABASE_DB_PASSWORD = $plain
  if ($Apply) {
    # Direto no terminal: o prompt de confirmação da própria CLI precisa aparecer (sem --yes).
    & $SupabaseCli @SupabaseCliPrefix @cliArgs
    $code = $LASTEXITCODE
    $output = @()
  } else {
    $output = & $SupabaseCli @SupabaseCliPrefix @cliArgs 2>&1 | ForEach-Object { "$_" }
    $code = $LASTEXITCODE
  }
  Remove-Item Env:SUPABASE_DB_PASSWORD -ErrorAction SilentlyContinue
  $output | ForEach-Object { Write-Host $_ }
  if ($code -ne 0) { throw "a CLI saiu com código $code (ver a saída acima); interromper e registrar" }

  # 5. O dry-run tem de citar o alvo e NENHUMA outra migração. O formato exato da saída da CLI 2.122.0
  #    não foi comprovado contra o projeto: a checagem é por nome de arquivo/versão.
  $text = $output -join "`n"
  if (-not $Apply) {
    if ($text -notmatch [regex]::Escape($targetVersion)) { throw "o dry-run não lista ${targetVersion}: interromper" }
    foreach ($o in $others) {
      if ($text -match [regex]::Escape($o.Name.Split('_')[0])) { throw "o dry-run cita $($o.Name), fora desta etapa: interromper" }
    }
    Write-Host "DRY-RUN OK: só $($target.Name). Agora rode integration/sql/06_cli_side_effects.sql (esperado: nada mudou)."
  } else {
    Write-Host "APLICADO: $($target.Name). Agora rode 05_step_checks.sql e 06_cli_side_effects.sql (Etapa $Step do checklist)."
  }
}
finally {
  # Limpeza SEMPRE, inclusive em erro ou Ctrl+C.
  Remove-Item Env:SUPABASE_DB_PASSWORD -ErrorAction SilentlyContinue
  $plain = $null
  $Password = $null
  if (Test-Path $base) { Remove-Item -Recurse -Force $base -ErrorAction SilentlyContinue }
}
