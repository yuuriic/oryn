# ORYN — funções PURAS do executor da C2 com contas preexistentes (02C.7P-A). Só definições: carregar este
# arquivo não executa nada, não lê o ambiente e não toca na rede. Testado por oryn-c2.selftest.ps1.
#
# Reaproveita SEM ALTERAR as peças do executor C0 (oryn-c0.lib.ps1): Git, ambiente, pasta de evidências,
# normalização do console, classificação de recusas (realtime-refusals.json), contagem de sensíveis, resumo e
# exit code. Aqui ficam só as regras da C2 `password`: os 17 testes esperados (16 PASS + #15 pulado), a
# validação das entradas digitadas, o prazo e o reuso do convite de criador, o resumo sem e-mails e (02C.7P-C)
# o pós-processamento que protege o relatório bruto e a recuperação offline de execuções interrompidas.
. (Join-Path $PSScriptRoot 'oryn-c0.lib.ps1')

# Bloco do harness e filtro do Vitest (-t). Só o bloco da sala; o resto do arquivo fica pulado ou `todo`.
$script:C2Block = 'Supabase real — C2: sala de teste'
$script:C2Filter = 'C2: sala de teste'
$script:C2SkipNote = 'modo password: sem cadastro de identidades novas'

# Variáveis ORYN_* do processo da C2 `password`: exatamente estas (o portão do harness confere os valores).
# Sem ORYN_IT_IDENTITY_BUDGET (0 por construção, sem cadastro) e sem ORYN_CAPTCHA_* (sem CAPTCHA).
$script:C2EnvNames = @(
  'ORYN_IT_CREATOR_INVITE', 'ORYN_IT_IDENTITY', 'ORYN_IT_PARTITIONS_CONFIRMED', 'ORYN_IT_PHASE',
  'ORYN_IT_USER_MEMBER_EMAIL', 'ORYN_IT_USER_MEMBER_PASSWORD', 'ORYN_IT_USER_OWNER_EMAIL', 'ORYN_IT_USER_OWNER_PASSWORD',
  'ORYN_IT_USER_STRANGER_EMAIL', 'ORYN_IT_USER_STRANGER_PASSWORD',
  'ORYN_PUBLISHABLE_KEY', 'ORYN_REMOTE', 'ORYN_REMOTE_REF', 'ORYN_SUPABASE_URL'
)

# Os 17 testes do bloco C2, na ordem do harness. Kind:
#   positive  passa só com ✓ (acesso legítimo, entrega, concorrência);
#   refusal   cada anotação [motivo; esperado; veredito] tem de trazer o motivo EXATO, na ordem de Expected;
#   presence  S8/P5: entrada aceita OU recusa `Unauthorized`; a presença nunca se propaga;
#   skip      #15: tem de vir PULADO com a nota exata do modo password.
# Conferido contra o código do harness por tests/remote-harness-c2.test.ts.
$script:C2Tests = @(
  [pscustomobject]@{ Id = '#6/S1'; Kind = 'positive'; Expected = @() }
  [pscustomobject]@{ Id = 'A4'; Kind = 'positive'; Expected = @() }
  [pscustomobject]@{ Id = '#6/S2/S3'; Kind = 'refusal'; Expected = @('authorization', 'authorization') }
  [pscustomobject]@{ Id = '#7/S5'; Kind = 'refusal'; Expected = @('private-only') }
  [pscustomobject]@{ Id = 'S6'; Kind = 'refusal'; Expected = @('authorization') }
  [pscustomobject]@{ Id = 'S7'; Kind = 'refusal'; Expected = @('authorization', 'authorization', 'authorization', 'authorization') }
  [pscustomobject]@{ Id = 'S8/P5'; Kind = 'presence'; Expected = @('observador', 'rastreador') }
  [pscustomobject]@{ Id = 'A1'; Kind = 'refusal'; Expected = @('authorization') }
  [pscustomobject]@{ Id = 'A2/A3'; Kind = 'refusal'; Expected = @('authorization', 'authorization') }
  [pscustomobject]@{ Id = '#11/D1'; Kind = 'positive'; Expected = @() }
  [pscustomobject]@{ Id = 'D2'; Kind = 'positive'; Expected = @() }
  [pscustomobject]@{ Id = '#8/P1'; Kind = 'positive'; Expected = @() }
  [pscustomobject]@{ Id = '#8/P2/P3'; Kind = 'positive'; Expected = @() }
  [pscustomobject]@{ Id = 'D3'; Kind = 'positive'; Expected = @() }
  [pscustomobject]@{ Id = '#18 M5'; Kind = 'positive'; Expected = @() }
  [pscustomobject]@{ Id = '#18 authorize_signal'; Kind = 'positive'; Expected = @() }
  [pscustomobject]@{ Id = '#15 HTTP'; Kind = 'skip'; Expected = @() }
)
$script:C2PassCount = @($script:C2Tests | Where-Object Kind -ne 'skip').Count   # 16

