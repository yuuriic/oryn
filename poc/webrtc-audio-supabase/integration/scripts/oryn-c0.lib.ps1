# ORYN — funções PURAS do executor C0 (02C.6A; substitui o script avulso da 02C.5C). Só definições: carregar
# este arquivo não executa nada, não lê o ambiente e não toca na rede. Testado por oryn-c0.selftest.ps1.
#
# Modos:
#   R  C0-R  Z1–Z4 (REST: leituras e recusas). Nenhum WebSocket.
#   W  C0-W  Z6–Z8 (WebSocket: recusas de canal para `anon`). A 1ª conexão cria as partições de realtime.messages.
# Os dois: sem identidade, sem login, sem CAPTCHA, sem convite, orçamento 0, só a chave publicável.

$script:C0Specs = @{
  R = [pscustomobject]@{
    Mode = 'R'; Name = 'C0-R'; Block = 'Supabase real — C0-R'; Filter = 'C0-R'; Report = 'c0r.txt'; Summary = 'c0r.resumo.txt'
    Expected = @('Z1', 'Z2', 'Z3', 'Z4'); NeedsRefusalNotes = $false
    EnvNames = @('ORYN_IT_PHASE', 'ORYN_PUBLISHABLE_KEY', 'ORYN_REMOTE', 'ORYN_REMOTE_REF', 'ORYN_SUPABASE_URL')
  }
  W = [pscustomobject]@{
    Mode = 'W'; Name = 'C0-W'; Block = 'Supabase real — C0-W'; Filter = 'C0-W'; Report = 'c0w.txt'; Summary = 'c0w.resumo.txt'
    Expected = @('Z6', 'Z7', 'Z8'); NeedsRefusalNotes = $true
    EnvNames = @('ORYN_IT_ALLOW_WS', 'ORYN_IT_PHASE', 'ORYN_PUBLISHABLE_KEY', 'ORYN_REMOTE', 'ORYN_REMOTE_REF', 'ORYN_SUPABASE_URL')
  }
}

function Get-C0Spec([ValidateSet('R', 'W')][string]$Mode) { $script:C0Specs[$Mode] }

function Clear-OrynEnv {
  $names = @(Get-ChildItem Env: | Where-Object { $_.Name -like 'ORYN_*' } | ForEach-Object { $_.Name } | Sort-Object)
  foreach ($n in $names) { Remove-Item -LiteralPath "Env:$n" -ErrorAction Stop }
  $left = @(Get-ChildItem Env: | Where-Object { $_.Name -like 'ORYN_*' }).Count
  Write-Host ("ORYN_* removidas: {0} [{1}]; restantes: {2}" -f $names.Count, ($names -join ', '), $left)
  if ($left -ne 0) { throw 'ainda há variáveis ORYN_* no ambiente: não prossiga' }
}

# Git: aborta se a branch, o commit ou a árvore divergirem. Recebe os valores lidos (testável sem Git).
function Assert-GitState([string]$Branch, [string]$Head, [string[]]$Porcelain, [string]$ApprovedBranch, [string]$ApprovedCommit) {
  if ($Branch -ne $ApprovedBranch) { throw "branch '$Branch' diferente de '$ApprovedBranch'" }
  if ($Head -ne $ApprovedCommit) { throw "HEAD $Head diferente do commit aprovado $ApprovedCommit" }
  $dirty = @($Porcelain | Where-Object { $_ -and $_.Trim() })
  if ($dirty.Count -gt 0) { throw "árvore com $($dirty.Count) alteração(ões) local(is) inesperada(s): $(($dirty | Select-Object -First 5) -join '; ')" }
}

# Ambiente: nada além do que a C0 usa. Cita só NOMES de variáveis.
function Assert-CleanEnvironment {
  $forbidden = @(Get-ChildItem Env: | Where-Object {
      $_.Name -like 'ORYN_*' -or $_.Name -match '^SUPABASE_(DB_PASSWORD|ACCESS_TOKEN|SERVICE_ROLE_KEY|SECRET_KEYS?)$' -or $_.Name -match 'CAPTCHA'
    } | ForEach-Object { $_.Name })
  if ($forbidden.Count -gt 0) { throw "variáveis proibidas no ambiente: $($forbidden -join ', ')" }
  $adminLike = @(Get-ChildItem Env: | Where-Object { $_.Value -match 'sb_secret_|sbp_[A-Za-z0-9]|service_role' } | ForEach-Object { $_.Name })
  if ($adminLike.Count -gt 0) { throw "credencial administrativa no ambiente (nomes): $($adminLike -join ', ')" }
}

# Variáveis ORYN_* do processo: exatamente as da fase (o portão do harness também confere os valores).
function Assert-OrynEnvSet([string[]]$Actual, [string[]]$Expected) {
  $a = @($Actual | Sort-Object); $e = @($Expected | Sort-Object)
  if (Compare-Object $a $e) { throw "variáveis ORYN_* diferentes do esperado: [$($a -join ', ')] (esperado [$($e -join ', ')])" }
}

