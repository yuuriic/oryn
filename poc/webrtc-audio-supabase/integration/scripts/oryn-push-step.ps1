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
  - O resultado do -Apply vem de dois --dry-run capturados, porque a chamada interativa não pode ter a saída
    capturada sem arriscar esconder o prompt. Antes: banco em dia = NADA APLICADO, sem chamar o push. Depois:
    só o banco em dia autoriza imprimir APLICADO. Código 0 da CLI nunca basta: ele também sai quando não há nada a
    aplicar.

  - Etapa 8 aceita somente o arquivo de perfil aprovado, com manifesto SHA-256 fixado. Recusa histórico
    diferente das sete versões anteriores, reaplicação e deriva dos seis contratos/ACLs/owners.
    Executa SELECTs específicos pela Management API antes do plano, antes da escrita e depois dela.
    Indisponibilidade da consulta ou resultado desconhecido impede confirmar sucesso.
  NÃO faz backup nem dump. Etapas 1–7 mantêm verificações SQL separadas. Para a 8, ver PROFILE-PUBLICATION-08.md.

.EXAMPLE
  pwsh -File integration/scripts/oryn-push-step.ps1 -Step 1            # dry-run da 0100
  pwsh -File integration/scripts/oryn-push-step.ps1 -Step 1 -Apply     # ⛔ só com autorização da etapa
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [ValidateRange(1, 8)] [int] $Step,
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
$allowed = @(
  '20261023000100_oryn_schema.sql', '20261023000200_oryn_functions.sql',
  '20261023000300_oryn_realtime.sql', '20261028000400_oryn_room_management.sql',
  '20261106000500_oryn_room_messages.sql', '20261107000600_oryn_room_membership.sql',
  '20261108000700_oryn_soundboard.sql', '20261109224924_oryn_account_display_name.sql'
)
$expected = @(Get-ChildItem -Path $migrationsDir -Filter '*.sql' | Sort-Object Name)
if ($expected.Count -notin @(7, 8) -or $expected.Count -lt $Step -or
    ($expected.Name -join ',') -cne (($allowed | Select-Object -First $expected.Count) -join ',')) {
  throw 'migrações inesperadas ou ausentes: somente as sete históricas e a oitava aprovada são aceitas'
}
# Hashes fixados no artefato revisado. Normalizar CRLF evita depender do autocrlf do checkout.
function Get-CanonicalHash([string] $Path) {
  $bytes = [Text.Encoding]::UTF8.GetBytes([IO.File]::ReadAllText($Path).Replace("`r`n", "`n"))
  return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
}
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'profile-08-manifest.json') -Raw | ConvertFrom-Json
if (($manifest.migrations.file -join ',') -cne ($allowed -join ',')) { throw 'manifesto de migrações divergente' }
foreach ($m in $expected) {
  $pin = @($manifest.migrations | Where-Object file -CEQ $m.Name)
  if ($pin.Count -ne 1 -or (Get-CanonicalHash $m.FullName) -cne $pin[0].sha256) {
    throw "integridade divergente: $($m.Name)"
  }
}
if ($Step -eq 8) {
  $checkFiles = @('integration/sql/20_profile_08_preflight.sql', 'integration/sql/21_profile_08_postflight.sql', 'integration/sql/22_profile_08_recovered.sql', 'integration/sql/95_recover_profile_08.sql')
  if (($manifest.checks.file -join ',') -cne ($checkFiles -join ',')) { throw 'manifesto das verificações divergente' }
  foreach ($check in $manifest.checks) {
    if ((Get-CanonicalHash (Join-Path $poc $check.file)) -cne $check.sha256) { throw "integridade divergente: $($check.file)" }
  }
}
$selected = @($expected | Select-Object -First $Step)
$target = $selected[-1]
$targetVersion = $target.Name.Split('_')[0]
$others = @($expected | Where-Object { $_.Name -ne $target.Name })
# Banco em dia na CLI 2.122.0, lido dela: com a saída capturada, que é o caso aqui, vem JSON ("upToDate":true); no
# terminal, vem a frase. Os dois valem.
$UpToDatePattern = '"upToDate"\s*:\s*true|Remote database is up to date'

# Lê a saída de um --dry-run: 'pending' (o alvo será aplicado), 'up-to-date' (nada a aplicar) ou 'unknown'.
# Citar outra migração interrompe em qualquer caso.
function Get-PushPlan([string] $Text) {
  foreach ($entry in [regex]::Matches($Text, '(?<!\d)\d{14}(?!\d)')) {
    $version = $entry.Value
    if ($version -cne $targetVersion) { throw "o dry-run cita $version, fora desta etapa: interromper" }
  }
  foreach ($o in $others) {
    if ($Text -match [regex]::Escape($o.Name.Split('_')[0])) { throw "o dry-run cita $($o.Name), fora desta etapa: interromper" }
  }
  if ($Text -match [regex]::Escape($targetVersion)) {
    if ($Text -match $UpToDatePattern) { throw 'dry-run contraditório: interromper' }
    return 'pending'
  }
  if ($Text -match $UpToDatePattern) { return 'up-to-date' }
  return 'unknown'
}