# Convite de criador (G6): emitido pelo operador no SQL editor com `admin_issue_creator_invite(10, 1)` — nunca
# por este executor. Prazo de 10 min; só é usado se ainda restarem pelo menos 2 min (o resgate é no beforeAll).
$script:InviteTtlMinutes = 10
$script:InviteMinRemainingMinutes = 2

# Pasta de evidências (02C.7P-C, M1/M2). O relatório bruto NASCE com nome de não compartilhar (uma interrupção a
# qualquer momento nunca deixa um bruto com cara de evidência). Só a lista Shareable pode sair da máquina.
$script:C2RawReport = 'c2pw.BRUTO-NAO-COMPARTILHAR.txt'
$script:C2Summary = 'c2pw.resumo.txt'
$script:C2Counts = 'contagens.txt'
$script:C2Shareable = @($script:C2Summary, 'horario.txt', $script:C2Counts)

# Margem da virada do dia UTC (B7): a C2 dura minutos e o D0 vale só para o dia de hoje.
$script:UtcDayMarginMinutes = 15
# Teto da janela [T0, T1] (B6): o 13_c2_postflight.sql reprova janelas de 30 min ou mais.
$script:MaxWindowMinutes = 30

function Get-C2Spec {
  [pscustomobject]@{
    Name = 'C2-PASSWORD'; Block = $script:C2Block; Filter = $script:C2Filter; Report = $script:C2RawReport; Summary = $script:C2Summary
    Counts = $script:C2Counts; Shareable = $script:C2Shareable
    EnvNames = $script:C2EnvNames; Tests = $script:C2Tests; PassCount = $script:C2PassCount; SkipNote = $script:C2SkipNote
  }
}

# --- entradas digitadas (validadas ANTES de qualquer variável de ambiente e de qualquer rede) -----------------

# Mensagens citam só o PAPEL e o campo, nunca o valor.
function Assert-C2Inputs([string]$Ref, [string]$Key, [hashtable]$Emails, [hashtable]$Passwords, [string]$Invite) {
  if ($Ref -notmatch '^[a-z0-9]{20}$') { throw 'ref fora do formato (20 caracteres a-z0-9)' }
  if ($Key -notmatch '^sb_publishable_[A-Za-z0-9_-]+$') { throw 'a chave digitada não tem o formato sb_publishable_' }
  foreach ($role in 'OWNER', 'MEMBER', 'STRANGER') {
    $e = "$($Emails[$role])".Trim()
    if ($e -notmatch '^[^\s@]+@[^\s@]+\.[^\s@]+$') { throw "e-mail $role ausente ou fora do formato" }
    if ([string]::IsNullOrEmpty($Passwords[$role])) { throw "senha $role vazia" }
    if ($Passwords[$role] -match '^\s|\s$') { throw "senha $role com espaço no início ou no fim (provável erro de digitação)" }
  }
  $distinct = @('OWNER', 'MEMBER', 'STRANGER' | ForEach-Object { "$($Emails[$_])".Trim().ToLowerInvariant() } | Sort-Object -Unique)
  if ($distinct.Count -ne 3) { throw 'OWNER, MEMBER e STRANGER têm de ser 3 contas DIFERENTES' }
  if ($Invite -notmatch '^[A-Za-z0-9_-]{43}$') { throw 'convite de criador fora do formato (43 caracteres)' }
}

# D0: o operador declara a data (UTC) da partição que confirmou por leitura; tem de ser HOJE em UTC.
function Assert-D0Date([string]$Typed, [datetime]$UtcNow) {
  $today = $UtcNow.ToUniversalTime().ToString('yyyy-MM-dd')
  if ($Typed.Trim() -cne $today) { throw "D0 não confirmado para hoje (UTC $today): refaça a leitura da partição antes da C2" }
}

# B7: não começa a menos de 15 min da virada do dia UTC, nem nos 15 min seguintes. A execução atravessaria a troca
# de partição (MissingPartition = INCONCLUSIVO, autorização e convite gastos) ou usaria um D0 recém-confirmado.
function Assert-UtcDayMargin([datetime]$UtcNow) {
  $u = $UtcNow.ToUniversalTime(); $m = $u.TimeOfDay.TotalMinutes
  if ($m -lt $script:UtcDayMarginMinutes -or $m -ge (1440 - $script:UtcDayMarginMinutes)) {
    throw "a menos de $($script:UtcDayMarginMinutes) min da virada do dia UTC (agora $($u.ToString('HH:mm')) UTC): não iniciar a C2 entre 23:45 e 00:15 UTC"
  }
}