# Pasta de evidências UTC, criada ANTES do relatório e nunca sobrescrita: <prefixo>-YYYYMMDD-HHmm, -2, -3…
function New-EvidenceDir([string]$Root, [datetime]$UtcNow, [string]$Prefix) {
  if (-not (Test-Path -LiteralPath $Root -PathType Container)) { throw "raiz de evidências inexistente: $Root" }
  $base = Join-Path $Root ($Prefix + '-' + $UtcNow.ToString('yyyyMMdd-HHmm'))
  $path = $base; $i = 1
  while (Test-Path -LiteralPath $path) { $i++; $path = "$base-$i" }
  New-Item -ItemType Directory -Path $path -ErrorAction Stop | Out-Null
  return (Resolve-Path -LiteralPath $path).Path
}

# Normaliza uma linha do relatório ANTES de qualquer expressão (02C.5C):
# 1. remove sequências ANSI (cores do Vitest, inclusive nos separadores " > ");
# 2. desfaz o mojibake da cp850 (UTF-8 do Node decodificado pela página OEM do console). Genérico: os bytes
#    iniciais de UTF-8 multibyte viram `├` (C3), `┬` (C2) ou `Ô` (E2) na cp850. O reparo só é aceito se a linha
#    inteira é representável na cp850 (ida e volta exata) E os bytes formam UTF-8 VÁLIDO (decodificador estrito).
#    Texto já correto (com ✓, que não existe na cp850) ou um `Ô` legítimo seguido de ASCII ficam intocados.
$script:Cp850 = [Text.Encoding]::GetEncoding(850)
$script:StrictUtf8 = [Text.UTF8Encoding]::new($false, $true)
function ConvertTo-PlainReportLine([string]$Line) {
  $s = $Line -replace "\x1b\[[0-9;?]*[A-Za-z]", ''
  if ($s -notmatch '[├┬Ô]') { return $s }
  $bytes = $script:Cp850.GetBytes($s)
  if ($script:Cp850.GetString($bytes) -cne $s) { return $s }
  try { return $script:StrictUtf8.GetString($bytes) } catch { return $s }
}

# Relatório do Vitest (--reporter=verbose) no modo dado. Ok só se:
#  - a linha "Tests" existe, com exatamente N aprovados (N = Z esperados) e 0 falhas;
#  - cada Z esperado aparece UMA vez com ✓, dentro do bloco do modo; nenhum ✓ fora dele; nenhuma linha ×;
#  - (C0-W) cada Z tem a anotação do harness com CHANNEL_ERROR: a recusa veio do servidor (o teste já exige; o
#    validador confere de novo e extrai o motivo, credencial × autorização).
# Exit 0 SOZINHO nunca basta: sem ORYN_IT_ALLOW_WS o filtro C0-W sai com 0 e nenhum teste executado.
function Test-C0Report([string[]]$Lines, [ValidateSet('R', 'W')][string]$Mode) {
  $spec = Get-C0Spec $Mode
  $Lines = @($Lines | ForEach-Object { ConvertTo-PlainReportLine $_ })
  $text = $Lines -join "`n"
  $blockRe = [regex]::Escape($spec.Block)
  $isResult = { param($l) $l -match '^\s*(✓|×|↓|□) ' }
  $passedLines = @($Lines | Where-Object { $_ -match '^\s*✓ ' })
  $failedLines = @($Lines | Where-Object { $_ -match '^\s*× ' })
  $outside = @($passedLines | Where-Object { $_ -notmatch "$blockRe[^>]*> (Z\d) " -or $spec.Expected -notcontains $Matches[1] })

  $perZ = foreach ($z in $spec.Expected) {
    $idx = @(for ($i = 0; $i -lt $Lines.Count; $i++) { if ($Lines[$i] -match "^\s*✓ .*$blockRe[^>]*> $z ") { $i } })
    $note = ''
    if ($idx.Count -eq 1) {
      for ($j = $idx[0] + 1; $j -lt $Lines.Count -and -not (& $isResult $Lines[$j]); $j++) {
        if ($Lines[$j] -match '^\s*↳ (?<n>.+)$') { $note = $Matches['n'].Trim(); break }
      }
    }
    $refused = $note -match ': CHANNEL_ERROR\b'
    $reason = if ($note -match ': CHANNEL_ERROR \((?<r>.*)\)\s*$') { $Matches['r'] } else { '' }
    [pscustomobject]@{
      Z        = $z
      Passed   = $idx.Count -eq 1
      Note     = $note
      Refused  = $refused
      Kind     = if (-not $refused) { '' } elseif ($reason -match 'jwt|token') { 'credencial' } else { 'autorização' }
    }
  }

  $summary = [regex]::Match($text, '(?m)^\s*Tests\s+(?<body>[^\r\n]+)')
  $passed = if ($summary.Success -and $summary.Groups['body'].Value -match '(\d+) passed') { [int]$Matches[1] } else { -1 }
  $failed = if ($summary.Success -and $summary.Groups['body'].Value -match '(\d+) failed') { [int]$Matches[1] } else { 0 }
  $zOk = @($perZ | Where-Object { $_.Passed -and (-not $spec.NeedsRefusalNotes -or $_.Refused) })
  [pscustomobject]@{
    Ok          = ($passed -eq $spec.Expected.Count) -and ($failed -eq 0) -and ($failedLines.Count -eq 0) -and ($outside.Count -eq 0) -and ($zOk.Count -eq $spec.Expected.Count)
    Mode        = $spec.Name
    Passed      = $passed
    Failed      = $failed + 0
    FailedLines = $failedLines.Count
    Outside     = $outside.Count
    ZFound      = (@($perZ | Where-Object Passed) | ForEach-Object Z) -join ','
    PerZ        = $perZ
    SummaryLine = if ($summary.Success) { 'Tests ' + $summary.Groups['body'].Value.Trim() } else { '(sem linha de resumo)' }
  }
}

