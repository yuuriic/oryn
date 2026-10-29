# ORYN — executor da C0 (02C.6A). C0-R (Z1–Z4, REST) ou C0-W (Z6–Z8, WebSocket), sem identidade.
# ⛔ Cada execução exige autorização própria (runbook §12). Rodar num PowerShell 7, a partir de qualquer pasta:
#
#   pwsh -NoProfile -File integration/scripts/oryn-c0.ps1 -Mode W -ApprovedCommit <sha de 40 caracteres>
#
# - Processo próprio: as variáveis ORYN_* morrem com ele (e são removidas no finally de qualquer forma).
# - O ref e a chave publicável são DIGITADOS; nada é gravado, e nada sensível é impresso.
# - Aborta antes da rede se a branch, o commit ou a árvore divergirem, ou se o ambiente tiver algo proibido.
# - Só o bloco do modo roda (filtro -t do Vitest); o validador exige exatamente os Z do modo aprovados.
# - (02C.6E) C0-W: cada Z exige o motivo exato da recusa. Resultado PASS (saída 0), INCONCLUSIVO (2) ou FALHOU (1).
#   Nada é repetido automaticamente.
param(
  [Parameter(Mandatory)][ValidateSet('R', 'W')][string]$Mode,
  [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string]$ApprovedCommit,
  [string]$ApprovedBranch = 'poc/webrtc-audio-supabase'
)
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'use PowerShell 7 (pwsh)' }
. (Join-Path $PSScriptRoot 'oryn-c0.lib.ps1')
$spec = Get-C0Spec $Mode
$PocDir = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path

$exitCode = $null; $outcome = 'NÃO EXECUTADO'; $reason = ''; $dir = $null; $keyForScan = $null; $plain = $null
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
  # A pasta de evidências tem de ser IGNORADA pelo Git (nunca deixa arquivo não rastreado).
  git check-ignore -q 'integration/evidence/c0-sonda/relatorio.txt'
  if ($LASTEXITCODE -ne 0) { throw 'integration/evidence/ não está no .gitignore: não criar evidências dentro do repositório' }

  if ($Mode -eq 'W') {
    Write-Host 'C0-W abre WebSocket e CRIA as partições de realtime.messages. Exige autorização EXPLÍCITA e a leitura de antes (§12.2).'
    if ((Read-Host 'digite C0-W para confirmar') -cne 'C0-W') { throw 'confirmação da C0-W não digitada: nada foi enviado' }
  }

  $startUtc = (Get-Date).ToUniversalTime()
  $dir = New-EvidenceDir -Root (Join-Path $PocDir 'integration\evidence') -UtcNow $startUtc -Prefix $spec.Name.ToLower()
  "modo=$($spec.Name)`ncommit=$head`ninicio_utc=$($startUtc.ToString('o'))" | Set-Content -LiteralPath (Join-Path $dir 'horario.txt') -Encoding utf8
  Write-Host "Evidências em: $dir"

  $ref = Read-Host 'ref do projeto (20 caracteres)'
  if ($ref -notmatch '^[a-z0-9]{20}$') { throw 'ref fora do formato (20 caracteres a-z0-9)' }
  $secure = Read-Host 'chave publicável (sb_publishable_…)' -AsSecureString
  $keyForScan = [Net.NetworkCredential]::new('', $secure).Password
  if ($keyForScan -notmatch '^sb_publishable_[A-Za-z0-9_-]+$') { throw 'a chave digitada não tem o formato sb_publishable_ (nada foi enviado)' }

  $env:ORYN_REMOTE = '1'
  $env:ORYN_REMOTE_REF = $ref
  $env:ORYN_SUPABASE_URL = "https://$ref.supabase.co"
  $env:ORYN_PUBLISHABLE_KEY = $keyForScan
  $env:ORYN_IT_PHASE = 'C0'                                       # orçamento de cadastro e de login = 0 por construção
  if ($Mode -eq 'W') { $env:ORYN_IT_ALLOW_WS = '1' }
  # Proibido (o portão também recusa): identidade, credenciais, CAPTCHA, convite, orçamento ≠ 0, partições.
  Assert-OrynEnvSet -Actual @(Get-ChildItem Env: | Where-Object { $_.Name -like 'ORYN_*' } | ForEach-Object Name) -Expected $spec.EnvNames

  $plain = Enter-PlainConsole
  $report = Join-Path $dir $spec.Report
  $filter = $spec.Filter
  $exitCode = Invoke-NativeTee -Report $report -Command { pnpm test:remote --reporter=verbose -t $filter }
} catch {
  $outcome = 'ABORTADO'
  $reason = $_.Exception.Message
} finally {
  Exit-PlainConsole $plain
  Clear-OrynEnv
  Remove-Variable secure -ErrorAction SilentlyContinue
  if ($dir) { "fim_utc=$((Get-Date).ToUniversalTime().ToString('o'))`nexit=$(if ($null -eq $exitCode) { 'ausente' } else { $exitCode })" | Add-Content -LiteralPath (Join-Path $dir 'horario.txt') -Encoding utf8 }
}

