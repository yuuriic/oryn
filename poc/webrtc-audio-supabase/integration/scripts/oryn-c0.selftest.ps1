# ORYN — autoteste OFFLINE do executor C0 (02C.6A; motivos de recusa no 02C.6E). Carrega só oryn-c0.lib.ps1
# (funções); nenhuma rede, nenhum Supabase, nenhum Git de escrita. Uso:
#   pwsh -NoProfile -File integration/scripts/oryn-c0.selftest.ps1 [-RealC0R <c0r.txt>] [-RealC0W <c0w.txt>]
param([string]$RealC0R, [string]$RealC0W)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'oryn-c0.lib.ps1')
$results = [System.Collections.Generic.List[string]]::new()
function Check([string]$name, [scriptblock]$body) {
  try { & $body; $results.Add("PASS  $name") } catch { $results.Add("FAIL  $name :: $($_.Exception.Message)") }
}
function Throws([scriptblock]$b, [string]$pattern) { try { & $b } catch { if ($_.Exception.Message -match $pattern) { return } else { throw "erro inesperado: $($_.Exception.Message)" } }; throw 'não lançou' }
$sha = 'd866b1e9b4c864277a9a5648b23915442cf95efa'; $br = 'poc/webrtc-audio-supabase'
$esc = [char]27
$cp850 = [Text.Encoding]::GetEncoding(850)
# Simula o console do operador: cores ANSI + UTF-8 lido como cp850.
function ConvertTo-OperatorConsole([string[]]$Lines) {
  $Lines | ForEach-Object { $cp850.GetString([Text.Encoding]::UTF8.GetBytes(("$esc[32m" + ($_ -replace ' > ', "$esc[2m > $esc[22m") + "$esc[39m"))) }
}

# --- Git ---
Check 'git ok' { Assert-GitState -Branch $br -Head $sha -Porcelain @() -ApprovedBranch $br -ApprovedCommit $sha }
Check 'git: branch errada aborta' { Throws { Assert-GitState -Branch 'main' -Head $sha -Porcelain @() -ApprovedBranch $br -ApprovedCommit $sha } 'branch' }
Check 'git: HEAD errado aborta' { Throws { Assert-GitState -Branch $br -Head ('0' * 40) -Porcelain @() -ApprovedBranch $br -ApprovedCommit $sha } 'HEAD' }
Check 'git: árvore suja aborta' { Throws { Assert-GitState -Branch $br -Head $sha -Porcelain @(' M x.ts', '?? y.ts') -ApprovedBranch $br -ApprovedCommit $sha } '2 altera' }
Check 'git: linhas vazias não contam' { Assert-GitState -Branch $br -Head $sha -Porcelain @('', '  ') -ApprovedBranch $br -ApprovedCommit $sha }

# --- ambiente ---
Check 'ambiente: ORYN_* proibida aborta (cita só o nome)' {
  $env:ORYN_IT_ALLOW_WS = '1'
  try { Throws { Assert-CleanEnvironment } 'ORYN_IT_ALLOW_WS' } finally { Remove-Item Env:ORYN_IT_ALLOW_WS }
}
Check 'ambiente: valor de chave secreta aborta sem imprimir o valor' {
  $fake = ('sb' + '_secret_' + 'ABCDEF123456'); $env:QUALQUER_VAR = $fake
  try { try { Assert-CleanEnvironment; throw 'não lançou' } catch { if ($_.Exception.Message -match [regex]::Escape($fake)) { throw 'vazou o valor' }; if ($_.Exception.Message -notmatch 'QUALQUER_VAR') { throw $_ } } } finally { Remove-Item Env:QUALQUER_VAR }
}
Check 'ambiente: variável com CAPTCHA no nome aborta' {
  $env:ORYN_CAPTCHA_MODE = 'turnstile-test'
  try { Throws { Assert-CleanEnvironment } 'ORYN_CAPTCHA_MODE' } finally { Remove-Item Env:ORYN_CAPTCHA_MODE }
}
Check 'ambiente: conjunto ORYN_* da C0-W exige ALLOW_WS; o da C0-R o recusa' {
  $w = (Get-C0Spec W).EnvNames; $r = (Get-C0Spec R).EnvNames
  Assert-OrynEnvSet -Actual $w -Expected $w
  Throws { Assert-OrynEnvSet -Actual $r -Expected $w } 'diferentes'
  Throws { Assert-OrynEnvSet -Actual $w -Expected $r } 'diferentes'
  Throws { Assert-OrynEnvSet -Actual ($w + 'ORYN_IT_IDENTITY_BUDGET') -Expected $w } 'diferentes'
}

