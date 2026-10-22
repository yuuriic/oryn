# POC-01A — Validação: áudio WebRTC no navegador

| Campo | Valor |
|---|---|
| Data | 22/10/2026 |
| Branch | `poc/webrtc-audio-browser`, criada a partir de `main` em `2c204f3` |
| Commits | `795b0e9` (`.gitattributes`), `ed589bd` (código validado nas execuções 4 e 5) |
| Código | `poc/webrtc-audio-browser/` |
| Relação com o ARCHITECTURE.md | Subconjunto da P01 (§14): só o navegador; WebView2 não testado |
| Status | **Aprovada pelo arquiteto** (22/10/2026) |

## 1. Ambiente

| Item | Versão / detalhe |
|---|---|
| SO | Windows 11 IoT Enterprise Subscription, 10.0.26200, x64 |
| CPU / RAM | Intel Core i5-12500H (12 núcleos), 15,7 GiB |
| Git | 2.55.0.windows.3 (`commit.gpgsign=true`, `gpg.format=ssh`) |
| Node / pnpm | 24.19.0 / 12.6.0 |
| Rust / Cargo | rustc 1.99.1 / cargo 1.99.1, toolchain `stable-x86_64-pc-windows-msvc` |
| MSVC | Visual Studio Community 2026 **Insiders** 18.12 (prerelease), MSVC 14.52.37025, Windows SDK 10.0.26100.0 |
| Navegadores | Google Chrome 155.0.8059.85, Microsoft Edge 155.0.4283.62 |

Dependências (todas `devDependencies`, com versões exatas e `pnpm-lock.yaml` versionado):

| Pacote | Versão | Uso |
|---|---|---|
| vite | 8.3.5 | Dev server em `localhost` e build |
| typescript | 7.0.2 | Typecheck estrito (`tsc --noEmit`) |
| vitest | 5.0.5 | Testes unitários |
| playwright-core | 1.64.1 | Automação do teste funcional; usa os navegadores já instalados e não baixa binários |

Nenhuma dependência de runtime. Sem Vue, Supabase, Tauri ou biblioteca WebRTC externa.

## 2. Testes automatizados aprovados

### 2.1 Typecheck e build

| Comando | Resultado |
|---|---|
| `pnpm install` | OK, 38 pacotes, sem avisos de dependência ou de scripts de build |
| `pnpm typecheck` | OK, sem erros (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) |
| `pnpm build` | OK. `dist/index.html` 5,98 kB; JS 17,55 kB (6,55 kB gzip); CSS 2,25 kB |

### 2.2 Unitários: `pnpm test`, 33/33 aprovados

| Arquivo | Cobertura |
|---|---|
| `tests/stats.test.ts` | Resolução de codec via `codecId`, parse de fmtp, extração inbound/outbound, par ICE selecionado sem endereços, taxa (kbit/s), perda, ocultação e formatação |
| `tests/errors-redact.test.ts` | Mapeamento de `DOMException` do `getUserMedia` (10 casos); resumo de candidatos e SDP **sem** IP, porta, ufrag ou fingerprint |
| `tests/summary.test.ts` | Agregação de amostras (média, mínimo, máximo, nulos e limiar de presença de áudio) |

### 2.3 Funcional no navegador: `pnpm e2e`, com microfone **falso**

O script `scripts/e2e-fake-media.mjs` inicia o dev server Vite em `localhost:5173` e abre o navegador instalado,
em modo headless, com `--use-fake-device-for-media-stream`. Nesse modo o Chromium gera um tom sintético periódico
no lugar do microfone. A instrumentação do cleanup (wrappers de `getUserMedia` e `RTCPeerConnection`) é injetada
**apenas** pelo teste.

| Execução | Navegador | Resultado | Conexão após o clique |
|---|---|---|---|
| 1 | Chrome 155.0.8059.85 | **28/28** | 1382 ms |
| 2 | Edge 155.0.4283.62 | **28/28** | 838 ms |
| 3 | Chrome 155.0.8059.85 | **28/28** | 1314 ms |
| 4 (final, código commitado) | Chrome 155.0.8059.85 | **29/29** | 1343 ms |
| 5 (final, código commitado) | Edge 155.0.4283.62 | **29/29** | 770 ms |

As execuções 4 e 5 acrescentam a verificação "nenhuma falha de `addIceCandidate`" e o registro do uso da fila
de candidatos. O tempo de conexão inclui a captura do dispositivo falso, sem diálogo de permissão humano.

Verificações cobertas, todas aprovadas em todas as execuções:

- `connectionState` = `connected` e `iceConnectionState` conectado nos peers A e B.
- Codec negociado identificado via `getStats`: **`audio/opus`, 48000 Hz, 2 canais, PT 111, fmtp `minptime=10;useinbandfec=1`**.
- Pacotes recebidos > 0, taxa recebida > 0 e pico RMS do áudio recebido acima do limiar (0,001).
- **Mute:** pico RMS recebido igual a 0, conexão mantida em `connected`/`stable` e pacotes continuando a chegar
  (ex.: 303 → 1009).
