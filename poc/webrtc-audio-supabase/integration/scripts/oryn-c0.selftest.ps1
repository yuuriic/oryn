# ORYN — autoteste OFFLINE do executor C0 (02C.6A). Carrega só oryn-c0.lib.ps1 (funções); nenhuma rede, nenhum
# Supabase, nenhum Git de escrita. Uso: pwsh -NoProfile -File integration/scripts/oryn-c0.selftest.ps1 [-RealC0R <c0r.txt>]
param([string]$RealC0R)
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
function New-WReport([string[]]$Notes, [string]$Tests = '3 passed | 39 skipped | 1 todo (43)') {
  @(' ↓ tests/remote/integration.remote.test.ts > Supabase real — C0-R: sem identidade, REST (chave publicável) > Z1 Auth')
  $names = @('Z6 anon não assina oryn:s:<uuid> privado', 'Z7 anon não assina tópico qualquer com private:false', 'Z8 anon não assina tópico qualquer com private:true')
  for ($i = 0; $i -lt 3; $i++) {
    " ✓ tests/remote/integration.remote.test.ts > $wBlock > $($names[$i]) 300ms"; ''
    "   ❯ tests/remote/integration.remote.test.ts:195:15 notice"
    "     ↳ $($Notes[$i])"; ''
  }
  " □ tests/remote/integration.remote.test.ts > $wBlock > Z9 depois de Z6–Z8"
  ' Test Files  1 passed (1)'
  "      Tests  $Tests"
}
$authz = 'CHANNEL_ERROR (Unauthorized: You do not have permissions to read from this Channel topic: x)'
$okW = New-WReport @("anon oryn privado: $authz", "anon público: $authz", "anon privado qualquer: $authz")
Check 'C0-W: Z6–Z8 com recusa do servidor = Ok; motivo classificado' {
  $r = Test-C0Report -Lines $okW -Mode W
  if (-not $r.Ok -or $r.ZFound -ne 'Z6,Z7,Z8') { throw ($r | ConvertTo-Json -Compress -Depth 3) }
  if (@($r.PerZ | Where-Object Kind -ne 'autorização').Count) { throw 'classificação errada' }
}
Check 'C0-W: formato do console do operador = Ok' { if (-not (Test-C0Report -Lines (ConvertTo-OperatorConsole $okW) -Mode W).Ok) { throw 'reprovou' } }
Check 'C0-W: recusa por credencial é aceita e classificada como credencial' {
  $l = New-WReport @('anon oryn privado: CHANNEL_ERROR (invalid JWT: unable to parse)', "anon público: $authz", "anon privado qualquer: $authz")
  $r = Test-C0Report -Lines $l -Mode W; if (-not $r.Ok -or $r.PerZ[0].Kind -ne 'credencial') { throw ($r.PerZ | ConvertTo-Json -Compress) }
}
Check 'C0-W: ✓ com anotação TIMED_OUT/NO_REPLY/SUBSCRIBED reprova (timeout não é recusa)' {
  foreach ($st in 'TIMED_OUT', 'NO_REPLY', 'SUBSCRIBED', 'CLOSED') {
    if ((Test-C0Report -Lines (New-WReport @("anon oryn privado: $st", "anon público: $authz", "anon privado qualquer: $authz")) -Mode W).Ok) { throw "aprovou com $st" }
  }
}
Check 'C0-W: ✓ sem anotação reprova' {
  $l = @($okW | Where-Object { $_ -notmatch 'anon público' })
  if ((Test-C0Report -Lines $l -Mode W).Ok) { throw 'aprovou sem anotação do Z7' }
}
Check 'C0-W: Z1–Z4 também aprovados (filtro esquecido) reprova' {
  $l = @($okR | Select-Object -Index 1, 3, 4, 5) + $okW -replace '3 passed \|', '7 passed |'
  $r = Test-C0Report -Lines $l -Mode W; if ($r.Ok -or $r.Outside -ne 4) { throw ($r | ConvertTo-Json -Compress -Depth 3) }
}
Check 'C0-W: 0 aprovados com exit 0 (sem ALLOW_WS) reprova' {
  $l = @(" ↓ tests/remote/integration.remote.test.ts > $wBlock > Z6 x", ' Test Files  1 skipped (1)', '      Tests  42 skipped | 1 todo (43)')
  if ((Test-C0Report -Lines $l -Mode W).Ok) { throw 'aprovou sem testes' }
}
Check 'C0-W: Z7 falhou (Allow public access ligado) reprova' {
  $l = $okW -replace '^(\s*)✓(.*Z7 )', '$1×$2' -replace '3 passed \|', '2 passed | 1 failed |'
  if ((Test-C0Report -Lines $l -Mode W).Ok) { throw 'aprovou com Z7 falho' }
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

$results
$fail = @($results | Where-Object { $_ -like 'FAIL*' }).Count
"--- $(@($results | Where-Object { $_ -like 'PASS*' }).Count) PASS / $fail FAIL"
exit $(if ($fail) { 1 } else { 0 })