if ($outcome -ne 'ABORTADO') {
  $reportPath = Join-Path $dir $spec.Report
  if (-not (Test-Path -LiteralPath $reportPath)) { $outcome = 'FALHOU'; $reason = 'relatório não gerado' }
  else {
    $lines = @(Get-Content -LiteralPath $reportPath -Encoding utf8)
    $sens = Measure-Sensitive -Path $reportPath -Literal $keyForScan
    $check = Test-C0Report -Lines $lines -Mode $Mode
    Write-SafeSummary -Lines ($lines + "$($spec.Name) exit = $exitCode") -Path (Join-Path $dir $spec.Summary)
    "ocorrências sensíveis no relatório (só contagem): jwt=$($sens.jwt) publishable=$($sens.publishable) secret=$($sens.secret) pat=$($sens.pat) chave_digitada=$($sens.chave_digitada) total=$($sens.total)"
    if ($sens.total -gt 0) {
      $q = Join-Path $dir ($spec.Report -replace '\.txt$', '.QUARENTENA-NAO-COMPARTILHAR.txt')
      Move-Item -LiteralPath $reportPath -Destination $q
      "O relatório bruto contém $($sens.total) padrão(ões) sensível(is). NÃO compartilhar. Usar só $($spec.Summary) (mascarado)." | Set-Content -LiteralPath (Join-Path $dir 'LEIA-ME.txt') -Encoding utf8
    }
    "resultado: $($check.SummaryLine) | Z aprovados: $($check.ZFound) | aprovados fora do modo: $($check.Outside) | linhas de falha: $($check.FailedLines) | veredito: $($check.Verdict)"
    foreach ($z in $check.PerZ) {
      $detail = if ($z.Expected) { " — motivo=$(if ($z.Outcome) { $z.Outcome } else { '?' }) (esperado $($z.Expected))" } else { '' }
      "  $($z.Z): $($z.Verdict)$detail$(if ($z.Why) { " — $($z.Why)" }) — $($z.Note)"
    }
    # 02C.6E: INCONCLUSIVO = nenhuma decisão de acesso errada, mas algum Z sem decisão (ex.: MissingPartition).
    # Não é PASS e NÃO é repetido aqui: nova execução exige autorização separada.
    if ($sens.total -gt 0) { $outcome = 'FALHOU'; $reason = 'relatório com padrão sensível (em quarentena)' }
    elseif ($exitCode -eq 0 -and $check.Ok) { $outcome = 'PASS' }
    elseif ($exitCode -ne 0 -and $check.Verdict -eq 'INCONCLUSIVO') { $outcome = 'INCONCLUSIVO'; $reason = "pnpm saiu com código $exitCode; nenhum Z com decisão errada, mas algum sem decisão de acesso (ver acima)" }
    elseif ($exitCode -ne 0) { $outcome = 'FALHOU'; $reason = "pnpm saiu com código $exitCode; veredito do relatório: $($check.Verdict)" }
    else { $outcome = 'FALHOU'; $reason = "exit 0, mas o relatório não mostra exatamente $($spec.Expected -join ', ') aprovados$(if ($spec.ExpectedRefusal) { ' com o motivo de recusa esperado' })" }
  }
}
$keyForScan = $null; Remove-Variable keyForScan -ErrorAction SilentlyContinue
# Depois da execução, a árvore tem de continuar limpa (as evidências são ignoradas).
$after = @(git -C $PocDir status --porcelain)
if ($after.Count -gt 0 -and $outcome -ne 'ABORTADO') { $outcome = 'FALHOU'; $reason = (($reason, "árvore Git com $($after.Count) alteração(ões) depois da execução") | Where-Object { $_ }) -join '; ' }
if ($dir) { "resultado=$outcome" | Add-Content -LiteralPath (Join-Path $dir 'horario.txt') -Encoding utf8 }
"$($spec.Name): $outcome$(if ($reason) { " — $reason" })"
if ($dir) { "Compartilhar SOMENTE: $(Join-Path $dir $spec.Summary) e horario.txt" }
if ($Mode -eq 'W' -and $null -ne $exitCode) { 'Próximo passo: leitura de depois (Z9) com integration/sql/11_c0w_postflight.sql e 07_initial_state.sql.' }
if ($outcome -ne 'PASS' -and $null -ne $exitCode) { 'Não repetir: uma nova execução exige análise e autorização separada.' }
# Saída: 0 = PASS; 2 = INCONCLUSIVO; 1 = FALHOU ou ABORTADO.
exit $(switch ($outcome) { 'PASS' { 0 } 'INCONCLUSIVO' { 2 } default { 1 } })