# Prazo do convite: o horário de emissão vem do SQL editor (`now()` na mesma consulta da emissão), em UTC.
function Assert-InviteFresh([string]$IssuedUtc, [datetime]$UtcNow) {
  $styles = [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal
  $issued = [datetime]::MinValue
  if (-not [datetime]::TryParse($IssuedUtc.Trim(), [Globalization.CultureInfo]::InvariantCulture, $styles, [ref]$issued)) {
    throw 'horário de emissão do convite ilegível (use o now() da consulta de emissão, em UTC)'
  }
  $age = ($UtcNow.ToUniversalTime() - $issued).TotalMinutes
  if ($age -lt -1) { throw 'horário de emissão do convite no futuro: confira o relógio e o fuso (UTC)' }
  $remaining = $script:InviteTtlMinutes - $age
  if ($remaining -lt $script:InviteMinRemainingMinutes) {
    throw ('convite vencido ou perto de vencer ({0:N1} min restantes): não usar; um convite novo exige autorização' -f [math]::Max($remaining, 0))
  }
}

# Impressão do convite para impedir REUSO entre execuções: os primeiros 16 hex do SHA-256 (o banco já guarda o
# SHA-256 inteiro como token_hash; isto não revela o convite). O servidor também recusa um convite usado.
function Get-InviteFingerprint([string]$Invite) {
  $sha = [Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($Invite))
  ([Convert]::ToHexString($sha)).Substring(0, 16).ToLowerInvariant()
}

function Assert-InviteNotReused([string]$EvidenceRoot, [string]$Fingerprint) {
  $seen = @(Get-ChildItem -LiteralPath $EvidenceRoot -Directory -Filter 'c2pw-*' -ErrorAction Stop |
      ForEach-Object { Join-Path $_.FullName 'convite.impressao' } | Where-Object { Test-Path -LiteralPath $_ } |
      Where-Object { (Get-Content -LiteralPath $_ -Raw -Encoding utf8).Trim() -ceq $Fingerprint })
  if ($seen.Count -gt 0) { throw 'este convite já foi usado numa execução anterior: não reutilizar (um convite novo exige autorização)' }
}

# --- classificação do relatório (G5) ----------------------------------------------------------------------------

# Veredito de UMA anotação de recusa `<rótulo>: <ESTADO> (<motivo>) [motivo=…; esperado=…; veredito=…]`.
# Diferente do C0 (um Z = uma anotação), aqui um teste pode ter várias: o marcador é avaliado no nível do teste.
function Get-RefusalNoteVerdict([string]$Note, [string]$Expected) {
  $n = ConvertFrom-RefusalNote $Note
  if (-not $n) { return [pscustomobject]@{ Verdict = 'FAIL'; Outcome = ''; Why = 'anotação ilegível' } }
  $local = Get-JoinOutcome $n.Status $n.Reason
  if (-not $n.Motivo) { return [pscustomobject]@{ Verdict = (Get-RefusalVerdict $local $Expected); Outcome = $local; Why = 'sem veredito do harness (reclassificado)' } }
  $verdict = Get-RefusalVerdict $n.Motivo $Expected
  if ($n.Esperado -cne $Expected) { return [pscustomobject]@{ Verdict = 'FAIL'; Outcome = $n.Motivo; Why = "harness esperava $($n.Esperado), o executor espera $Expected" } }
  if ($verdict -eq 'PASS' -and ($local -cne $Expected -or $n.Veredito -cne 'PASS')) {
    return [pscustomobject]@{ Verdict = 'FAIL'; Outcome = $n.Motivo; Why = "incoerência: local=$local, harness=$($n.Motivo)/$($n.Veredito)" }
  }
  [pscustomobject]@{ Verdict = $verdict; Outcome = $n.Motivo; Why = '' }
}

# Presence (S8/P5): `observador|rastreador: <ESTADO>[ (<motivo>)]`. Entrada aceita ou recusa do RLS são decisões
# válidas (o critério é a não propagação); PrivateOnly num canal privado é decisão errada; o resto, sem decisão.
function Get-PresenceNoteVerdict([string]$Note) {
  $n = ConvertFrom-RefusalNote $Note
  if (-not $n) { return [pscustomobject]@{ Verdict = 'FAIL'; Outcome = ''; Why = 'anotação ilegível' } }
  $o = Get-JoinOutcome $n.Status $n.Reason
  $v = switch -CaseSensitive ($o) { 'subscribed' { 'PASS' } 'authorization' { 'PASS' } 'private-only' { 'FAIL' } default { 'INCONCLUSIVO' } }
  [pscustomobject]@{ Verdict = $v; Outcome = $o; Why = '' }
}

function Join-Verdicts([string[]]$Verdicts) {
  if ($Verdicts -contains 'FAIL') { 'FAIL' } elseif ($Verdicts -contains 'INCONCLUSIVO') { 'INCONCLUSIVO' } else { 'PASS' }
}

# Veredito de UM teste da C2: Marker (✓ × ↓ □ ou vazio), Notes (anotações ↳ do teste), ErrorLine (linha → do ×),
# SkipNote (texto entre colchetes do ↓) e o contexto do relatório: SuiteFailed (beforeAll falhou) e NoSummary.
function Get-C2TestVerdict($Test, [string]$Marker, [string[]]$Notes, [string]$ErrorLine, [string]$SkipNote, [bool]$SuiteFailed, [bool]$NoSummary) {
  $timedOut = $ErrorLine -match '^Test timed out in '
  $r = { param($v, $why, $o = '') [pscustomobject]@{ Verdict = $v; Why = $why; Outcome = $o } }

  if (-not $Marker -or $Marker -eq '□' -or ($Marker -eq '↓' -and $Test.Kind -ne 'skip')) {
    if ($SuiteFailed) { return (& $r 'INCONCLUSIVO' 'beforeAll falhou: nenhuma decisão de acesso') }
    if ($NoSummary) { return (& $r 'INCONCLUSIVO' 'execução interrompida antes deste teste') }
    return (& $r 'FAIL' $(if ($Marker) { "não executado (marcador $Marker)" } else { 'ausente do relatório' }))
  }

  switch ($Test.Kind) {
    'skip' {
      if ($Marker -eq '↓' -and $SkipNote -ceq $script:C2SkipNote) { return (& $r 'PASS' 'pulado pelo motivo esperado') }
      if ($Marker -eq '↓' -and $SuiteFailed) { return (& $r 'INCONCLUSIVO' 'beforeAll falhou') }
      if ($Marker -eq '↓') { return (& $r 'FAIL' "pulado sem a nota esperada ('$SkipNote')") }
      return (& $r 'FAIL' "executado no modo password (marcador $Marker): esperado pulado")
    }
    'positive' {
      if ($Marker -eq '✓') { return (& $r 'PASS' '') }
      if ($timedOut) { return (& $r 'INCONCLUSIVO' 'timeout') }
      return (& $r 'FAIL' $(if ($ErrorLine) { $ErrorLine } else { 'reprovado' }))
    }
    'presence' {
      $own = @($Notes | Where-Object { $_ -match '^(observador|rastreador): ' })
      $vs = @($own | ForEach-Object { Get-PresenceNoteVerdict $_ })
      $joined = if ($vs.Count) { Join-Verdicts @($vs.Verdict) } else { 'PASS' }
      $out = ($vs.Outcome) -join ','
      # B1: exatamente UMA anotação de cada papel esperado (observador e rastreador), não só duas quaisquer.
      $perLabel = @($Test.Expected | ForEach-Object { $l = $_; @($own | Where-Object { $_.StartsWith("${l}: ") }).Count })
      $complete = $own.Count -eq $Test.Expected.Count -and -not @($perLabel | Where-Object { $_ -ne 1 }).Count
      if ($Marker -eq '✓') {
        if ($complete -and $joined -eq 'PASS') { return (& $r 'PASS' '' $out) }
        if (-not $complete) { return (& $r 'FAIL' "aprovado pelo Vitest sem exatamente 1 anotação de $($Test.Expected -join ' e ') ($out)" $out) }
        return (& $r 'FAIL' "aprovado pelo Vitest com entrada sem decisão ($out)" $out)
      }
      if ($joined -eq 'FAIL') { return (& $r 'FAIL' 'decisão errada na entrada' $out) }
      if ($joined -eq 'INCONCLUSIVO' -or $timedOut) { return (& $r 'INCONCLUSIVO' $(if ($timedOut) { 'timeout' } else { 'entrada sem decisão de acesso' }) $out) }
      return (& $r 'FAIL' $(if ($ErrorLine) { $ErrorLine } else { 'presença propagada ou canal perdido' }) $out)
    }
    'refusal' {
      $own = @($Notes)   # nos testes de recusa da C2, toda anotação vem do expectRefused
      $vs = @(for ($i = 0; $i -lt $own.Count; $i++) {
          $exp = if ($i -lt $Test.Expected.Count) { $Test.Expected[$i] } else { $null }
          if ($null -eq $exp) { [pscustomobject]@{ Verdict = 'FAIL'; Outcome = ''; Why = 'anotação de recusa a mais' } }
          else { Get-RefusalNoteVerdict $own[$i] $exp }
        })
      $joined = if ($vs.Count) { Join-Verdicts @($vs.Verdict) } else { 'PASS' }
      $out = ($vs.Outcome) -join ','
      $whyNote = (@($vs | Where-Object Why) | ForEach-Object Why | Select-Object -First 1)
      if ($joined -eq 'FAIL') { return (& $r 'FAIL' $(if ($whyNote) { $whyNote } else { 'recusa com motivo errado ou entrada aceita' }) $out) }
      if ($Marker -eq '✓') {
        if ($own.Count -eq $Test.Expected.Count -and $joined -eq 'PASS') { return (& $r 'PASS' '' $out) }
        return (& $r 'FAIL' "aprovado pelo Vitest sem as $($Test.Expected.Count) recusa(s) comprovada(s) ($($own.Count) anotada(s), $joined)" $out)
      }
      if ($joined -eq 'INCONCLUSIVO') { return (& $r 'INCONCLUSIVO' 'recusa sem decisão de acesso' $out) }
      if ($timedOut) { return (& $r 'INCONCLUSIVO' 'timeout' $out) }
      return (& $r 'FAIL' $(if ($ErrorLine) { $ErrorLine } else { 'reprovado' }) $out)
    }
  }
}

# Relatório do Vitest (--reporter=verbose) da C2 `password`. Ok (PASS) só se:
#  - a linha "Tests" existe, com exatamente 16 aprovados e 0 falhas;
#  - cada um dos 17 testes aparece UMA vez no bloco da C2; 16 com veredito PASS e o #15 pulado pela nota exata;
#  - nenhum ✓ fora do bloco da C2 (nem fora da lista).
# Verdict: PASS; FAIL (decisão errada, teste ausente ou duplicado, aprovado fora do bloco, incoerência);
# INCONCLUSIVO (nenhum FAIL, mas algum teste sem decisão: infraestrutura, credencial, desconhecido, timeout,
# beforeAll que falhou, execução interrompida sem resumo).
function Test-C2Report([string[]]$Lines) {
  $spec = Get-C2Spec
  $Lines = @($Lines | ForEach-Object { ConvertTo-PlainReportLine $_ })
  $text = $Lines -join "`n"
  $blockRe = [regex]::Escape($spec.Block)
  $resultRe = '^\s*(✓|×|↓|□) '
  $summary = [regex]::Match($text, '(?m)^\s*Tests\s+(?<body>[^\r\n]+)')
  $noSummary = -not $summary.Success
  # beforeAll da sala falhou: o Vitest lista o describe em "Failed Suites" (linha FAIL sem nome de teste) e pula tudo.
  $suiteFailed = @($Lines | Where-Object { $_ -match "^\s*FAIL\s+\S+ > $blockRe[^>]*$" }).Count -gt 0

  $idRe = { param($id) "$resultRe.*$blockRe[^>]*> (?:[^>]*> )?$([regex]::Escape($id))[ :]" }
  $passedLines = @($Lines | Where-Object { $_ -match '^\s*✓ ' })
  $known = @($spec.Tests | Where-Object Kind -ne 'skip' | ForEach-Object { & $idRe $_.Id })
  $outside = @($passedLines | Where-Object { $l = $_; -not @($known | Where-Object { $l -match $_ }).Count })

  $perTest = foreach ($t in $spec.Tests) {
    $re = & $idRe $t.Id
    $idx = @(for ($i = 0; $i -lt $Lines.Count; $i++) { if ($Lines[$i] -match $re) { $i } })
    $marker = ''; $notes = @(); $err = ''; $skip = ''
    if ($idx.Count -eq 1) {
      $line = $Lines[$idx[0]]
      $marker = ($line.TrimStart())[0].ToString()
      if ($line -match '\[(?<n>[^\]]*)\]\s*$') { $skip = $Matches['n'] }
      $notes = @(for ($j = $idx[0] + 1; $j -lt $Lines.Count; $j++) {
          if ($Lines[$j] -match $resultRe -or $Lines[$j] -match '^\s*⎯') { break }
          if ($Lines[$j] -match '^\s*↳ (?<n>.+)$') { $Matches['n'].Trim() }
          elseif (-not $err -and $Lines[$j] -match '^\s*→ (?<e>.+)$') { $err = $Matches['e'].Trim() }
        })
    }
    $v = if ($idx.Count -gt 1) { [pscustomobject]@{ Verdict = 'FAIL'; Why = "aparece $($idx.Count) vezes"; Outcome = '' } }
         else { Get-C2TestVerdict -Test $t -Marker $marker -Notes $notes -ErrorLine $err -SkipNote $skip -SuiteFailed $suiteFailed -NoSummary $noSummary }
    [pscustomobject]@{ Id = $t.Id; Kind = $t.Kind; Marker = $marker; Notes = $notes; Outcome = $v.Outcome; Verdict = $v.Verdict; Why = $v.Why }
  }

  $passed = if ($summary.Success -and $summary.Groups['body'].Value -match '(\d+) passed') { [int]$Matches[1] } else { -1 }
  $failed = if ($summary.Success -and $summary.Groups['body'].Value -match '(\d+) failed') { [int]$Matches[1] } else { 0 }
  $failedLines = @($Lines | Where-Object { $_ -match '^\s*× ' }).Count
  $zPass = @($perTest | Where-Object Verdict -eq 'PASS').Count
  $ok = (-not $noSummary) -and ($passed -eq $spec.PassCount) -and ($failed -eq 0) -and ($failedLines -eq 0) -and ($outside.Count -eq 0) -and ($zPass -eq $spec.Tests.Count) -and (-not $suiteFailed)
  $verdict = if ($ok) { 'PASS' }
             elseif ($outside.Count -gt 0 -or @($perTest | Where-Object Verdict -eq 'FAIL').Count) { 'FAIL' }
             elseif (@($perTest | Where-Object Verdict -eq 'INCONCLUSIVO').Count) { 'INCONCLUSIVO' }
             else { 'FAIL' }   # todos os testes "PASS", mas o resumo não bate: relatório incoerente
  [pscustomobject]@{
    Ok          = $ok
    Verdict     = $verdict
    Passed      = $passed
    Failed      = $failed + 0
    FailedLines = $failedLines
    Outside     = $outside.Count
    SuiteFailed = $suiteFailed
    NoSummary   = $noSummary
    PerTest     = $perTest
    SummaryLine = if ($summary.Success) { 'Tests ' + $summary.Groups['body'].Value.Trim() } else { '(sem linha de resumo)' }
  }
}

# --- sigilo -----------------------------------------------------------------------------------------------------

# Padrões do C0 (JWT, chaves, PAT) + TODOS os literais digitados (chave, 3 senhas, convite) e os 3 e-mails.
# Devolve SÓ contagens, por categoria.
function Measure-C2Sensitive([string]$Path, [string]$Key, [string[]]$Secrets, [string[]]$Emails) {
  $base = Measure-Sensitive -Path $Path -Literal $Key
  $content = Get-Content -LiteralPath $Path -Raw -ErrorAction Stop
  if ($null -eq $content) { $content = '' }
  $count = { param($values) ($values | Where-Object { $_ } | ForEach-Object { [regex]::Matches($content, [regex]::Escape($_), 'IgnoreCase').Count } | Measure-Object -Sum).Sum + 0 }
  $secret = & $count $Secrets
  $email = & $count $Emails
  [pscustomobject]@{
    jwt = $base.jwt; publishable = $base.publishable; secret = $base.secret; pat = $base.pat; chave_digitada = $base.chave_digitada
    segredo_digitado = $secret; email_digitado = $email; total = $base.total + $secret + $email
  }
}

# Máscara de TODO texto que sai do executor (resumo e console, B10): literais digitados (os mais longos antes),
# e-mails digitados e quaisquer, JWT, chaves, PAT e UUID.
function Protect-C2Text([string]$Text, [string[]]$Secrets = @(), [string[]]$Emails = @()) {
  $out = "$Text"
  foreach ($s in @($Secrets | Where-Object { $_ } | Sort-Object Length -Descending)) { $out = [regex]::Replace($out, [regex]::Escape($s), '<segredo>', 'IgnoreCase') }
  foreach ($e in @($Emails | Where-Object { $_ })) { $out = [regex]::Replace($out, [regex]::Escape($e), '<email>', 'IgnoreCase') }
  $out -replace '[^\s@<>()\[\]]+@[^\s@<>()\[\]]+\.[A-Za-z]{2,}', '<email>' -replace 'eyJ[A-Za-z0-9_.-]+', '<jwt>' `
    -replace 'sb_(publishable|secret)_[A-Za-z0-9_-]+', '<chave>' -replace 'sbp_[A-Za-z0-9]+', '<pat>' `
    -replace '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}', '<uuid>'
}

# Resumo compartilhável: só resultados e anotações (mesmo filtro do Write-SafeSummary do C0), mascarados EM MEMÓRIA
# antes de gravar: o arquivo nunca contém um literal digitado, nem por um instante.
function Write-C2SafeSummary([string[]]$Lines, [string]$Path, [string[]]$Secrets, [string[]]$Emails) {
  $kept = @($Lines | ForEach-Object { ConvertTo-PlainReportLine $_ } |
      Where-Object { $_ -match '^\s*(✓|×|↓|□) |Test Files|Tests\s|exit = |^\s*↳ ' } |
      ForEach-Object { Protect-C2Text $_ $Secrets $Emails })
  Set-Content -LiteralPath $Path -Value $(if ($kept.Count) { $kept } else { '' }) -Encoding utf8 -ErrorAction Stop
}

# --- pós-processamento e recuperação (02C.7P-C, M1/M2) ------------------------------------------------------------

function Remove-C2Raw([string]$Path) {
  try {
    if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop }
    return -not (Test-Path -LiteralPath $Path)
  } catch { return $false }
}