- **Unmute:** o nível recebido volta (pico RMS ≈ 0,30).
- **Saída ligada:** o `<audio>` toca sem mute e o `audioLevel` do `getStats` fica acima do limiar.
- **Cleanup após Encerrar:** track do microfone em `ended`, os dois `RTCPeerConnection` em `closed`, `<audio>`
  removido do DOM e coleta de `getStats` interrompida.
- **Reinício** depois de encerrar conecta de novo.
- **Permissão negada**, simulada com um contexto sem permissão: erro `permission-denied` exibido e "Iniciar"
  reabilitado.
- **Privacidade dos logs:** log em tela e console sem `a=candidate`, `a=fingerprint`, `ice-ufrag`, `v=0`, IPv4
  ou `.local`.
- Nenhuma violação de CSP no console.

## 3. Evidências da transmissão de áudio

O que está comprovado é o **transporte WebRTC de um sinal de áudio sintético**: captura, codificação Opus,
ICE/DTLS-SRTP, recepção, decodificação e entrega a um consumidor (Web Audio e `<audio>`). Isso vale para Chrome
e Edge 155 em loopback na mesma página. As evidências medidas são estas:

1. Pacotes RTP recebidos crescendo continuamente (≈ 50 por segundo, coerente com frames Opus de 20 ms).
2. Sinal não nulo no áudio **recebido**, medido por um `AnalyserNode` ligado à track remota, que some quando o
   emissor muta e volta quando reativa.
3. `audioLevel` do `inbound-rtp` acima de zero quando a saída `<audio>` está ligada.

A captura com microfone real e a reprodução em dispositivo físico foram **informadas pelo usuário** como
funcionais (§4). Não houve medição registrada desses testes.

**Não está comprovado por medição:** inteligibilidade, qualidade percebida, latência boca-ouvido e comportamento
fora do loopback local. Ver §5.

### Métricas observadas (resumo de cerca de 34 s por execução)

| Métrica | Chrome #1 | Edge | Chrome #3 |
|---|---|---|---|
| Pacotes recebidos | 1664 | 1668 | 1663 |
| Taxa recebida, média / máxima (kbit/s)¹ | 17,9 / 25,5 | 18,2 / 26,1 | 17,9 / 26,2 |
| RTT do par ICE (ms)² | 0–2 | 0–1 | 0–1 |
| Jitter (ms)² | 0–4 | 0–2 | 0–2 |
| Perda acumulada | 0 % | 0 % | 0 % |
| Amostras ocultadas (PLC) | 0 % | 0,015 % | 0,044 % |
| Par ICE | host ↔ host, UDP | idem | idem |

¹ `bytesSent`/`bytesReceived` contam apenas o payload RTP, sem cabeçalhos IP/UDP/RTP/SRTP. A média inclui cerca de
10 s de mute, quando o Opus envia silêncio com taxa menor (mínimo ≈ 1,2 kbit/s). Com tom sintético o pico ficou em
cerca de 25–26 kbit/s, mas voz real pode diferir.
² A resolução reportada pelo Chrome é de cerca de 1 ms. Em loopback local esses valores não representam a rede real.

## 4. Testes manuais realizados

### 4.1 Validação informada pelo usuário (22/10/2026)

O usuário executou o roteiro manual de `poc/webrtc-audio-browser/README.md` ("Testar sem microfonia") com
microfone real e informou o seguinte resultado:

| Item | Resultado informado |
|---|---|
| Transmissão do microfone real de A para B | Funcionou |
| Reprodução do áudio recebido | Funcionou |
| Mute e unmute sem interromper a conexão | Funcionou |
| Encerramento e liberação dos recursos | Funcionou |

Natureza da evidência:

- Este resultado é um **relato do usuário**. O agente não executou nem observou o teste, porque não tem acesso a
  microfone, saída de áudio ou percepção auditiva.
- Não foram registrados navegador e versão, dispositivo de entrada e saída (fones ou alto-falantes, com fio ou
  Bluetooth), duração, métricas nem o resumo JSON da sessão. Esses campos ficam como **não informados**.
- O relato não mede qualidade, inteligibilidade nem latência.

Com isso, a POC-01A tem dois tipos de evidência que se complementam: o teste automatizado com dispositivo falso
(§2.3) e a validação funcional manual informada pelo usuário.

## 5. Testes ainda não executados

| Teste | Observação |
|---|---|
| Métricas registradas de uma sessão com microfone real | O teste manual foi informado sem dados (§4.1); repetir com o resumo JSON se uma medição for necessária |
| Diálogo real de permissão e revogação durante a chamada | Só o caminho "negado" foi automatizado |
| Microfone indisponível (`NotFoundError`/`NotReadableError`) | Coberto por teste unitário de mapeamento, não reproduzido no navegador |
| Remoção de headset ou dispositivo durante a chamada (`track.onended`) | Tratamento implementado, não exercitado |
| Falha de conexão ICE e timeout de negociação (15 s) | Tratamento implementado, não exercitado (loopback não falha) |
| Latência boca-ouvido | Requer medição externa (ARCHITECTURE §12) |
| Bluetooth, troca de dispositivo, `setSinkId` e suspensão do sistema | Fora do escopo da 01A |
| Firefox e Safari | Fora da matriz inicial (§2.2) |
| `pnpm preview` (build servido) | Build gerado, mas não exercitado no navegador; o e2e usa o dev server |
| **WebView2 / Tauri** | Escopo da POC-01B |