# --- pasta de evidências ---
Check 'evidências: UTC, prefixo do modo, sem sobrescrever (-2, -3); raiz inexistente aborta' {
  $root = Join-Path ([IO.Path]::GetTempPath()) ('oryn-c0-val-' + [guid]::NewGuid().ToString('n').Substring(0, 8))
  New-Item -ItemType Directory -Path $root | Out-Null
  try {
    $t = [datetime]::new(2026, 10, 27, 1, 2, 0, [DateTimeKind]::Utc)
    $a = New-EvidenceDir -Root $root -UtcNow $t -Prefix 'c0-w'; $b = New-EvidenceDir -Root $root -UtcNow $t -Prefix 'c0-w'; $c = New-EvidenceDir -Root $root -UtcNow $t -Prefix 'c0-w'
    if ((Split-Path $a -Leaf) -ne 'c0-w-20261027-0102') { throw "nome $a" }
    if ((Split-Path $b -Leaf) -ne 'c0-w-20261027-0102-2' -or (Split-Path $c -Leaf) -ne 'c0-w-20261027-0102-3') { throw "sufixos $b $c" }
    Throws { New-EvidenceDir -Root (Join-Path $root 'nao-existe') -UtcNow $t -Prefix 'x' } 'inexistente'
  } finally { Remove-Item -Recurse -Force $root }
}

# --- normalização ---
Check 'normalização: ANSI + cp850 → texto original (✓ — ↓ □ ↳ ❯ e acentos)' {
  $orig = ' ✓ a > Supabase real — C0-W: sem identidade, WebSocket (exige ORYN_IT_ALLOW_WS=1; cria partições) > Z6 x ↓ □ ↳ ❯ ção'
  $got = ConvertTo-PlainReportLine @(ConvertTo-OperatorConsole @($orig))[0]
  if ($got -cne $orig) { throw "obtido: $got" }
}
Check 'normalização: anotação ↳ sozinha (sem ✓ na linha) também é reparada' {
  $orig = '     ↳ anon oryn privado: CHANNEL_ERROR (Unauthorized: You do not have permissions to read from this Channel topic)'
  $got = ConvertTo-PlainReportLine $cp850.GetString([Text.Encoding]::UTF8.GetBytes($orig))
  if ($got -cne $orig) { throw "obtido: $got" }
}
Check 'normalização: UTF-8 correto, ASCII e Ô legítimo ficam intocados' {
  foreach ($s in @(' ✓ x — y', '      Tests  4 passed | 27 skipped | 12 todo (43)', 'ÔNIBUS e Ô final', 'Árvore ├ legítima ✓')) {
    $got = ConvertTo-PlainReportLine $s
    if ($got -cne $s) { throw "alterou: '$s' → '$got'" }
  }
}