# Única lista do que pode sair da máquina: resumo mascarado, horario.txt e contagens. Nunca o bruto, o LEIA-ME
# nem a impressão do convite.
function Get-C2ShareableEvidence([string]$Dir) {
  @((Get-C2Spec).Shareable | ForEach-Object { Join-Path $Dir $_ } | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf })
}

# Pós-processamento de uma execução que chegou a criar o relatório bruto. Pensado para parar a qualquer momento:
#  1. o bruto já nasceu com nome de não compartilhar;
#  2. lê e mede em memória; sem medida (erro de leitura), o conteúdo é desconhecido: apaga o bruto, INCONCLUSIVO;
#  3. grava as contagens e o resumo mascarado; com literal ou padrão sensível, APAGA o bruto antes de interpretar;
#  4. interpreta dentro de try: falha da análise = INCONCLUSIVO (o sigilo já foi tratado);
#  5. sem fim_utc (T1) no horario.txt, nunca PASS.
# FALHOU prevalece (padrão sensível ou decisão errada). Devolve Outcome, Reason e Lines (console, já mascaradas).
function Complete-C2Run([string]$Dir, $ExitCode, [string]$Key, [string[]]$Secrets, [string[]]$Emails, [scriptblock]$Analyze = { param($l) Test-C2Report -Lines $l }) {
  $spec = Get-C2Spec
  $raw = Join-Path $Dir $spec.Report
  $mask = @(@($Secrets) + $Key | Where-Object { $_ })
  $lines = [System.Collections.Generic.List[string]]::new()
  $done = { param($o, $why) [pscustomobject]@{ Outcome = $o; Reason = (Protect-C2Text $why $mask $Emails); Lines = @($lines) } }
  if (-not (Test-Path -LiteralPath $raw)) { return (& $done 'FALHOU' 'relatório não gerado') }

  try {
    $content = @(Get-Content -LiteralPath $raw -Encoding utf8 -ErrorAction Stop)
    $sens = Measure-C2Sensitive -Path $raw -Key $Key -Secrets $Secrets -Emails $Emails
  } catch {
    $gone = Remove-C2Raw $raw
    return (& $done 'INCONCLUSIVO' "relatório bruto ilegível: apagado sem análise$(if (-not $gone) { ' — NÃO FOI POSSÍVEL APAGAR: apagar à mão' })")
  }
  $counts = "jwt=$($sens.jwt) publishable=$($sens.publishable) secret=$($sens.secret) pat=$($sens.pat) chave_digitada=$($sens.chave_digitada) segredo_digitado=$($sens.segredo_digitado) email_digitado=$($sens.email_digitado) total=$($sens.total)"
  $lines.Add("ocorrências sensíveis no relatório (só contagem): $counts")
  $summaryError = $null
  try {
    $counts | Set-Content -LiteralPath (Join-Path $Dir $spec.Counts) -Encoding utf8 -ErrorAction Stop
    Write-C2SafeSummary -Lines ($content + "$($spec.Name) exit = $(if ($null -eq $ExitCode) { 'ausente' } else { $ExitCode })") -Path (Join-Path $Dir $spec.Summary) -Secrets $mask -Emails $Emails
  } catch { $summaryError = $_.Exception.Message }

  $leaked = $sens.total -gt 0
  if ($leaked) {
    $gone = Remove-C2Raw $raw
    "O relatório bruto tinha $($sens.total) padrão(ões) sensível(is) e foi apagado (apagar não garante eliminação forense). Usar só $($spec.Summary). Senha, chave ou convite expostos: seguir a rotação do runbook §12.4." |
      Set-Content -LiteralPath (Join-Path $Dir 'LEIA-ME.txt') -Encoding utf8 -ErrorAction SilentlyContinue
    if (-not $gone) { $lines.Add("⚠ NÃO FOI POSSÍVEL APAGAR $($spec.Report): apagar à mão antes de qualquer cópia da pasta") }
  }
  if ($summaryError) { return (& $done $(if ($leaked) { 'FALHOU' } else { 'INCONCLUSIVO' }) "resumo ou contagens não gravados: $summaryError") }

  try { $check = & $Analyze $content } catch {
    return (& $done $(if ($leaked) { 'FALHOU' } else { 'INCONCLUSIVO' }) "análise do relatório falhou: $($_.Exception.Message)")
  }
  $lines.Add((Protect-C2Text "resultado: $($check.SummaryLine) | aprovados fora do bloco: $($check.Outside) | linhas de falha: $($check.FailedLines) | beforeAll falhou: $($check.SuiteFailed) | veredito: $($check.Verdict)" $mask $Emails))
  foreach ($t in $check.PerTest) {
    $lines.Add((Protect-C2Text "  $($t.Id): $($t.Verdict)$(if ($t.Outcome) { " — motivo=$($t.Outcome)" })$(if ($t.Why) { " — $($t.Why)" })" $mask $Emails))
  }

  $horario = Join-Path $Dir 'horario.txt'
  $hasT1 = (Test-Path -LiteralPath $horario) -and ((Get-Content -LiteralPath $horario -Raw -Encoding utf8) -match '(?m)^fim_utc=')
  if ($leaked) { return (& $done 'FALHOU' 'relatório com padrão sensível (bruto apagado)') }
  if ($null -eq $ExitCode) {
    if ($check.Verdict -eq 'FAIL') { return (& $done 'FALHOU' 'sem exit code do pnpm; veredito do relatório: FAIL') }
    return (& $done 'INCONCLUSIVO' 'sem exit code do pnpm (execução interrompida)')
  }
  if ($ExitCode -eq 0 -and $check.Ok) {
    if ($hasT1) { return (& $done 'PASS' '') }
    return (& $done 'INCONCLUSIVO' 'T1 (fim_utc) ausente no horario.txt')
  }
  if ($ExitCode -ne 0 -and $check.Verdict -eq 'INCONCLUSIVO') { return (& $done 'INCONCLUSIVO' "pnpm saiu com código $ExitCode; nenhum teste com decisão errada, mas algum sem decisão (ver acima)") }
  if ($ExitCode -ne 0) { return (& $done 'FALHOU' "pnpm saiu com código $ExitCode; veredito do relatório: $($check.Verdict)") }
  & $done 'FALHOU' "exit 0, mas o relatório não mostra os $($spec.PassCount) aprovados com os motivos de recusa esperados e o #15 pulado"
}