# Padrões sensíveis + o valor literal da chave digitada. Devolve SÓ contagens.
function Measure-Sensitive([string]$Path, [string]$Literal) {
  $content = Get-Content -LiteralPath $Path -Raw -ErrorAction Stop
  if ($null -eq $content) { $content = '' }
  $patterns = [ordered]@{
    jwt         = 'eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}'
    publishable = 'sb_publishable_[A-Za-z0-9_-]{6,}'
    secret      = 'sb_secret_[A-Za-z0-9_-]{6,}'
    pat         = 'sbp_[A-Za-z0-9]{10,}'
  }
  $counts = [ordered]@{}
  foreach ($k in $patterns.Keys) { $counts[$k] = [regex]::Matches($content, $patterns[$k]).Count }
  $counts['chave_digitada'] = if ($Literal) { ([regex]::Matches($content, [regex]::Escape($Literal))).Count } else { 0 }
  $counts['total'] = ($counts.Values | Measure-Object -Sum).Sum
  return [pscustomobject]$counts
}

# Resumo compartilhável: só linhas de resultado e anotações, normalizadas, com UUIDs, JWTs e chaves mascarados.
function Write-SafeSummary([string[]]$Lines, [string]$Path) {
  $Lines | ForEach-Object { ConvertTo-PlainReportLine $_ } |
    Where-Object { $_ -match '^\s*(✓|×|↓|□) |Test Files|Tests\s|exit = |^\s*↳ ' } |
    ForEach-Object {
      $_ -replace 'eyJ[A-Za-z0-9_.-]+', '<jwt>' -replace 'sb_(publishable|secret)_[A-Za-z0-9_-]+', '<chave>' -replace 'sbp_[A-Za-z0-9]+', '<pat>' `
        -replace '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}', '<uuid>'
    } | Set-Content -LiteralPath $Path -Encoding utf8
}

# Executa um comando nativo com a saída espelhada no console E gravada em $Report, e devolve o exit code DELE.
# - $PSNativeCommandUseErrorActionPreference = $false: com ErrorActionPreference=Stop, exit ≠ 0 não vira exceção
#   (que pularia a captura do código);
# - $LASTEXITCODE é lido na linha seguinte ao pipeline (o Tee-Object não o altera; validado no selftest);
# - o arquivo é criado vazio ANTES, para que "relatório ausente" e "relatório vazio" sejam distinguíveis.
function Invoke-NativeTee([scriptblock]$Command, [string]$Report) {
  $PSNativeCommandUseErrorActionPreference = $false
  if (-not (Test-Path -LiteralPath (Split-Path -Parent $Report) -PathType Container)) { throw "pasta do relatório inexistente: $Report" }
  New-Item -ItemType File -Path $Report -ErrorAction Stop | Out-Null
  $global:LASTEXITCODE = $null
  & $Command 2>&1 | Tee-Object -LiteralPath $Report | Out-Host   # Out-Host: a saída não se mistura ao retorno
  $code = $global:LASTEXITCODE
  if ($null -eq $code) { throw 'o comando nativo não informou exit code' }
  return [int]$code
}

# Console em UTF-8 e Vitest sem cores durante a execução (prevenção na origem; a normalização acima continua).
function Enter-PlainConsole {
  $state = [pscustomobject]@{ Console = [Console]::OutputEncoding; Output = $global:OutputEncoding; NoColor = $env:NO_COLOR; ForceColor = $env:FORCE_COLOR }
  $utf8 = [Text.UTF8Encoding]::new($false)
  [Console]::OutputEncoding = $utf8; $global:OutputEncoding = $utf8
  $env:NO_COLOR = '1'; Remove-Item Env:FORCE_COLOR -ErrorAction SilentlyContinue
  return $state
}

function Exit-PlainConsole($State) {
  if ($null -eq $State) { return }
  [Console]::OutputEncoding = $State.Console; $global:OutputEncoding = $State.Output
  if ($null -eq $State.NoColor) { Remove-Item Env:NO_COLOR -ErrorAction SilentlyContinue } else { $env:NO_COLOR = $State.NoColor }
  if ($null -ne $State.ForceColor) { $env:FORCE_COLOR = $State.ForceColor }
}