# --- relatório C0-R ---
$okR = @(
  ' RUN  v5.0.5 C:/Dev/Projeto - Oryn/poc/webrtc-audio-supabase',
  ' ✓ tests/remote/integration.remote.test.ts > Supabase real — C0-R: sem identidade, REST (chave publicável) > Z1 Auth: cadastro anônimo DESLIGADO 210ms',
  '     ↳ external.anonymous_users=false; external.email=true; disable_signup=false',
  ' ✓ tests/remote/integration.remote.test.ts > Supabase real — C0-R: sem identidade, REST (chave publicável) > Z2 as 12 RPCs (código 42501) 900ms',
  ' ✓ tests/remote/integration.remote.test.ts > Supabase real — C0-R: sem identidade, REST (chave publicável) > Z3 Data API (PGRST106) 300ms',
  ' ✓ tests/remote/integration.remote.test.ts > Supabase real — C0-R: sem identidade, REST (chave publicável) > Z4 Data API (PGRST106) 200ms',
  ' ↓ tests/remote/integration.remote.test.ts > Supabase real — C0-W: sem identidade, WebSocket (exige ORYN_IT_ALLOW_WS=1; cria partições) > Z6 anon não assina',
  ' Test Files  1 passed (1)',
  '      Tests  4 passed | 27 skipped | 12 todo (43)'
)
Check 'C0-R: 4 PASS exatos = Ok' { $r = Test-C0Report -Lines $okR -Mode R; if (-not $r.Ok -or $r.ZFound -ne 'Z1,Z2,Z3,Z4') { throw ($r | ConvertTo-Json -Compress -Depth 3) } }
Check 'C0-R: mesmo relatório no formato do console do operador = Ok' { $r = Test-C0Report -Lines (ConvertTo-OperatorConsole $okR) -Mode R; if (-not $r.Ok) { throw ($r | ConvertTo-Json -Compress -Depth 3) } }
Check 'C0-R: falha reprova' {
  $l = $okR -replace '^(\s*)✓(.*Z3 )', '$1×$2' -replace '4 passed \|', '3 passed | 1 failed |'
  if ((Test-C0Report -Lines $l -Mode R).Ok) { throw 'aprovou com falha' }
}
Check 'C0-R: teste aprovado fora da C0-R reprova' {
  $l = ($okR + ' ✓ tests/remote/integration.remote.test.ts > Supabase real — C1: sem sala > #4 RPC sem JWT 50ms') -replace '4 passed \|', '5 passed |'
  $r = Test-C0Report -Lines $l -Mode R; if ($r.Ok -or $r.Outside -ne 1) { throw ($r | ConvertTo-Json -Compress -Depth 3) }
}
Check 'C0-R: Z faltando reprova' { $l = @($okR | Where-Object { $_ -notmatch '> Z4 ' }) -replace '4 passed \|', '3 passed |'; if ((Test-C0Report -Lines $l -Mode R).Ok) { throw 'aprovou sem Z4' } }
Check 'C0-R: sem linha de resumo reprova' { if ((Test-C0Report -Lines ($okR | Where-Object { $_ -notmatch 'Tests ' }) -Mode R).Ok) { throw 'aprovou sem resumo' } }
Check 'C0-R: portão abortou (0 testes) reprova' { if ((Test-C0Report -Lines @('Error: ORYN_IT_PHASE ausente', ' Test Files  1 failed (1)', '      Tests  no tests') -Mode R).Ok) { throw 'aprovou' } }
Check 'C0-R: relatório no modo W reprova (Z errados)' { if ((Test-C0Report -Lines $okR -Mode W).Ok) { throw 'aprovou C0-R como C0-W' } }