# Recuperação OFFLINE de uma execução interrompida (Ctrl+C na análise, janela fechada, processo morto: o finally
# e o pós-processamento podem não ter rodado). Só para pasta c2pw-* SEM `resultado=`. Os literais digitados não
# estão mais disponíveis, então o resumo recuperado guarda SÓ as linhas de resultado (nomes fixos do harness),
# sem anotações; o bruto é apagado sem análise. Sem fim_utc, grava fim_utc_estimado = min(agora, T0 + 29 min).
# Resultado sempre INCONCLUSIVO (interrompida). Não toca na rede.
function Invoke-C2Recovery([string]$Dir, [datetime]$UtcNow = (Get-Date)) {
  $spec = Get-C2Spec
  if (-not (Test-Path -LiteralPath $Dir -PathType Container) -or (Split-Path -Leaf $Dir) -notmatch '^c2pw-\d{8}-\d{4}(-\d+)?$') { throw 'não é uma pasta de execução c2pw-AAAAMMDD-HHMM' }
  $horario = Join-Path $Dir 'horario.txt'
  if (-not (Test-Path -LiteralPath $horario)) { throw 'horario.txt ausente: registrar a execução à mão como INCONCLUSIVO' }
  $text = Get-Content -LiteralPath $horario -Raw -Encoding utf8
  if ($text -match '(?m)^resultado=') { throw 'execução já concluída (resultado= registrado): nada a recuperar' }
  if ($text -notmatch '(?m)^inicio_utc=(?<t>\S+)') { throw 'inicio_utc ausente no horario.txt' }
  $t0 = [datetime]::Parse($Matches['t'], [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
  $now = $UtcNow.ToUniversalTime()
  if ($now -lt $t0) { throw 'relógio anterior ao inicio_utc: confira o relógio' }

  $raw = Join-Path $Dir $spec.Report
  $hadRaw = Test-Path -LiteralPath $raw
  $summary = $false
  if ($hadRaw) {
    try {
      $results = @(Get-Content -LiteralPath $raw -Encoding utf8 -ErrorAction Stop | ForEach-Object { ConvertTo-PlainReportLine $_ } | Where-Object { $_ -notmatch '^\s*↳ ' })
      Write-C2SafeSummary -Lines ($results + "$($spec.Name) exit = ausente (interrompida)") -Path (Join-Path $Dir $spec.Summary)
      $summary = $true
    } catch { }
  }
  $removed = Remove-C2Raw $raw
  $estimated = $text -notmatch '(?m)^fim_utc='
  $t1 = if ($estimated) { $cap = $t0.AddMinutes($script:MaxWindowMinutes - 1); if ($now -gt $cap) { $cap } else { $now } } else { $null }
  $add = @()
  if ($estimated) { $add += "fim_utc_estimado=$($t1.ToString('o'))" }
  $add += "resultado=INCONCLUSIVO (interrompida; recuperada em $($now.ToString('o')))"
  $add | Add-Content -LiteralPath $horario -Encoding utf8
  [pscustomobject]@{
    Outcome = 'INCONCLUSIVO'; RawFound = $hadRaw; RawRemoved = $removed; Summary = $summary
    T1Estimated = $estimated; T1 = if ($estimated) { $t1.ToString('o') } else { '' }
  }
}
