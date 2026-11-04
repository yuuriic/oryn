# ORYN — executor da C2 com contas preexistentes (02C.7P-A; caminho P). Só o bloco da sala, modo `password`:
# 3 logins em contas criadas pelo operador, sem cadastro, sem anônimo e sem CAPTCHA.
# ⛔ Cada execução exige autorização própria (runbook §12.3). Rodar num PowerShell 7, a partir de qualquer pasta:
#
#   pwsh -NoProfile -File integration/scripts/oryn-c2.ps1 -ApprovedCommit <sha de 40 caracteres>
#
# - Processo próprio: as variáveis ORYN_* morrem com ele (e são removidas no finally de qualquer forma).
# - Chave publicável, senhas e convite são DIGITADOS com entrada protegida; nada é gravado, e nada sensível é
#   impresso. Os e-mails são digitados às claras (não são segredo), mas nunca vão para o resumo.
# - Aborta antes da rede se a branch, o commit ou a árvore divergirem, se o ambiente tiver algo proibido, se faltar
#   menos de 15 min para a virada do dia UTC (ou se ela tiver sido há menos de 15 min), se o D0 não for de hoje, ou
#   se o convite estiver vencido, perto de vencer ou já tiver sido usado.
# - O convite de criador NÃO é emitido aqui: o operador o emite no SQL editor, com autorização própria.
# - (02C.7P-C) O relatório bruto nasce como c2pw.BRUTO-NAO-COMPARTILHAR.txt e é apagado se tiver literal ou padrão
#   sensível; o pós-processamento (Complete-C2Run) nunca deixa o bruto sem tratamento. Execução interrompida sem
#   `resultado=` no horario.txt: recuperação offline com Invoke-C2Recovery (runbook §12.3).
# - Resultado PASS (saída 0), INCONCLUSIVO (2) ou FALHOU (1). Nada é repetido automaticamente.
param(
  [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string]$ApprovedCommit,
  [string]$ApprovedBranch = 'poc/webrtc-audio-supabase'
)
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'use PowerShell 7 (pwsh)' }
. (Join-Path $PSScriptRoot 'oryn-c2.lib.ps1')
$spec = Get-C2Spec
$PocDir = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$EvidenceRoot = Join-Path $PocDir 'integration\evidence'
function Read-Secret([string]$Prompt) { [Net.NetworkCredential]::new('', (Read-Host $Prompt -AsSecureString)).Password }

$exitCode = $null; $outcome = 'NÃO EXECUTADO'; $reason = ''; $dir = $null; $plain = $null
$key = $null; $invite = $null; $emails = @{}; $passwords = @{}
try {
  Set-Location -LiteralPath $PocDir
  Clear-OrynEnv
  Assert-CleanEnvironment
  $branch = (git rev-parse --abbrev-ref HEAD); if ($LASTEXITCODE -ne 0) { throw 'git rev-parse falhou' }
  $head = (git rev-parse HEAD); if ($LASTEXITCODE -ne 0) { throw 'git rev-parse HEAD falhou' }
  $porcelain = @(git status --porcelain); if ($LASTEXITCODE -ne 0) { throw 'git status falhou' }
  Assert-GitState -Branch $branch -Head $head -Porcelain $porcelain -ApprovedBranch $ApprovedBranch -ApprovedCommit $ApprovedCommit
  Write-Host "Git OK: $branch @ $head, árvore limpa"
  if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) { throw 'pnpm não encontrado' }
  git check-ignore -q 'integration/evidence/c2pw-sonda/relatorio.txt'
  if ($LASTEXITCODE -ne 0) { throw 'integration/evidence/ não está no .gitignore: não criar evidências dentro do repositório' }

  Write-Host 'C2 password: 3 logins, cria 1 sala aberta, sessões, hello/bye em realtime.messages e consome o convite. Exige autorização própria e o 12_c2_preflight.sql de hoje.'
  if ((Read-Host 'digite C2-PASSWORD para confirmar') -cne 'C2-PASSWORD') { throw 'confirmação da C2 não digitada: nada foi enviado' }
  Assert-UtcDayMargin -UtcNow (Get-Date)
  Assert-D0Date -Typed (Read-Host 'data UTC da partição confirmada no D0 (AAAA-MM-DD)') -UtcNow (Get-Date)

  $ref = Read-Host 'ref do projeto (20 caracteres)'
  $key = Read-Secret 'chave publicável (sb_publishable_…)'
  foreach ($role in 'OWNER', 'MEMBER', 'STRANGER') {
    $emails[$role] = (Read-Host "e-mail $role").Trim()
    $passwords[$role] = Read-Secret "senha $role"
  }
  $invite = Read-Secret 'convite de criador (uso único)'
  Assert-C2Inputs -Ref $ref -Key $key -Emails $emails -Passwords $passwords -Invite $invite
  Assert-InviteFresh -IssuedUtc (Read-Host 'emitido_em do convite (now() da consulta de emissão, UTC)') -UtcNow (Get-Date)
  $fingerprint = Get-InviteFingerprint $invite
  Assert-InviteNotReused -EvidenceRoot $EvidenceRoot -Fingerprint $fingerprint

  # Evidências só depois de todas as entradas válidas: abortos de digitação não deixam pasta.
  $startUtc = (Get-Date).ToUniversalTime()
  $dir = New-EvidenceDir -Root $EvidenceRoot -UtcNow $startUtc -Prefix 'c2pw'
  "modo=$($spec.Name)`ncommit=$head`ninicio_utc=$($startUtc.ToString('o'))" | Set-Content -LiteralPath (Join-Path $dir 'horario.txt') -Encoding utf8
  # Gravada ANTES da rede: mesmo uma execução interrompida (ou abortada daqui em diante) conta como uso do convite.
  $fingerprint | Set-Content -LiteralPath (Join-Path $dir 'convite.impressao') -Encoding utf8
  Write-Host "Evidências em: $dir"

  $env:ORYN_REMOTE = '1'
  $env:ORYN_REMOTE_REF = $ref
  $env:ORYN_SUPABASE_URL = "https://$ref.supabase.co"
  $env:ORYN_PUBLISHABLE_KEY = $key
  $env:ORYN_IT_PHASE = 'C2'
  $env:ORYN_IT_IDENTITY = 'password'                              # sem cadastro e sem CAPTCHA; 3 logins
  foreach ($role in 'OWNER', 'MEMBER', 'STRANGER') {
    Set-Item -LiteralPath "Env:ORYN_IT_USER_${role}_EMAIL" -Value $emails[$role]
    Set-Item -LiteralPath "Env:ORYN_IT_USER_${role}_PASSWORD" -Value $passwords[$role]
  }
  $env:ORYN_IT_PARTITIONS_CONFIRMED = '1'                         # D0 conferido acima (data de hoje, UTC)
  $env:ORYN_IT_CREATOR_INVITE = $invite
  Assert-OrynEnvSet -Actual @(Get-ChildItem Env: | Where-Object { $_.Name -like 'ORYN_*' } | ForEach-Object Name) -Expected $spec.EnvNames

  $plain = Enter-PlainConsole
  $report = Join-Path $dir $spec.Report                           # o bruto já nasce com nome de NÃO compartilhar
  $filter = $spec.Filter
  $exitCode = Invoke-NativeTee -Report $report -Command { pnpm test:remote --reporter=verbose -t $filter }
} catch {
  $outcome = 'ABORTADO'
  $reason = $_.Exception.Message
} finally {
  # Limpeza do ambiente PRIMEIRO: nada depois dela pode impedi-la.
  try { Clear-OrynEnv } finally { Exit-PlainConsole $plain }
  if ($dir) { "fim_utc=$((Get-Date).ToUniversalTime().ToString('o'))`nexit=$(if ($null -eq $exitCode) { 'ausente' } else { $exitCode })" | Add-Content -LiteralPath (Join-Path $dir 'horario.txt') -Encoding utf8 }
}