# --- relatório C0-W ---
$wBlock = 'Supabase real — C0-W: sem identidade, WebSocket (exige ORYN_IT_ALLOW_WS=1; cria partições)'
# 02C.6E: textos REAIS do Realtime (`<Código>: <mensagem>`), como na 1ª C0-W.
$R = @{
  authz   = 'Unauthorized: You do not have permissions to read from this Channel topic: it-c0-x'
  private = 'PrivateOnly: This project only allows private channels'
  missing = 'MissingPartition: Realtime was unable to find the expected messages partition'
  jwt     = 'InvalidJWTToken: Token expiration time is invalid'
  unknown = 'UnknownErrorOnChannel: boom'
}
$wExpected = @{ Z6 = 'authorization'; Z7 = 'private-only'; Z8 = 'authorization' }
$wLabels = @{ Z6 = 'anon oryn privado'; Z7 = 'anon público'; Z8 = 'anon privado qualquer' }
# Reproduz o expectRefused do harness: anotação com [motivo; esperado; veredito] e ✓ só com PASS.
function New-HarnessZ([string]$Z, [string]$Status, [string]$Reason = '') {
  $outcome = Get-JoinOutcome $Status $Reason
  $verdict = Get-RefusalVerdict $outcome $wExpected[$Z]
  [pscustomobject]@{ Z = $Z; Marker = $(if ($verdict -eq 'PASS') { '✓' } else { '×' })
    Note = "$($wLabels[$Z]): $Status$(if ($Reason) { " ($Reason)" }) [motivo=$outcome; esperado=$($wExpected[$Z]); veredito=$verdict]" }
}
function New-WReport([object[]]$Zs) {
  $names = @{ Z6 = 'Z6 anon não assina oryn:s:<uuid> privado (Unauthorized)'; Z7 = 'Z7 anon não assina tópico qualquer com private:false (PrivateOnly)'; Z8 = 'Z8 anon não assina tópico qualquer com private:true (Unauthorized)' }
  ' ↓ tests/remote/integration.remote.test.ts > Supabase real — C0-R: sem identidade, REST (chave publicável) > Z1 Auth'
  foreach ($z in $Zs) {
    " $($z.Marker) tests/remote/integration.remote.test.ts > $wBlock > $($names[$z.Z]) 300ms"; ''
    if ($z.Note) { '   ❯ tests/remote/integration.remote.test.ts:199:15 notice'; "     ↳ $($z.Note)"; '' }
  }
  " □ tests/remote/integration.remote.test.ts > $wBlock > Z9 depois de Z6–Z8"
  $p = @($Zs | Where-Object Marker -eq '✓').Count; $f = @($Zs | Where-Object Marker -eq '×').Count
  " Test Files  1 $(if ($f) { 'failed' } else { 'passed' }) (1)"
  "      Tests  $(if ($f) { "$f failed | " })$p passed | 39 skipped | 1 todo (43)"
}
$goodZ = @{ Z6 = (New-HarnessZ Z6 CHANNEL_ERROR $R.authz); Z7 = (New-HarnessZ Z7 CHANNEL_ERROR $R.private); Z8 = (New-HarnessZ Z8 CHANNEL_ERROR $R.authz) }
function With([string]$Z, $Replacement) { foreach ($k in 'Z6', 'Z7', 'Z8') { if ($k -eq $Z) { $Replacement } else { $goodZ[$k] } } }
function VerdictOf($lines) { $r = Test-C0Report -Lines $lines -Mode W; [pscustomobject]@{ All = $r.Verdict; Z = @{ Z6 = $r.PerZ[0].Verdict; Z7 = $r.PerZ[1].Verdict; Z8 = $r.PerZ[2].Verdict }; Ok = $r.Ok; R = $r } }
$okW = New-WReport (With '' $null)