# 1. Pré-condições locais.
if (Test-Path Env:SUPABASE_DB_PASSWORD) { throw 'SUPABASE_DB_PASSWORD já está definida neste processo: limpe-a antes (Remove-Item Env:SUPABASE_DB_PASSWORD).' }
$dirty = & git -C $poc status --porcelain -- supabase integration/scripts integration/sql
if ($LASTEXITCODE -ne 0) { throw 'git status falhou' }
  if ($dirty) { throw "há mudanças não commitadas em supabase/ ou nos artefatos operacionais: $dirty" }

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
  if ($Step -eq 8) {
    foreach ($check in $manifest.checks) {
      $destination = Join-Path $workdir ([IO.Path]::GetFileName($check.file))
      Copy-Item -LiteralPath (Join-Path $poc $check.file) -Destination $destination
      if ((Get-CanonicalHash $destination) -cne $check.sha256) { throw 'integridade da cópia SQL divergente' }
    }
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

  # 4. CLI com a senha SÓ no ambiente deste processo, durante as chamadas; o `finally` a remove.
  $pushArgs = @('--workdir', $workdir, 'db', 'push', '--project-ref', $ProjectRef, '--skip-vault')
  $dryRunArgs = $pushArgs + '--dry-run'
  $plain = [System.Net.NetworkCredential]::new('', $Password).Password
  $env:SUPABASE_DB_PASSWORD = $plain

  # Etapa 8: a consulta usa Management API (--linked), não cria papel CLI de login.
  # Só SELECT de catálogo/histórico; saída bruta não é impressa. Sem leitura de usuários.
  function Assert-ProfileState([string] $Phase) {
    $sqlFile = if ($Phase -eq 'preflight') { '20_profile_08_preflight.sql' } else { '21_profile_08_postflight.sql' }
    $result = @(& $SupabaseCli @SupabaseCliPrefix --workdir $workdir db query --linked --project-ref $ProjectRef --file (Join-Path $workdir $sqlFile) --output json 2>&1 | ForEach-Object { "$_" })
    $queryCode = $LASTEXITCODE
    if ($queryCode -ne 0 -or ($result -join "`n") -notmatch ('"result"\s*:\s*"oryn-profile-08-' + $Phase + '-ok"')) {
      throw "Etapa 8: $Phase recusado (histórico, objetos, permissões ou consulta divergentes). Não reaplicar; conferir SQL específico."
    }
    Write-Host "Etapa 8: $Phase confirmado."
  }
  if ($Step -eq 8) { Assert-ProfileState 'preflight' }

  # 5. Dry-run: nunca aplica. No -Apply, também decide se há o que aplicar.
  $output = & $SupabaseCli @SupabaseCliPrefix @dryRunArgs 2>&1 | ForEach-Object { "$_" }
  $code = $LASTEXITCODE
  $output | ForEach-Object { Write-Host $_ }
  if ($code -ne 0) { throw "a CLI saiu com código $code (ver a saída acima); interromper e registrar" }
  $plan = Get-PushPlan ($output -join "`n")

  if (-not $Apply) {
    # Banco em dia num dry-run também interrompe: a etapa esperava aplicar o alvo.
    if ($plan -ne 'pending') { throw "o dry-run não lista ${targetVersion}: interromper" }
    Write-Host "DRY-RUN OK: só $($target.Name). Agora rode integration/sql/06_cli_side_effects.sql (esperado: nada mudou)."
  } elseif ($plan -eq 'up-to-date') {
    if ($Step -eq 8) { throw 'Etapa 8 já aplicada: reaplicação recusada' }
    Write-Host "NADA APLICADO: o banco já está em dia, inclusive com $($target.Name). Confira em 06_cli_side_effects.sql."
  } elseif ($plan -ne 'pending') {
    throw "o dry-run não lista ${targetVersion} nem informa banco em dia: nada foi aplicado; interromper"
  } else {
    # Reconfere imediatamente antes da escrita; evita usar só um pré-voo antigo.
    if ($Step -eq 8) { Assert-ProfileState 'preflight' }
    # Direto no terminal: o prompt de confirmação da própria CLI precisa aparecer (sem --yes).
    & $SupabaseCli @SupabaseCliPrefix @pushArgs
    $code = $LASTEXITCODE
    if ($code -ne 0) { throw "a CLI saiu com código $code (ver a saída acima); resultado não confirmado: rode 06_cli_side_effects.sql" }

    # 6. Só o banco em dia, lido depois da chamada, prova a aplicação.
    $output = & $SupabaseCli @SupabaseCliPrefix @dryRunArgs 2>&1 | ForEach-Object { "$_" }
    $code = $LASTEXITCODE
    $output | ForEach-Object { Write-Host $_ }
    if ($code -ne 0) { throw "a conferência depois da aplicação falhou (código $code); resultado não confirmado: rode 06_cli_side_effects.sql" }
    $plan = Get-PushPlan ($output -join "`n")
    if ($plan -eq 'pending') { throw "NÃO APLICADO: $($target.Name) continua pendente (recusada no prompt, ou a CLI não a aplicou)." }
    if ($plan -ne 'up-to-date') { throw "resultado não confirmado: a conferência não informa banco em dia; rode 06_cli_side_effects.sql" }
    if ($Step -eq 8) { Assert-ProfileState 'postflight' }
    Write-Host "APLICADO: $($target.Name). Confira as verificações SQL específicas da etapa no checklist."
  }
}
finally {
  # Limpeza SEMPRE, inclusive em erro ou Ctrl+C.
  Remove-Item Env:SUPABASE_DB_PASSWORD -ErrorAction SilentlyContinue
  $plain = $null
  $Password = $null
  if (Test-Path -LiteralPath $base) {
    $resolvedBase = (Resolve-Path -LiteralPath $base).Path
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if (-not $resolvedBase.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($resolvedBase) -notlike 'oryn-push-*') { throw 'limpeza recusada: caminho temporário inesperado' }
    Remove-Item -LiteralPath $resolvedBase -Recurse -Force -ErrorAction SilentlyContinue
  }
}
