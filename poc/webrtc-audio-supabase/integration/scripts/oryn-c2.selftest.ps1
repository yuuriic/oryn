# ORYN — autoteste OFFLINE do executor da C2 `password` (02C.7P-A). Carrega só oryn-c2.lib.ps1 (funções) e, no
# fim, roda o PRÓPRIO executor em modo não interativo para provar que ele aborta antes de qualquer pergunta e de
# qualquer rede. Nenhum Supabase, nenhum Git de escrita. Uso:
#   pwsh -NoProfile -File integration/scripts/oryn-c2.selftest.ps1
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'oryn-c2.lib.ps1')
$results = [System.Collections.Generic.List[string]]::new()
function Check([string]$name, [scriptblock]$body) {
  try { & $body; $results.Add("PASS  $name") } catch { $results.Add("FAIL  $name :: $($_.Exception.Message)") }
}
function Throws([scriptblock]$b, [string]$pattern) { try { & $b } catch { if ($_.Exception.Message -match $pattern) { return $_.Exception.Message } else { throw "erro inesperado: $($_.Exception.Message)" } }; throw 'não lançou' }
$esc = [char]27
$cp850 = [Text.Encoding]::GetEncoding(850)
function ConvertTo-OperatorConsole([string[]]$Lines) {
  $Lines | ForEach-Object { $cp850.GetString([Text.Encoding]::UTF8.GetBytes(("$esc[32m" + ($_ -replace ' > ', "$esc[2m > $esc[22m") + "$esc[39m"))) }
}

# --- relatório C2 sintético no formato REAL do Vitest 5 (--reporter=verbose; capturado no 02C.7P-A) ---
$file = 'tests/remote/integration.remote.test.ts'
$block = 'Supabase real — C2: sala de teste (convite + ORYN_IT_PARTITIONS_CONFIRMED=1)'
$R = @{
  authz   = 'Unauthorized: You do not have permissions to read from this Channel topic: oryn:s:<uuid>'
  private = 'PrivateOnly: This project only allows private channels'
  missing = 'MissingPartition: Realtime was unable to find the expected messages partition'
  jwt     = 'InvalidJWTToken: Token expiration time is invalid'
  unknown = 'UnknownErrorOnChannel: boom'
}
# Nomes reais do harness (describe > teste).
$names = [ordered]@{
  '#6/S1'                = 'inscrição em canais privados > #6/S1 o dono da sessão assina o próprio tópico privado'
  'A4'                   = 'inscrição em canais privados > A4 segundo cliente do MESMO usuário (outra aba) assina a própria sessão'
  '#6/S2/S3'             = 'inscrição em canais privados > #6/S2/S3 membro da MESMA sala não assina a sessão do outro; estranho também não'
  '#7/S5'                = 'inscrição em canais privados > #7/S5 o próprio tópico sem private:true é recusado ("Allow public access" desligado)'
  'S6'                   = 'inscrição em canais privados > S6 só a chave publicável (papel anon, sem JWT de usuário) não assina uma sessão viva'
  'S7'                   = 'inscrição em canais privados > S7 variações do próprio tópico são recusadas (maiúsculas, UUID maiúsculo, outro prefixo, sufixo)'
  'S8/P5'                = 'inscrição em canais privados > S8/P5 Presence no próprio tópico não se propaga'
  'A1'                   = 'sessão: revogação, expiração e isolamento > A1 depois de leave_room, a sessão não volta: nova assinatura recusada e touch_session negado'
  'A2/A3'                = 'sessão: revogação, expiração e isolamento > A2/A3 sem batimento por mais de 90 s a sessão vence; join_room a revoga como expired e a nova vale'
  '#11/D1'               = 'entrega pelo servidor e publicação por clientes > #11/D1 realtime.send (controle): hello chega ao destinatário e o cliente o aceita (id injetado + session_id + label)'
  'D2'                   = 'entrega pelo servidor e publicação por clientes > D2 leave_room publica bye só com session_id (+ id injetado)'
  '#8/P1'                = 'entrega pelo servidor e publicação por clientes > #8/P1 WebSocket: o cliente não entrega Broadcast no próprio tópico oryn:*'
  '#8/P2/P3'             = 'entrega pelo servidor e publicação por clientes > #8/P2/P3 REST: nem o JWT de outro usuário nem a chave publicável entregam no tópico (minúsculo e maiúsculo)'
  'D3'                   = 'entrega pelo servidor e publicação por clientes > D3 sessão revogada com o canal ainda aberto não recebe hello; a sessão viva recebe (controle)'
  '#18 M5'               = 'concorrência > #18 M5: 5 join_room SIMULTÂNEOS do mesmo usuário → no máximo 2 sessões vivas'
  '#18 authorize_signal' = 'concorrência > #18 authorize_signal: 5 repetições SIMULTÂNEAS do mesmo client_msg_id → mesmo msg_id, sem erro bruto'
  '#15 HTTP'             = 'concorrência > #15 HTTP: 5 resgates SIMULTÂNEOS do mesmo convite → exatamente 1 sucesso'
}
$labels = @{ '#6/S2/S3' = @('membro', 'estranho'); '#7/S5' = @('private:false'); 'S6' = @('anon'); 'S7' = @('ORYN:S:<uuid>', 'oryn:s:<UUID>', 'oryn:x:<uuid>', 'oryn:s:<uuid>:x'); 'A1' = @('revogada'); 'A2/A3' = @('vencida', 'vencida depois do join_room') }
# B3 (02C.7P-C): motivos esperados e anotações LITERAIS, como o harness os escreve. Nenhuma função da lib
# (Get-JoinOutcome, Get-RefusalVerdict, a tabela C2Tests) participa da montagem dos fixtures.
$az = 'authorization'
$expectedOf = @{ '#6/S2/S3' = @($az, $az); '#7/S5' = @('private-only'); 'S6' = @($az); 'S7' = @($az, $az, $az, $az); 'A1' = @($az); 'A2/A3' = @($az, $az) }
$kindOf = @{ 'S8/P5' = 'presence'; '#15 HTTP' = 'skip' }; foreach ($k in $expectedOf.Keys) { $kindOf[$k] = 'refusal' }
$spec = Get-C2Spec