## 6. Limitações da validação local

- **Loopback na mesma página:** não há rede real, NAT, perda ou jitter. RTT, jitter e perda ficam próximos de zero
  por construção e **não** servem como estimativa para a P02.
- **Microfone falso:** o Chromium gera um tom periódico. Ele valida o pipeline, mas não o processamento de voz
  (AEC/NS/AGC), que depende do dispositivo real.
- **Headless:** a saída de áudio vai para um dispositivo de saída do processo headless, e ninguém ouve nada.
- **Unidirecional:** só A envia. Fluxo bidirecional e múltiplos pares (mesh) ficam para a P02.
- **Sem STUN/TURN:** com `iceServers: []`, apenas candidatos host foram exercitados.
- Duas execuções no Chrome e uma no Edge formam uma amostra pequena, sem análise estatística.

## 7. Observações técnicas relevantes

1. **`audioLevel` do `inbound-rtp` no Chrome/Edge 155 depende da saída.** O valor fica em 0 enquanto o `<audio>` está
   mudo e varia com o volume do elemento. Verificado nos modos headless e headed. Consequência: ele não serve como
   indicador de "áudio chegando" nem de "está falando" quando o usuário silencia a saída (por exemplo, com deafen).
   A POC usa RMS medido na track recebida via Web Audio, antes do playout. Recomendo a mesma abordagem para
   indicadores de fala no Oryn.
2. **Opus aparece como "2 canais"** porque a RFC 7587 sempre declara `opus/48000/2` no SDP. O fmtp negociado não
   contém `stereo=1`, e a captura pede `channelCount: 1`, então a codificação deve ser mono. Isso precisa ser
   confirmado na P01/P02, se relevante para o bitrate.
3. **Sem DTX** (`usedtx` ausente) e com FEC in-band ativo (`useinbandfec=1`) por padrão. O bitrate-alvo de
   24–40 kbit/s (ARCHITECTURE §9.1) não foi configurado nesta POC; `RTCRtpSender.setParameters({ maxBitrate })`
   é o ponto de ajuste para a próxima etapa.
4. **O elemento `<audio>` precisa estar tocando, mesmo mudo,** para o Chrome entregar o áudio remoto ao Web Audio.
   A POC mantém o elemento ativo e silenciado por padrão.
5. **A fila de candidatos ICE** (ARCHITECTURE §9.2) foi implementada, mas **não chegou a ser acionada**: nas
   execuções 4 e 5, 0 candidatos foram enfileirados, porque no loopback síncrono a coleta termina depois das
   descrições remotas. Também não houve nenhuma falha de `addIceCandidate`. A fila só será exercitada de fato
   com sinalização assíncrona real (P02/P04).

## 8. Conflitos ou pontos de atenção com o ARCHITECTURE.md

- Nenhum conflito bloqueante. A POC respeita: nenhum SDP/ICE em logs (§9.2, §13), mute por desativação do envio
  (§9.2), liberação de tracks ao sair (§9.2) e ausência de persistência de áudio (§6).
- O roteiro da Etapa 02 fala em "duas abas"; os requisitos detalhados pedem "duas instâncias de
  `RTCPeerConnection`, uma por participante simulado, sem servidor de sinalização". A implementação segue os
  requisitos detalhados (loopback em uma aba). Um modo com duas abas reais via `BroadcastChannel` (também sem
  servidor) é viável se o arquiteto quiser essa variante.
- A POC fica em `poc/`, fora da estrutura de monorepo do §5, como pacote isolado com lockfile próprio. Ela é
  descartável e não deve ser promovida a `packages/voice`.
- O toolchain MSVC instalado é **Visual Studio 2026 Insiders (prerelease, expira em 14/01/2027)**. Isso não afeta
  esta POC, mas para a POC-01B e para builds reproduzíveis recomenda-se instalar as **Build Tools estáveis**.
- No Git Bash, `link.exe` do Git (`/usr/bin/link.exe`) aparece no `PATH` antes do linker MSVC. O rustc localiza o
  linker MSVC por conta própria, mas vale observar se houver erro de link na 01B.

## 9. Decisão

**POC-01A aprovada pelo arquiteto em 22/10/2026.**

A aprovação se apoia em dois tipos de evidência:

- **Automatizada:** o pipeline WebRTC nativo funciona no Chrome e no Edge 155 em loopback, com 29/29 verificações
  usando dispositivo de mídia falso (§2).
- **Manual, informada pelo usuário:** transmissão, reprodução, mute e encerramento funcionaram com microfone
  real (§4.1).

As limitações (§6) e os testes não executados (§5) continuam valendo. Entre eles: ausência de rede real e de
STUN/TURN, fluxo unidirecional, ausência de medição de latência boca-ouvido e WebView2 não testado. Esses itens
passam para a POC-01B e para as POCs P01/P02.