Check 'classificação (espelho do harness): motivos reais e correspondência estrita' {
  # Pares (não hashtable: as chaves do PowerShell ignoram maiúsculas, e a diferença de caixa é um dos casos).
  $cases = @(
    @($R.authz, 'authorization'), @('Unauthorized: You do not have permissions to read from this Channel topic', 'authorization'),
    @('Unauthorized: You do not have permissions to read from this Channel topic: it-token-jwt', 'authorization'),
    @($R.private, 'private-only'), @($R.missing, 'infrastructure'), @('RealtimeRestarting: Realtime is restarting, please standby', 'infrastructure'),
    @('Realtime was unable to connect to the project database', 'infrastructure'), @($R.jwt, 'credential'), @('MalformedJWT: x', 'credential'),
    @('Unauthorized: something else', 'unknown'), @('PrivateOnly: This project only allows private channels, mostly', 'unknown'),
    @('unauthorized: You do not have permissions to read from this Channel topic', 'unknown'),
    @('error: Unauthorized: You do not have permissions to read from this Channel topic', 'unknown'), @($R.unknown, 'unknown'), @('', 'unknown')
  )
  foreach ($c in $cases) { $got = Get-RefusalKind $c[0]; if ($got -cne $c[1]) { throw "'$($c[0])' → $got (esperado $($c[1]))" } }
}
Check 'C0-W: Z6/Z8 Unauthorized e Z7 PrivateOnly = PASS (também no formato do console do operador)' {
  foreach ($l in @($okW, (ConvertTo-OperatorConsole $okW))) {
    $v = VerdictOf $l; if (-not $v.Ok -or $v.All -ne 'PASS' -or $v.R.ZFound -ne 'Z6,Z7,Z8') { throw ($v.R | ConvertTo-Json -Compress -Depth 4) }
  }
}
Check 'C0-W: Unauthorized só passa onde é esperado (no Z7 = FAIL)' {
  $v = VerdictOf (New-WReport (With Z7 (New-HarnessZ Z7 CHANNEL_ERROR $R.authz)))
  if ($v.Z.Z7 -ne 'FAIL' -or $v.All -ne 'FAIL') { throw "Z7=$($v.Z.Z7) total=$($v.All)" }
}
Check 'C0-W: PrivateOnly só passa onde é esperado (no Z6 e no Z8 = FAIL)' {
  foreach ($z in 'Z6', 'Z8') { $v = VerdictOf (New-WReport (With $z (New-HarnessZ $z CHANNEL_ERROR $R.private))); if ($v.Z[$z] -ne 'FAIL' -or $v.All -ne 'FAIL') { throw "$z=$($v.Z[$z]) total=$($v.All)" } }
}
Check 'C0-W: MissingPartition nunca é PASS (INCONCLUSIVO em cada Z; ✓ forjado = FAIL)' {
  foreach ($z in 'Z6', 'Z7', 'Z8') {
    $v = VerdictOf (New-WReport (With $z (New-HarnessZ $z CHANNEL_ERROR $R.missing)))
    if ($v.Z[$z] -ne 'INCONCLUSIVO' -or $v.All -ne 'INCONCLUSIVO' -or $v.Ok) { throw "$z=$($v.Z[$z]) total=$($v.All)" }
    $forged = New-HarnessZ $z CHANNEL_ERROR $R.missing; $forged.Marker = '✓'
    $v = VerdictOf (New-WReport (With $z $forged)); if ($v.Z[$z] -ne 'FAIL' -or $v.Ok) { throw "✓ forjado $z=$($v.Z[$z])" }
  }
}
Check 'C0-W: erro de credencial e motivo desconhecido não aprovam Z6–Z8 (INCONCLUSIVO)' {
  foreach ($reason in $R.jwt, $R.unknown) { foreach ($z in 'Z6', 'Z7', 'Z8') {
    $v = VerdictOf (New-WReport (With $z (New-HarnessZ $z CHANNEL_ERROR $reason))); if ($v.Z[$z] -ne 'INCONCLUSIVO' -or $v.Ok) { throw "$z com '$reason' = $($v.Z[$z])" }
  } }
}
Check 'C0-W: SUBSCRIBED reprova cada um dos três (FAIL)' {
  foreach ($z in 'Z6', 'Z7', 'Z8') { $v = VerdictOf (New-WReport (With $z (New-HarnessZ $z SUBSCRIBED))); if ($v.Z[$z] -ne 'FAIL' -or $v.All -ne 'FAIL') { throw "$z=$($v.Z[$z]) total=$($v.All)" } }
}
Check 'C0-W: TIMED_OUT, NO_REPLY e CLOSED não aprovam (INCONCLUSIVO)' {
  foreach ($st in 'TIMED_OUT', 'NO_REPLY', 'CLOSED') { foreach ($z in 'Z6', 'Z7', 'Z8') {
    $v = VerdictOf (New-WReport (With $z (New-HarnessZ $z $st))); if ($v.Z[$z] -ne 'INCONCLUSIVO' -or $v.Ok) { throw "$z $st = $($v.Z[$z])" }
  } }
}
Check 'C0-W: FAIL prevalece sobre INCONCLUSIVO no total' {
  $zs = @((New-HarnessZ Z6 CHANNEL_ERROR $R.missing), (New-HarnessZ Z7 SUBSCRIBED), $goodZ.Z8)
  $v = VerdictOf (New-WReport $zs); if ($v.All -ne 'FAIL') { throw "total=$($v.All)" }
}
Check 'C0-W: incoerências = FAIL (harness diz PASS mas o texto é outro; ✓ sem anotação; anotação ✓ sem veredito)' {
  $lie = [pscustomobject]@{ Z = 'Z6'; Marker = '✓'; Note = "anon oryn privado: CHANNEL_ERROR ($($R.missing)) [motivo=authorization; esperado=authorization; veredito=PASS]" }
  if ((VerdictOf (New-WReport (With Z6 $lie))).Z.Z6 -ne 'FAIL') { throw 'aceitou harness incoerente com o texto' }
  $bare = [pscustomobject]@{ Z = 'Z7'; Marker = '✓'; Note = '' }
  if ((VerdictOf (New-WReport (With Z7 $bare))).Z.Z7 -ne 'FAIL') { throw 'aceitou ✓ sem anotação' }
}
Check 'C0-W: × sem anotação (teste parou antes de decidir) = INCONCLUSIVO; Z ausente = FAIL' {
  $v = VerdictOf (New-WReport (With Z8 ([pscustomobject]@{ Z = 'Z8'; Marker = '×'; Note = '' })))
  if ($v.Z.Z8 -ne 'INCONCLUSIVO') { throw "× sem anotação = $($v.Z.Z8)" }
  $v = VerdictOf (New-WReport @($goodZ.Z6, $goodZ.Z7)); if ($v.Z.Z8 -ne 'FAIL' -or $v.All -ne 'FAIL') { throw "Z8 ausente = $($v.Z.Z8)/$($v.All)" }
}
Check 'C0-W: Z1–Z4 também aprovados (filtro esquecido) reprova' {
  $l = @($okR | Select-Object -Index 1, 3, 4, 5) + $okW -replace '3 passed \|', '7 passed |'
  $r = Test-C0Report -Lines $l -Mode W; if ($r.Ok -or $r.Outside -ne 4 -or $r.Verdict -ne 'FAIL') { throw ($r | ConvertTo-Json -Compress -Depth 3) }
}
Check 'C0-W: 0 aprovados com exit 0 (sem ALLOW_WS) reprova' {
  $l = @(" ↓ tests/remote/integration.remote.test.ts > $wBlock > Z6 x", ' Test Files  1 skipped (1)', '      Tests  42 skipped | 1 todo (43)')
  $r = Test-C0Report -Lines $l -Mode W; if ($r.Ok -or $r.Verdict -ne 'FAIL') { throw 'aprovou sem testes' }
}