# Anotação do expectRefused (harness): rótulo, estado, motivo e [motivo; esperado; veredito], tudo literal.
function Note([string]$Label, [string]$Status, [string]$Reason, [string]$Motivo, [string]$Esperado, [string]$Veredito) {
  "${Label}: $Status$(if ($Reason) { " ($Reason)" }) [motivo=$Motivo; esperado=$Esperado; veredito=$Veredito]"
}
# Um teste: marcador, anotações, linha de erro (→) e nota de pulo.
function T([string]$Id, [string]$Marker = '✓', [string[]]$Notes = @(), [string]$Err = '', [string]$Skip = '') { [pscustomobject]@{ Id = $Id; Marker = $Marker; Notes = $Notes; Err = $Err; Skip = $Skip } }
function GoodRefusal([string]$Id) { $exp = $expectedOf[$Id]; T $Id '✓' @(for ($i = 0; $i -lt $exp.Count; $i++) { Note $labels[$Id][$i] 'CHANNEL_ERROR' $(if ($exp[$i] -eq 'private-only') { $R.private } else { $R.authz }) $exp[$i] $exp[$i] 'PASS' }) }
function GoodTest([string]$Id) {
  switch ($kindOf[$Id]) {
    'refusal' { GoodRefusal $Id }
    'presence' { T $Id '✓' @("observador: CHANNEL_ERROR ($($R.authz))", 'rastreador: SUBSCRIBED', 'track() = ok') }
    'skip' { T $Id '↓' @() '' $spec.SkipNote }
    default { if ($Id -eq '#8/P1') { T $Id '✓' @('send() com ack = error') } else { T $Id } }
  }
}
function New-C2Report([object[]]$Tests, [switch]$NoSummary, [switch]$SuiteFailed, [int]$PassedOverride = -1) {
  ' RUN  v5.0.5 C:/Dev/Projeto - Oryn/poc/webrtc-audio-supabase'
  ''
  " ↓ $file > Supabase real — C0-R: sem identidade, REST (chave publicável) > Z1 Auth: cadastro anônimo DESLIGADO"
  foreach ($t in $Tests) {
    $dur = if ($t.Marker -eq '↓') { ' 0ms' } else { ' 812ms' }
    " $($t.Marker) $file > $block > $($names[$t.Id])$dur$(if ($t.Skip) { " [$($t.Skip)]" })"
    if ($t.Err) { "   → $($t.Err)" }
    if ($t.Notes.Count) { ''; foreach ($n in $t.Notes) { "   ❯ ${file}:461:7 notice"; "     ↳ $n" }; '' }
  }
  if ($SuiteFailed) { ''; '⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯'; ''; " FAIL  $file > $block"; 'Error: login OWNER falhou: Invalid login credentials' }
  if ($NoSummary) { return }
  $p = @($Tests | Where-Object Marker -eq '✓').Count; $f = @($Tests | Where-Object Marker -eq '×').Count
  if ($PassedOverride -ge 0) { $p = $PassedOverride }
  ''
  " Test Files  1 $(if ($f -or $SuiteFailed) { 'failed' } else { 'passed' }) (1)"
  "      Tests  $(if ($f) { "$f failed | " })$p passed | 26 skipped | 10 todo (53)"
}
$good = @($names.Keys | ForEach-Object { GoodTest $_ })
function With([string]$Id, $Replacement) { foreach ($t in $good) { if ($t.Id -eq $Id) { $Replacement } else { $t } } }
function VerdictOf($lines) { $r = Test-C2Report -Lines $lines; $by = @{}; foreach ($t in $r.PerTest) { $by[$t.Id] = $t }; [pscustomobject]@{ All = $r.Verdict; Ok = $r.Ok; T = $by; R = $r } }
$okReport = New-C2Report $good

# --- especificação ---
Check 'spec: 17 testes, 16 a aprovar, #15 pulado; ids únicos; S5 é o único PrivateOnly' {
  if ($spec.Tests.Count -ne 17 -or $spec.PassCount -ne 16) { throw "$($spec.Tests.Count)/$($spec.PassCount)" }
  if (@($spec.Tests.Id | Sort-Object -Unique).Count -ne 17) { throw 'ids repetidos' }
  $po = @($spec.Tests | Where-Object { $_.Expected -contains 'private-only' } | ForEach-Object Id)
  if (($po -join ',') -ne '#7/S5') { throw "PrivateOnly em: $po" }
}
Check 'spec (B3): tipos e motivos esperados da lib = tabela LITERAL deste autoteste' {
  foreach ($t in $spec.Tests) {
    $kind = if ($kindOf.ContainsKey($t.Id)) { $kindOf[$t.Id] } else { 'positive' }
    if ($t.Kind -ne $kind) { throw "$($t.Id): $($t.Kind) ≠ $kind" }
    $exp = if ($t.Kind -eq 'refusal') { $expectedOf[$t.Id] -join ',' } elseif ($t.Kind -eq 'presence') { 'observador,rastreador' } else { '' }
    if (($t.Expected -join ',') -cne $exp) { throw "$($t.Id): $($t.Expected -join ',') ≠ $exp" }
  }
}

# --- relatório: PASS ---
Check 'C2: 16 PASS + #15 pulado pela nota exata = PASS (também no console do operador: ANSI + cp850)' {
  foreach ($l in @($okReport, (ConvertTo-OperatorConsole $okReport))) {
    $v = VerdictOf $l; if (-not $v.Ok -or $v.All -ne 'PASS') { throw (($v.R.PerTest | Where-Object Verdict -ne 'PASS' | ForEach-Object { "$($_.Id)=$($_.Verdict) $($_.Why)" }) -join '; ') }
  }
}
Check 'C2: anotações informativas (send/httpSend/track) não contam como recusa' {
  $v = VerdictOf (New-C2Report (With '#8/P2/P3' (T '#8/P2/P3' '✓' @('JWT do membro, minúsculo: recusado: x', 'chave publicável, maiúsculo: aceito (202)'))))
  if ($v.All -ne 'PASS') { throw $v.All }
}
Check 'C2: S8/P5 com as duas entradas aceitas também é PASS' {
  $v = VerdictOf (New-C2Report (With 'S8/P5' (T 'S8/P5' '✓' @('observador: SUBSCRIBED', 'rastreador: SUBSCRIBED', 'track() = ok'))))
  if ($v.All -ne 'PASS') { throw "$($v.All) $($v.T['S8/P5'].Why)" }
}
Check 'C2 (B1): S8/P5 ✓ sem exatamente 1 observador e 1 rastreador = FAIL (2× observador, 2× rastreador, só um, 3 notas)' {
  foreach ($notes in @(@('observador: SUBSCRIBED', 'observador: SUBSCRIBED'), @('rastreador: SUBSCRIBED', 'rastreador: SUBSCRIBED'),
      @('observador: SUBSCRIBED'), @('observador: SUBSCRIBED', 'rastreador: SUBSCRIBED', 'rastreador: SUBSCRIBED'))) {
    $v = VerdictOf (New-C2Report (With 'S8/P5' (T 'S8/P5' '✓' ($notes + 'track() = ok'))))
    if ($v.T['S8/P5'].Verdict -ne 'FAIL' -or $v.Ok) { throw "$($notes -join ' | ') = $($v.T['S8/P5'].Verdict)" }
  }
}