$secrets = @(@($passwords.Values) + $invite + $key | Where-Object { $_ })
$emailList = @($emails.Values)
$reason = Protect-C2Text $reason $secrets $emailList
# Houve relatório bruto (a execução chegou ao pnpm): pós-processamento SEMPRE, mesmo depois de uma exceção.
$runStarted = [bool]$dir -and (Test-Path -LiteralPath (Join-Path $dir $spec.Report))
if ($runStarted) {
  $aborted = $outcome -eq 'ABORTADO'
  try {
    $r = Complete-C2Run -Dir $dir -ExitCode $exitCode -Key $key -Secrets @(@($passwords.Values) + $invite) -Emails $emailList
    $r.Lines
    $outcome = $r.Outcome; $reason = (($(if ($aborted) { "exceção na execução: $reason" }), $r.Reason) | Where-Object { $_ }) -join '; '
    if ($aborted -and $outcome -eq 'PASS') { $outcome = 'INCONCLUSIVO' }
  } catch {
    # Não deveria acontecer (Complete-C2Run não lança). Sem saber se o bruto foi medido, ele não é preservado.
    $gone = Remove-C2Raw (Join-Path $dir $spec.Report)
    $outcome = 'INCONCLUSIVO'; $reason = Protect-C2Text "pós-processamento falhou: $($_.Exception.Message)$(if (-not $gone) { ' — apagar o bruto à mão' })" $secrets $emailList
  }
}
$key = $null; $invite = $null; $passwords = $null; $secrets = $null
Remove-Variable key, invite, passwords, secrets -ErrorAction SilentlyContinue
$after = @(git -C $PocDir status --porcelain)
if ($after.Count -gt 0 -and $outcome -ne 'ABORTADO') { $outcome = 'FALHOU'; $reason = (($reason, "árvore Git com $($after.Count) alteração(ões) depois da execução") | Where-Object { $_ }) -join '; ' }
if ($dir) { "resultado=$outcome" | Add-Content -LiteralPath (Join-Path $dir 'horario.txt') -Encoding utf8 }
"$($spec.Name): $outcome$(if ($reason) { " — $reason" })"
if ($dir) {
  'Compartilhar SOMENTE estes arquivos (nunca a pasta inteira, nunca o bruto):'
  Get-C2ShareableEvidence $dir | ForEach-Object { "  $_" }
}
if ($runStarted) { 'Próximo passo: leitura de depois com integration/sql/13_c2_postflight.sql (T0/T1 do horario.txt) e 07_initial_state.sql.' }
elseif ($dir) { 'Convite marcado como usado NESTA máquina sem ter ido à rede: não reutilizar; um convite novo exige autorização (runbook §12.3).' }
if ($outcome -ne 'PASS' -and $runStarted) { 'Não repetir: uma nova execução exige análise, limpeza autorizada e autorização separada.' }
# Saída: 0 = PASS; 2 = INCONCLUSIVO; 1 = FALHOU ou ABORTADO.
exit $(switch ($outcome) { 'PASS' { 0 } 'INCONCLUSIVO' { 2 } default { 1 } })