# --- sensíveis e resumo ---
Check 'sensíveis: só contagens; detecta JWT, chaves, PAT e a chave digitada' {
  $f = [IO.Path]::GetTempFileName()
  try {
    $key = 'sb_publishable_' + 'XyZ123abcDEF'
    $jwt = 'eyJhbGciOiJIUzI1NiJ9' + '.' + 'eyJzdWIiOiJ4eHh4In0' + '.sig'
    @('linha limpa', "vazou $key", "token $jwt", ('sbp_' + 'a1b2c3d4e5f6g7h8')) | Set-Content $f
    $s = Measure-Sensitive -Path $f -Literal $key
    if ($s.jwt -ne 1 -or $s.publishable -ne 1 -or $s.pat -ne 1 -or $s.chave_digitada -ne 1 -or $s.total -ne 4) { throw ($s | ConvertTo-Json -Compress) }
    $clean = [IO.Path]::GetTempFileName(); try { 'nada aqui' | Set-Content $clean; if ((Measure-Sensitive -Path $clean -Literal $key).total -ne 0) { throw 'falso positivo' } } finally { Remove-Item $clean }
  } finally { Remove-Item $f }
}
Check 'resumo: normaliza, mascara UUID/JWT/chave, mantém resultados e anotações ↳' {
  $f = [IO.Path]::GetTempFileName()
  try {
    $lines = (ConvertTo-OperatorConsole $okW) + ' ✓ x > Z9 3f2b8c1e-9a4d-4e7b-8c2f-1a2b3c4d5e6f eyJabc.def sb_publishable_ABC123' + 'linha de log qualquer' + 'C0-W exit = 0'
    Write-SafeSummary -Lines $lines -Path $f
    $out = Get-Content $f -Raw -Encoding utf8
    if ($out -match '3f2b8c1e-|eyJabc|sb_publishable_ABC') { throw 'não mascarou' }
    if ($out -match 'linha de log qualquer|\x1b') { throw 'manteve linha que não é de resultado, ou ANSI' }
    if ($out -notmatch '<uuid>' -or $out -notmatch 'Tests\s+3 passed' -or $out -notmatch '↳ anon público: CHANNEL_ERROR' -or $out -notmatch 'C0-W exit = 0') { throw 'resumo incompleto' }
  } finally { Remove-Item $f }
}
Check 'Clear-OrynEnv: remove e não imprime valores' {
  $env:ORYN_PUBLISHABLE_KEY = 'VALOR-QUE-NAO-PODE-APARECER'
  $o = Clear-OrynEnv 6>&1 | Out-String
  if ($o -match 'VALOR-QUE-NAO') { throw 'vazou' }; if (Get-ChildItem Env:ORYN_* -ErrorAction SilentlyContinue) { throw 'sobrou' }
}