# --- relatório: FAIL (decisão errada) ---
Check 'C2: SUBSCRIBED em cada teste de recusa = FAIL' {
  foreach ($id in '#6/S2/S3', '#7/S5', 'S6', 'S7', 'A1', 'A2/A3') {
    $n = Note $labels[$id][0] 'SUBSCRIBED' '' 'subscribed' $expectedOf[$id][0] 'FAIL'
    $v = VerdictOf (New-C2Report (With $id (T $id '×' @($n) 'estado: expected ''SUBSCRIBED'' to be ''CHANNEL_ERROR''')))
    if ($v.T[$id].Verdict -ne 'FAIL' -or $v.All -ne 'FAIL') { throw "$id=$($v.T[$id].Verdict)/$($v.All)" }
  }
}
Check 'C2: motivo de acesso trocado = FAIL (Unauthorized no S5; PrivateOnly no S6 e no S2/S3)' {
  $cases = @(@('#7/S5', 'private:false', $R.authz, $az, 'private-only'), @('S6', 'anon', $R.private, 'private-only', $az), @('#6/S2/S3', 'membro', $R.private, 'private-only', $az))
  foreach ($c in $cases) {
    $v = VerdictOf (New-C2Report (With $c[0] (T $c[0] '×' @(Note $c[1] 'CHANNEL_ERROR' $c[2] $c[3] $c[4] 'FAIL') 'motivo')))
    if ($v.T[$c[0]].Verdict -ne 'FAIL' -or $v.All -ne 'FAIL') { throw "$($c[0])=$($v.T[$c[0]].Verdict)" }
  }
}
Check 'C2: segunda recusa do S2/S3 (estranho) aceita = FAIL mesmo com a primeira PASS' {
  $notes = @((Note 'membro' 'CHANNEL_ERROR' $R.authz $az $az 'PASS'), (Note 'estranho' 'SUBSCRIBED' '' 'subscribed' $az 'FAIL'))
  $v = VerdictOf (New-C2Report (With '#6/S2/S3' (T '#6/S2/S3' '×' $notes 'estado'))); if ($v.T['#6/S2/S3'].Verdict -ne 'FAIL') { throw $v.T['#6/S2/S3'].Verdict }
}
Check 'C2: S8/P5 com PrivateOnly num canal privado = FAIL; presença propagada (× sem motivo) = FAIL' {
  $v = VerdictOf (New-C2Report (With 'S8/P5' (T 'S8/P5' '×' @("observador: CHANNEL_ERROR ($($R.private))", 'rastreador: SUBSCRIBED') 'motivo')))
  if ($v.T['S8/P5'].Verdict -ne 'FAIL') { throw "PrivateOnly: $($v.T['S8/P5'].Verdict)" }
  $v = VerdictOf (New-C2Report (With 'S8/P5' (T 'S8/P5' '×' @('observador: SUBSCRIBED', 'rastreador: SUBSCRIBED', 'track() = ok') 'expected 1 to be +0')))
  if ($v.T['S8/P5'].Verdict -ne 'FAIL') { throw "propagada: $($v.T['S8/P5'].Verdict)" }
}
Check 'C2: positivo reprovado sem timeout (entrega, concorrência, acesso legítimo) = FAIL' {
  foreach ($id in '#6/S1', '#11/D1', 'D3', '#18 M5', '#8/P1') {
    $v = VerdictOf (New-C2Report (With $id (T $id '×' @() 'expected false to be true'))); if ($v.T[$id].Verdict -ne 'FAIL' -or $v.All -ne 'FAIL') { throw "$id=$($v.T[$id].Verdict)" }
  }
}
Check 'C2: recusa com todas as anotações PASS mas × por outra asserção (touch_session) = FAIL' {
  $v = VerdictOf (New-C2Report (With 'A1' (T 'A1' '×' @(Note 'revogada' 'CHANNEL_ERROR' $R.authz $az $az 'PASS') "expected null to be 'session-invalid'")))
  if ($v.T['A1'].Verdict -ne 'FAIL') { throw $v.T['A1'].Verdict }
}

# --- relatório: incoerências e estrutura ---
Check 'C2: ✓ forjado com MissingPartition, ✓ com recusas a menos e ✓ sem anotação = FAIL' {
  $v = VerdictOf (New-C2Report (With 'S6' (T 'S6' '✓' @(Note 'anon' 'CHANNEL_ERROR' $R.missing 'infrastructure' $az 'INCONCLUSIVO'))))
  if ($v.T['S6'].Verdict -ne 'FAIL') { throw "forjado: $($v.T['S6'].Verdict)" }
  $three = @((GoodRefusal 'S7').Notes | Select-Object -First 3)
  $v = VerdictOf (New-C2Report (With 'S7' (T 'S7' '✓' $three))); if ($v.T['S7'].Verdict -ne 'FAIL') { throw "3 de 4: $($v.T['S7'].Verdict)" }
  $v = VerdictOf (New-C2Report (With 'A1' (T 'A1' '✓'))); if ($v.T['A1'].Verdict -ne 'FAIL') { throw "sem anotação: $($v.T['A1'].Verdict)" }
}
Check 'C2: harness diz PASS mas o texto do servidor é outro, ou espera outro motivo = FAIL' {
  $lie = "anon: CHANNEL_ERROR ($($R.missing)) [motivo=authorization; esperado=authorization; veredito=PASS]"
  if ((VerdictOf (New-C2Report (With 'S6' (T 'S6' '✓' @($lie))))).T['S6'].Verdict -ne 'FAIL') { throw 'aceitou harness incoerente' }
  $other = "private:false: CHANNEL_ERROR ($($R.authz)) [motivo=authorization; esperado=authorization; veredito=PASS]"
  if ((VerdictOf (New-C2Report (With '#7/S5' (T '#7/S5' '✓' @($other))))).T['#7/S5'].Verdict -ne 'FAIL') { throw 'aceitou esperado divergente' }
}
Check 'C2: #15 executado, pulado sem nota ou com outra nota = FAIL' {
  foreach ($bad in @((T '#15 HTTP' '✓'), (T '#15 HTTP' '↓'), (T '#15 HTTP' '↓' @() '' 'outro motivo'), (T '#15 HTTP' '×' @() 'IdentityBudgetExceeded'))) {
    $v = VerdictOf (New-C2Report (With '#15 HTTP' $bad)); if ($v.T['#15 HTTP'].Verdict -ne 'FAIL' -or $v.Ok) { throw "#15 $($bad.Marker)/$($bad.Skip) = $($v.T['#15 HTTP'].Verdict)" }
  }
}
Check 'C2: teste ausente, duplicado, ou aprovado fora do bloco = FAIL' {
  $v = VerdictOf (New-C2Report @($good | Where-Object Id -ne 'D2')); if ($v.T['D2'].Verdict -ne 'FAIL' -or $v.All -ne 'FAIL') { throw "ausente: $($v.T['D2'].Verdict)" }
  $v = VerdictOf (New-C2Report ($good + (GoodTest 'D2'))); if ($v.T['D2'].Verdict -ne 'FAIL') { throw "duplicado: $($v.T['D2'].Verdict)" }
  $l = @($okReport) + " ✓ $file > Supabase real — C1: sem sala (só cadastro anônimo) > #4 RPC sem JWT de usuário 50ms"
  $v = VerdictOf $l; if ($v.All -ne 'FAIL' -or $v.R.Outside -ne 1) { throw "fora do bloco: $($v.All)/$($v.R.Outside)" }
}
Check 'C2: resumo do Vitest incoerente (15 passed) ou ausente com tudo ✓ não aprova' {
  $v = VerdictOf (New-C2Report $good -PassedOverride 15); if ($v.Ok -or $v.All -ne 'FAIL') { throw "15 passed: $($v.All)" }
  $v = VerdictOf (New-C2Report $good -NoSummary); if ($v.Ok -or $v.All -eq 'PASS') { throw "sem resumo: $($v.All)" }
}
Check 'C2: portão abortou (0 testes, arquivo FAIL) = FAIL' {
  $l = @(' RUN  v5.0.5 x', " FAIL  $file [ $file ]", 'RemoteConfigError: ORYN_IT_USER_OWNER_PASSWORD ausente', ' Test Files  1 failed (1)', '      Tests  no tests')
  $v = VerdictOf $l; if ($v.Ok -or $v.All -ne 'FAIL') { throw $v.All }
}

# --- relatório: INCONCLUSIVO ---
Check 'C2: MissingPartition, credencial e motivo desconhecido numa recusa = INCONCLUSIVO (× para no ponto)' {
  foreach ($c in @(@($R.missing, 'infrastructure'), @($R.jwt, 'credential'), @($R.unknown, 'unknown'))) {
    $notes = @((GoodRefusal 'S7').Notes | Select-Object -First 2) + (Note 'oryn:x:<uuid>' 'CHANNEL_ERROR' $c[0] $c[1] $az 'INCONCLUSIVO')
    $v = VerdictOf (New-C2Report (With 'S7' (T 'S7' '×' $notes 'motivo da recusa'))); if ($v.T['S7'].Verdict -ne 'INCONCLUSIVO' -or $v.All -ne 'INCONCLUSIVO' -or $v.Ok) { throw "'$($c[0])' = $($v.T['S7'].Verdict)/$($v.All)" }
  }
}
Check 'C2: TIMED_OUT, NO_REPLY e CLOSED numa recusa = INCONCLUSIVO' {
  foreach ($c in @(@('TIMED_OUT', 'timeout'), @('NO_REPLY', 'timeout'), @('CLOSED', 'transport'))) {
    $v = VerdictOf (New-C2Report (With 'A1' (T 'A1' '×' @(Note 'revogada' $c[0] '' $c[1] $az 'INCONCLUSIVO') 'estado')))
    if ($v.T['A1'].Verdict -ne 'INCONCLUSIVO') { throw "$($c[0]) = $($v.T['A1'].Verdict)" }
  }
}
Check 'C2: timeout do Vitest (A2/A3 depois da 1ª recusa; positivo; S8) = INCONCLUSIVO' {
  $to = 'Test timed out in 180000ms.'
  $v = VerdictOf (New-C2Report (With 'A2/A3' (T 'A2/A3' '×' @(Note 'vencida' 'CHANNEL_ERROR' $R.authz $az $az 'PASS') $to)))
  if ($v.T['A2/A3'].Verdict -ne 'INCONCLUSIVO' -or $v.All -ne 'INCONCLUSIVO') { throw "A2/A3 $($v.T['A2/A3'].Verdict)" }
  $v = VerdictOf (New-C2Report (With '#11/D1' (T '#11/D1' '×' @() 'Test timed out in 30000ms.'))); if ($v.T['#11/D1'].Verdict -ne 'INCONCLUSIVO') { throw "D1 $($v.T['#11/D1'].Verdict)" }
  $v = VerdictOf (New-C2Report (With 'S8/P5' (T 'S8/P5' '×' @("observador: CHANNEL_ERROR ($($R.missing))") 'motivo'))); if ($v.T['S8/P5'].Verdict -ne 'INCONCLUSIVO') { throw "S8 $($v.T['S8/P5'].Verdict)" }
}
Check 'C2: beforeAll falhou (login, convite) = INCONCLUSIVO em todos, nunca PASS' {
  $all = @($names.Keys | ForEach-Object { T $_ '↓' })
  $v = VerdictOf (New-C2Report $all -SuiteFailed)
  if ($v.All -ne 'INCONCLUSIVO' -or $v.Ok -or @($v.R.PerTest | Where-Object Verdict -ne 'INCONCLUSIVO').Count) { throw "$($v.All): $(($v.R.PerTest | ForEach-Object { "$($_.Id)=$($_.Verdict)" }) -join ' ')" }
}
Check 'C2: tudo pulado SEM falha de suíte (fase errada, filtro) = FAIL' {
  $v = VerdictOf (New-C2Report @($names.Keys | ForEach-Object { T $_ '↓' })); if ($v.All -ne 'FAIL') { throw $v.All }
}
Check 'C2: interrompido (Ctrl+C, sem resumo) = INCONCLUSIVO; com um FAIL antes da interrupção = FAIL' {
  $partial = @($good | Select-Object -First 6)
  $v = VerdictOf (New-C2Report $partial -NoSummary); if ($v.All -ne 'INCONCLUSIVO' -or $v.Ok) { throw "parcial: $($v.All)" }
  $bad = @($partial[0..4]) + (T 'S7' '×' @(Note 'ORYN:S:<uuid>' 'SUBSCRIBED' '' 'subscribed' $az 'FAIL') 'estado')
  $v = VerdictOf (New-C2Report $bad -NoSummary); if ($v.All -ne 'FAIL') { throw "parcial com FAIL: $($v.All)" }
}
Check 'C2: FAIL prevalece sobre INCONCLUSIVO' {
  $l = New-C2Report (@($good | ForEach-Object {
        if ($_.Id -eq 'S6') { T 'S6' '×' @(Note 'anon' 'CHANNEL_ERROR' $R.missing 'infrastructure' $az 'INCONCLUSIVO') 'motivo' }
        elseif ($_.Id -eq 'D2') { T 'D2' '×' @() 'expected false to be true' } else { $_ } }))
  if ((VerdictOf $l).All -ne 'FAIL') { throw 'INCONCLUSIVO venceu' }
}