# --- exit code e console ---
Check 'Invoke-NativeTee: exit ≠ 0 de processo nativo preservado, saída gravada, sem exceção (ErrorAction Stop)' {
  $d = Join-Path ([IO.Path]::GetTempPath()) ('oryn-c0-tee-' + [guid]::NewGuid().ToString('n').Substring(0, 8)); New-Item -ItemType Directory $d | Out-Null
  try {
    $pw = (Get-Process -Id $PID).Path
    $code = Invoke-NativeTee -Report (Join-Path $d 'r.txt') -Command { & $pw -NoProfile -Command "Write-Output 'linha-1'; [Console]::Error.WriteLine('erro-2'); exit 3" } 6>$null
    if ($code -isnot [int] -or $code -ne 3) { throw "código $code" }
    $txt = Get-Content (Join-Path $d 'r.txt') -Raw
    if ($txt -notmatch 'linha-1' -or $txt -notmatch 'erro-2') { throw "relatório incompleto: $txt" }
    $zero = Invoke-NativeTee -Report (Join-Path $d 'z.txt') -Command { & $pw -NoProfile -Command 'exit 0' } 6>$null
    if ($zero -ne 0) { throw "código zero virou $zero" }
  } finally { Remove-Item -Recurse -Force $d }
}
Check 'Invoke-NativeTee: pasta inexistente aborta ANTES de executar' {
  Throws { Invoke-NativeTee -Report (Join-Path ([IO.Path]::GetTempPath()) 'nao-existe-oryn\r.txt') -Command { throw 'executou' } } 'inexistente'
}
Check 'Enter/Exit-PlainConsole: NO_COLOR e codificação restaurados' {
  $before = $env:NO_COLOR; $enc = [Console]::OutputEncoding.CodePage
  $s = Enter-PlainConsole
  if ($env:NO_COLOR -ne '1' -or [Console]::OutputEncoding.CodePage -ne 65001) { throw 'não aplicou' }
  Exit-PlainConsole $s
  if ($env:NO_COLOR -ne $before -or [Console]::OutputEncoding.CodePage -ne $enc) { throw 'não restaurou' }
}

# --- relatório REAL da 1ª C0-R (opcional; arquivo ignorado pelo Git) ---
if ($RealC0R) {
  Check 'C0-R REAL (console do operador): Ok, Z1–Z4, 0 fora' {
    $r = Test-C0Report -Lines @(Get-Content -LiteralPath $RealC0R -Encoding utf8) -Mode R
    if (-not $r.Ok -or $r.ZFound -ne 'Z1,Z2,Z3,Z4' -or $r.Outside -ne 0 -or $r.Passed -ne 4) { throw ($r | Select-Object Ok, Passed, ZFound, Outside, SummaryLine | ConvertTo-Json -Compress) }
    if ($r.PerZ[0].Note -notmatch 'external\.anonymous_users=false') { throw "anotação do Z1: $($r.PerZ[0].Note)" }
  }
}

# --- relatório REAL da 1ª C0-W (opcional; anterior ao 02C.6E, sem veredito do harness) ---
if ($RealC0W) {
  Check 'C0-W REAL reclassificada: Z6 INCONCLUSIVO (MissingPartition), Z7 FAIL (SUBSCRIBED), Z8 PASS (Unauthorized); total FAIL' {
    $r = Test-C0Report -Lines @(Get-Content -LiteralPath $RealC0W -Encoding utf8) -Mode W
    $got = ($r.PerZ | ForEach-Object { "$($_.Z)=$($_.Verdict)/$($_.Outcome)" }) -join ' '
    if ($got -ne 'Z6=INCONCLUSIVO/infrastructure Z7=FAIL/subscribed Z8=PASS/authorization' -or $r.Verdict -ne 'FAIL' -or $r.Ok) { throw "$got total=$($r.Verdict)" }
  }
}

$results
$fail =@($results | Where-Object { $_ -like 'FAIL*' }).Count
"--- $(@($results | Where-Object { $_ -like 'PASS*' }).Count) PASS / $fail FAIL"
exit $(if ($fail) { 1 } else { 0 })