# --- entradas (abortam ANTES de variáveis de ambiente e de rede; nunca citam valores) ---
$ok = @{ Ref = 'abcdefghijklmnopqrst'; Key = ('sb_publishable_' + 'AbC123_x-Y'); Invite = ('A' * 40 + 'b_-')
  Emails = @{ OWNER = 'dono+oryn@teste.example'; MEMBER = 'membro+oryn@teste.example'; STRANGER = 'estranho+oryn@teste.example' }
  Passwords = @{ OWNER = 'Senha-Longa-1!'; MEMBER = 'Senha-Longa-2!'; STRANGER = 'Senha-Longa-3!' } }
function Inputs([hashtable]$Over = @{}) { $h = @{}; foreach ($k in $ok.Keys) { $h[$k] = $ok[$k] }; foreach ($k in $Over.Keys) { $h[$k] = $Over[$k] }; Assert-C2Inputs @h }
Check 'entradas: conjunto válido passa' { Inputs }
Check 'entradas: ref, chave (inclusive sb_secret_), convite e e-mail inválidos abortam sem citar o valor' {
  $secretKey = 'sb_secret_' + 'NAO-PODE-APARECER'
  foreach ($c in @(@{ Ref = 'curto' }, @{ Key = $secretKey }, @{ Key = '' }, @{ Invite = 'abc' }, @{ Invite = ('A' * 42 + '!') },
      @{ Emails = @{ OWNER = 'sem-arroba'; MEMBER = $ok.Emails.MEMBER; STRANGER = $ok.Emails.STRANGER } })) {
    $m = Throws { Inputs $c } 'formato'
    if ($m -match 'NAO-PODE-APARECER|sem-arroba|abc') { throw "vazou valor: $m" }
  }
}
Check 'entradas: senha vazia ou com espaço nas pontas aborta citando só o papel' {
  $m = Throws { Inputs @{ Passwords = @{ OWNER = 'x'; MEMBER = ''; STRANGER = 'y' } } } 'senha MEMBER vazia'
  $m = Throws { Inputs @{ Passwords = @{ OWNER = 'segredo-x '; MEMBER = 'a'; STRANGER = 'b' } } } 'senha OWNER com espaço'
  if ($m -match 'segredo-x') { throw 'vazou a senha' }
}
Check 'entradas: e-mails repetidos (inclusive por maiúsculas) abortam' {
  Throws { Inputs @{ Emails = @{ OWNER = 'a@t.example'; MEMBER = 'A@T.example'; STRANGER = 'c@t.example' } } } '3 contas DIFERENTES' | Out-Null
}
Check 'D0: só a data UTC de hoje passa' {
  $now = [datetime]::new(2026, 10, 28, 1, 30, 0, [DateTimeKind]::Utc)
  Assert-D0Date -Typed '2026-10-28' -UtcNow $now
  Throws { Assert-D0Date -Typed '2026-10-27' -UtcNow $now } 'D0 não confirmado' | Out-Null
  Throws { Assert-D0Date -Typed '28/10/2026' -UtcNow $now } 'D0 não confirmado' | Out-Null
}
Check 'B7: início entre 23:45 e 00:15 UTC aborta; fora da margem passa (também com horário local de -03)' {
  $at = { param($h, $m) [datetime]::new(2026, 10, 28, $h, $m, 0, [DateTimeKind]::Utc) }
  foreach ($ok in @(@(0, 15), @(12, 0), @(23, 44))) { Assert-UtcDayMargin -UtcNow (& $at $ok[0] $ok[1]) }
  foreach ($bad in @(@(23, 45), @(23, 59), @(0, 0), @(0, 14))) { Throws { Assert-UtcDayMargin -UtcNow (& $at $bad[0] $bad[1]) } 'virada do dia UTC' | Out-Null }
  $local = [datetimeoffset]::new(2026, 10, 28, 20, 50, 0, [timespan]::FromHours(-3))   # 23:50 UTC
  Throws { Assert-UtcDayMargin -UtcNow $local.UtcDateTime } 'virada' | Out-Null
}

# --- convite (G6) ---
Check 'convite: prazo — recente passa; com menos de 2 min restantes, vencido, no futuro ou ilegível aborta' {
  $now = [datetime]::new(2026, 10, 28, 12, 0, 0, [DateTimeKind]::Utc)
  Assert-InviteFresh -IssuedUtc '2026-10-28 11:59:00+00' -UtcNow $now
  Assert-InviteFresh -IssuedUtc '2026-10-28T11:52:00Z' -UtcNow $now          # 8 min: restam 2
  Assert-InviteFresh -IssuedUtc '2026-10-28 11:55:30.123456' -UtcNow $now    # sem fuso = UTC
  Throws { Assert-InviteFresh -IssuedUtc '2026-10-28T11:51:00Z' -UtcNow $now } 'perto de vencer' | Out-Null
  Throws { Assert-InviteFresh -IssuedUtc '2026-10-28T10:00:00Z' -UtcNow $now } 'vencido' | Out-Null
  Throws { Assert-InviteFresh -IssuedUtc '2026-10-28T12:05:00Z' -UtcNow $now } 'futuro' | Out-Null
  Throws { Assert-InviteFresh -IssuedUtc 'ontem' -UtcNow $now } 'ilegível' | Out-Null
  # Horário local de Brasília (-03) digitado com o fuso: convertido corretamente.
  Assert-InviteFresh -IssuedUtc '2026-10-28T08:59:00-03:00' -UtcNow $now
}
Check 'convite: impressão = 16 hex do SHA-256 (mesma função do token_hash do banco); determinística' {
  if ((Get-InviteFingerprint 'abc') -cne 'ba7816bf8f01cfea') { throw (Get-InviteFingerprint 'abc') }
  if ((Get-InviteFingerprint $ok.Invite) -cne (Get-InviteFingerprint $ok.Invite) -or (Get-InviteFingerprint 'abd') -eq (Get-InviteFingerprint 'abc')) { throw 'não determinística ou colidiu' }
}
Check 'convite: reuso entre execuções aborta; impressão nova passa; raiz sem execuções passa' {
  $root = Join-Path ([IO.Path]::GetTempPath()) ('oryn-c2-inv-' + [guid]::NewGuid().ToString('n').Substring(0, 8))
  New-Item -ItemType Directory -Path (Join-Path $root 'c2pw-20261028-0100') -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $root 'c0-w-20261028-0114') -Force | Out-Null
  try {
    Assert-InviteNotReused -EvidenceRoot $root -Fingerprint 'aaaaaaaaaaaaaaaa'
    'aaaaaaaaaaaaaaaa' | Set-Content (Join-Path $root 'c2pw-20261028-0100\convite.impressao') -Encoding utf8
    Throws { Assert-InviteNotReused -EvidenceRoot $root -Fingerprint 'aaaaaaaaaaaaaaaa' } 'já foi usado' | Out-Null
    Assert-InviteNotReused -EvidenceRoot $root -Fingerprint 'bbbbbbbbbbbbbbbb'
  } finally { Remove-Item -Recurse -Force $root }
}

# --- ambiente ---
Check 'ambiente: conjunto ORYN_* exato da C2 password (14); orçamento, CAPTCHA, ALLOW_WS ou falta do convite reprovam' {
  $n = $spec.EnvNames
  if ($n.Count -ne 14) { throw "$($n.Count) nomes" }
  Assert-OrynEnvSet -Actual $n -Expected $n
  foreach ($extra in 'ORYN_IT_IDENTITY_BUDGET', 'ORYN_CAPTCHA_MODE', 'ORYN_IT_ALLOW_WS') { Throws { Assert-OrynEnvSet -Actual ($n + $extra) -Expected $n } 'diferentes' | Out-Null }
  Throws { Assert-OrynEnvSet -Actual @($n | Where-Object { $_ -ne 'ORYN_IT_CREATOR_INVITE' }) -Expected $n } 'diferentes' | Out-Null
}

# --- sigilo ---
$secretsFixture = @($ok.Passwords.Values) + $ok.Invite
Check 'sensíveis: contam senha, convite, chave e e-mails digitados (só contagens)' {
  $f = [IO.Path]::GetTempFileName()
  try {
    @('limpa', "vazou $($ok.Passwords.MEMBER)", "convite $($ok.Invite)", "chave $($ok.Key)", "conta $($ok.Emails.OWNER.ToUpper())") | Set-Content $f -Encoding utf8
    $s = Measure-C2Sensitive -Path $f -Key $ok.Key -Secrets $secretsFixture -Emails @($ok.Emails.Values)
    if ($s.segredo_digitado -ne 2 -or $s.email_digitado -ne 1 -or $s.chave_digitada -ne 1 -or $s.total -lt 4) { throw ($s | ConvertTo-Json -Compress) }
    'nada aqui' | Set-Content $f
    if ((Measure-C2Sensitive -Path $f -Key $ok.Key -Secrets $secretsFixture -Emails @($ok.Emails.Values)).total -ne 0) { throw 'falso positivo' }
  } finally { Remove-Item $f }
}
Check 'resumo: mascara senha, convite, e-mails (digitados e quaisquer), UUID e chave; mantém resultados e anotações' {
  $f = [IO.Path]::GetTempFileName()
  try {
    $leak = "     ↳ anon: CHANNEL_ERROR ($($ok.Passwords.OWNER) $($ok.Invite) $($ok.Emails.STRANGER) outro@x.example 3f2b8c1e-9a4d-4e7b-8c2f-1a2b3c4d5e6f)"
    Write-C2SafeSummary -Lines ((ConvertTo-OperatorConsole $okReport) + $leak + 'log qualquer' + 'C2-PASSWORD exit = 0') -Path $f -Secrets ($secretsFixture + $ok.Key) -Emails @($ok.Emails.Values)
    $out = Get-Content $f -Raw -Encoding utf8
    foreach ($bad in @($ok.Passwords.OWNER, $ok.Invite, $ok.Emails.STRANGER, 'outro@x.example', '3f2b8c1e-', 'log qualquer')) { if ($out.Contains($bad)) { throw "manteve: $bad" } }
    if ($out -notmatch '<segredo>' -or $out -notmatch '<email>' -or $out -notmatch 'Tests\s+16 passed' -or $out -notmatch 'C2-PASSWORD exit = 0' -or $out -notmatch '↳ membro: CHANNEL_ERROR') { throw 'resumo incompleto' }
  } finally { Remove-Item $f }
}

Check 'B10: Protect-C2Text mascara literais (o mais longo antes), e-mails, JWT, chave, PAT e UUID' {
  $t = "falhou $($ok.Passwords.OWNER) / $($ok.Invite) / $($ok.Emails.MEMBER.ToUpper()) / x@y.example / eyJabcdefghij.klmnopqrst / $($ok.Key) / sbp_0123456789ab / 3f2b8c1e-9a4d-4e7b-8c2f-1a2b3c4d5e6f"
  $out = Protect-C2Text $t ($secretsFixture + $ok.Key) @($ok.Emails.Values)
  foreach ($bad in @($ok.Passwords.OWNER, $ok.Invite, 'MEMBRO+ORYN', 'x@y.example', 'eyJ', 'sb_publishable_', 'sbp_', '3f2b8c1e')) { if ($out.Contains($bad)) { throw "manteve $bad :: $out" } }
  if (([regex]::Matches($out, '<segredo>')).Count -ne 3) { throw $out }
}

# --- pós-processamento (M1/M2) e recuperação (02C.7P-C), em pastas temporárias fora do repositório ---
$tmpRoot = Join-Path ([IO.Path]::GetTempPath()) ('oryn-c2-run-' + [guid]::NewGuid().ToString('n').Substring(0, 8))
function New-RunDir([string[]]$Report, [switch]$NoT1, [switch]$NoRaw, [datetime]$T0 = [datetime]::new(2026, 10, 28, 12, 0, 0, [DateTimeKind]::Utc)) {
  $script:runN++; $d = Join-Path $tmpRoot "c2pw-20261028-1200-$($script:runN + 1)"
  New-Item -ItemType Directory -Path $d -Force | Out-Null
  $h = "modo=C2-PASSWORD`ncommit=x`ninicio_utc=$($T0.ToString('o'))"
  if (-not $NoT1) { $h += "`nfim_utc=$($T0.AddMinutes(6).ToString('o'))`nexit=0" }
  $h | Set-Content (Join-Path $d 'horario.txt') -Encoding utf8
  'abcdef0123456789' | Set-Content (Join-Path $d 'convite.impressao') -Encoding utf8
  if (-not $NoRaw) { $Report | Set-Content (Join-Path $d $spec.Report) -Encoding utf8 }
  $d
}
$Run = { param($d, $exit = 0, [scriptblock]$an = $null)
  $p = @{ Dir = $d; ExitCode = $exit; Key = $ok.Key; Secrets = $secretsFixture; Emails = @($ok.Emails.Values) }; if ($an) { $p.Analyze = $an }
  Complete-C2Run @p }
$rawOf = { param($d) Join-Path $d $spec.Report }
try {
  Check 'M1: o bruto nasce com nome de NÃO compartilhar e nunca está na lista compartilhável' {
    if ($spec.Report -notmatch 'NAO-COMPARTILHAR' -or $spec.Shareable -contains $spec.Report) { throw $spec.Report }
    if (($spec.Shareable -join ',') -ne 'c2pw.resumo.txt,horario.txt,contagens.txt') { throw ($spec.Shareable -join ',') }
  }
  Check 'M1: relatório limpo = PASS; bruto mantido (sem segredo); resumo e contagens gravados; compartilháveis = só os 3' {
    $d = New-RunDir $okReport; $r = & $Run $d
    if ($r.Outcome -ne 'PASS' -or -not (Test-Path (& $rawOf $d))) { throw "$($r.Outcome) $($r.Reason)" }
    if ((Get-Content (Join-Path $d 'contagens.txt') -Raw) -notmatch 'total=0') { throw 'contagens' }
    $names = @(Get-C2ShareableEvidence $d | ForEach-Object { Split-Path -Leaf $_ }) -join ','
    if ($names -ne 'c2pw.resumo.txt,horario.txt,contagens.txt') { throw "compartilháveis: $names" }
  }
  Check 'M2: senha no bruto = FALHOU; bruto APAGADO; resumo sem a senha; LEIA-ME com rotação; nada sensível compartilhável' {
    $leak = @($okReport) + "     ↳ anon: CHANNEL_ERROR ($($ok.Passwords.STRANGER))"
    $d = New-RunDir $leak; $r = & $Run $d
    if ($r.Outcome -ne 'FALHOU' -or (Test-Path (& $rawOf $d))) { throw "$($r.Outcome) bruto=$(Test-Path (& $rawOf $d))" }
    $shared = (Get-C2ShareableEvidence $d | ForEach-Object { Get-Content $_ -Raw }) -join "`n"
    if ($shared.Contains($ok.Passwords.STRANGER) -or $shared -notmatch '<segredo>' -or $shared -notmatch 'segredo_digitado=1') { throw 'compartilhável com segredo ou sem contagem' }
    if ((Get-Content (Join-Path $d 'LEIA-ME.txt') -Raw) -notmatch 'rotação') { throw 'LEIA-ME sem rotação' }
    if (@(Get-C2ShareableEvidence $d | Where-Object { $_ -match 'LEIA-ME|impressao|BRUTO' }).Count) { throw 'arquivo não compartilhável na lista' }
  }
  Check 'M1: falha da análise = INCONCLUSIVO (bruto limpo mantido); com segredo = FALHOU e bruto apagado; mensagem mascarada (B10)' {
    $boom = { param($l) throw "quebrou com $($ok.Passwords.OWNER) e 3f2b8c1e-9a4d-4e7b-8c2f-1a2b3c4d5e6f" }
    $d = New-RunDir $okReport; $r = & $Run $d 0 $boom
    if ($r.Outcome -ne 'INCONCLUSIVO' -or $r.Reason -notmatch 'análise' -or $r.Reason.Contains($ok.Passwords.OWNER) -or $r.Reason -match '3f2b8c1e') { throw "$($r.Outcome) :: $($r.Reason)" }
    if (-not (Test-Path (Join-Path $d 'c2pw.resumo.txt'))) { throw 'resumo não gravado antes da análise' }
    $d = New-RunDir (@($okReport) + "senha $($ok.Passwords.MEMBER)"); $r = & $Run $d 0 $boom
    if ($r.Outcome -ne 'FALHOU' -or (Test-Path (& $rawOf $d))) { throw "com segredo: $($r.Outcome)" }
  }
  Check 'M1: bruto ilegível (não dá para medir) = INCONCLUSIVO e apagado sem análise' {
    $d = New-RunDir @() -NoRaw; New-Item -ItemType Directory -Path (& $rawOf $d) | Out-Null   # um diretório no lugar do arquivo
    $r = & $Run $d
    if ($r.Outcome -ne 'INCONCLUSIVO' -or $r.Reason -notmatch 'ilegível' -or (Test-Path (& $rawOf $d))) { throw "$($r.Outcome) $($r.Reason)" }
  }
  Check 'M1: T1 (fim_utc) ausente com relatório perfeito = INCONCLUSIVO; sem exit code = INCONCLUSIVO; sem bruto = FALHOU' {
    $r = & $Run (New-RunDir $okReport -NoT1); if ($r.Outcome -ne 'INCONCLUSIVO' -or $r.Reason -notmatch 'T1') { throw "T1: $($r.Outcome) $($r.Reason)" }
    $r = & $Run (New-RunDir $okReport) $null; if ($r.Outcome -ne 'INCONCLUSIVO') { throw "sem exit: $($r.Outcome)" }
    $r = & $Run (New-RunDir @() -NoRaw); if ($r.Outcome -ne 'FALHOU' -or $r.Reason -notmatch 'não gerado') { throw "sem bruto: $($r.Outcome)" }
  }
  Check 'B10: linhas de console do veredito por teste mascaram senha e UUID vindos da linha de erro (→)' {
    $err = "join_room: $($ok.Passwords.MEMBER) 3f2b8c1e-9a4d-4e7b-8c2f-1a2b3c4d5e6f"
    $r = & $Run (New-RunDir (New-C2Report (With 'D2' (T 'D2' '×' @() $err)))) 1
    $text = $r.Lines -join "`n"
    if ($r.Outcome -ne 'FALHOU' -or $text.Contains($ok.Passwords.MEMBER) -or $text -match '3f2b8c1e' -or $text -notmatch 'D2: FAIL') { throw $text }
  }
  Check 'recuperação: interrompida sem fim_utc → bruto apagado, resumo SÓ com resultados (sem ↳), fim_utc_estimado = agora, INCONCLUSIVO' {
    $t0 = [datetime]::new(2026, 10, 28, 12, 0, 0, [DateTimeKind]::Utc)
    $d = New-RunDir (@($okReport) + "     ↳ x: CHANNEL_ERROR ($($ok.Passwords.OWNER))") -NoT1 -T0 $t0
    $r = Invoke-C2Recovery -Dir $d -UtcNow $t0.AddMinutes(7)
    $sum = Get-Content (Join-Path $d 'c2pw.resumo.txt') -Raw; $h = Get-Content (Join-Path $d 'horario.txt') -Raw
    if (-not $r.RawRemoved -or (Test-Path (& $rawOf $d)) -or $sum -match '↳' -or $sum.Contains($ok.Passwords.OWNER) -or $sum -notmatch 'Tests\s+16 passed') { throw 'resumo/bruto' }
    if ($h -notmatch "fim_utc_estimado=$([regex]::Escape($t0.AddMinutes(7).ToString('o')))" -or $h -notmatch '(?m)^resultado=INCONCLUSIVO') { throw $h }
    Throws { Invoke-C2Recovery -Dir $d } 'já concluída' | Out-Null
  }
  Check 'recuperação: T1 estimado limitado a T0 + 29 min; com fim_utc real não estima; pasta errada ou relógio anterior abortam' {
    $t0 = [datetime]::new(2026, 10, 28, 12, 0, 0, [DateTimeKind]::Utc)
    $d = New-RunDir $okReport -NoT1 -T0 $t0; $r = Invoke-C2Recovery -Dir $d -UtcNow $t0.AddHours(3)
    if ($r.T1 -ne $t0.AddMinutes(29).ToString('o')) { throw "T1 $($r.T1)" }
    $d = New-RunDir $okReport -T0 $t0; $r = Invoke-C2Recovery -Dir $d -UtcNow $t0.AddMinutes(8)
    if ($r.T1Estimated -or (Get-Content (Join-Path $d 'horario.txt') -Raw) -match 'estimado') { throw 'estimou com fim_utc real' }
    $other = Join-Path $tmpRoot 'c0-w-20261028-0100'; New-Item -ItemType Directory -Path $other -Force | Out-Null
    Throws { Invoke-C2Recovery -Dir $other } 'não é uma pasta' | Out-Null
    $d = New-RunDir $okReport -NoT1 -T0 $t0; Throws { Invoke-C2Recovery -Dir $d -UtcNow $t0.AddMinutes(-5) } 'relógio' | Out-Null
  }
} finally { Remove-Item -Recurse -Force $tmpRoot -ErrorAction SilentlyContinue }

# --- o executor (estático e de ponta a ponta, offline) ---
$exe = Join-Path $PSScriptRoot 'oryn-c2.ps1'
$exeText = Get-Content -LiteralPath $exe -Raw -Encoding utf8
$code = ($exeText -split "`n" | Where-Object { $_ -notmatch '^\s*#' }) -join "`n"
Check 'executor: chave, senhas e convite só com entrada protegida; nada de rede própria; nunca emite convite' {
  foreach ($p in "Read-Secret 'chave publicável", 'Read-Secret "senha $role"', "Read-Secret 'convite de criador") { if (-not $code.Contains($p)) { throw "sem entrada protegida: $p" } }
  if ($code -match "Read-Host '(chave|convite)|Read-Host ""senha") { throw 'Read-Host às claras para segredo' }
  if ($code -match 'Invoke-RestMethod|Invoke-WebRequest|curl|psql|supabase |admin_issue_creator_invite|Set-Content[^\n]*\$(key|invite|passwords)') { throw 'chamada proibida no executor' }
  if ($code -notmatch '-t \$filter' -or $code -notmatch 'Clear-OrynEnv' -or $code -notmatch 'finally') { throw 'faltou filtro, limpeza ou finally' }
}
Check 'executor: impressão do convite gravada ANTES da rede; entradas validadas ANTES das variáveis' {
  $iImp = $code.IndexOf('convite.impressao'); $iNet = $code.IndexOf('Invoke-NativeTee'); $iVal = $code.IndexOf('Assert-C2Inputs'); $iEnv = $code.IndexOf('$env:ORYN_REMOTE =')
  if (-not ($iImp -gt 0 -and $iImp -lt $iNet -and $iVal -gt 0 -and $iVal -lt $iEnv -and $code.IndexOf('Assert-InviteNotReused') -lt $iEnv)) { throw "ordem: imp=$iImp net=$iNet val=$iVal env=$iEnv" }
}
Check 'executor (02C.7P-C): margem UTC antes do D0 e das entradas; pós-processamento sempre que houver bruto; ambiente limpo primeiro no finally' {
  $iMargin = $code.IndexOf('Assert-UtcDayMargin'); $iD0 = $code.IndexOf('Assert-D0Date'); $iKey = $code.IndexOf("Read-Secret 'chave")
  if (-not ($iMargin -gt 0 -and $iMargin -lt $iD0 -and $iD0 -lt $iKey)) { throw "ordem: margem=$iMargin d0=$iD0 chave=$iKey" }
  if ($code -notmatch '\$runStarted = \[bool\]\$dir -and \(Test-Path -LiteralPath \(Join-Path \$dir \$spec\.Report\)\)') { throw 'pós-processamento condicionado a outra coisa além do bruto' }
  if ($code -notmatch 'if \(\$runStarted\) \{[\s\S]*Complete-C2Run') { throw 'sem Complete-C2Run' }
  if ($code -notmatch 'finally \{\s*(#[^\n]*\s*)?try \{ Clear-OrynEnv \} finally \{ Exit-PlainConsole') { throw 'Clear-OrynEnv não é o primeiro passo do finally' }
  if ($code -notmatch 'Get-C2ShareableEvidence') { throw 'não lista os compartilháveis' }
  if ($code -match 'Move-Item|QUARENTENA') { throw 'restou a quarentena antiga (bruto preservado)' }
}
Check 'executor real: commit não aprovado aborta antes de qualquer pergunta, sem pasta de evidências (exit 1)' {
  $root = Join-Path $PSScriptRoot '..\evidence'
  $before = @(Get-ChildItem -LiteralPath $root -Directory -Filter 'c2pw-*' -ErrorAction SilentlyContinue).Count
  $pw = (Get-Process -Id $PID).Path
  $out = & $pw -NoProfile -NonInteractive -File $exe -ApprovedCommit ('0' * 40) 2>&1 | Out-String
  $exit = $LASTEXITCODE
  $after = @(Get-ChildItem -LiteralPath $root -Directory -Filter 'c2pw-*' -ErrorAction SilentlyContinue).Count
  if ($exit -ne 1 -or $out -notmatch 'C2-PASSWORD: ABORTADO' -or $out -match 'Evidências em' -or $after -ne $before) { throw "exit=$exit pastas $before→$after :: $out" }
  if (Get-ChildItem Env:ORYN_* -ErrorAction SilentlyContinue) { throw 'variáveis ORYN_* no processo do autoteste' }
}
Check 'executor real: ApprovedCommit fora do formato é recusado pelo PowerShell (exit ≠ 0)' {
  $pw = (Get-Process -Id $PID).Path
  & $pw -NoProfile -NonInteractive -File $exe -ApprovedCommit 'HEAD' *> $null
  if ($LASTEXITCODE -eq 0) { throw 'aceitou' }
}

$results
$fail = @($results | Where-Object { $_ -like 'FAIL*' }).Count
"--- $(@($results | Where-Object { $_ -like 'PASS*' }).Count) PASS / $fail FAIL"
exit $(if ($fail) { 1 } else { 0 })
