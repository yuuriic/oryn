# POC-02A — Validação: áudio WebRTC bidirecional PC ↔ celular (LAN)

| Campo | Valor |
|---|---|
| Data | 22/10/2026 |
| Branch | `poc/webrtc-audio-lan`, criada a partir de `main` em `ad8059d` (merge do PR #2) |
| Pull Request | [#3](https://github.com/yuuriic/oryn/pull/3) (`poc/webrtc-audio-lan` → `main`), em revisão arquitetural |
| Commit de referência | `4b6ac1d` (`4b6ac1da090882cdb5b169db55cc11ff82a92a87`): implementação **originalmente submetida** no PR #3. As validações de 22/10/2026 (§5, §6 e §6.1) foram feitas sobre esse conteúdo |
| HEAD atual | **Não fixado neste documento:** muda com as correções da revisão (§12). Consulte o PR #3 ou `git log` da branch |
| Código | `poc/webrtc-audio-lan/` |
| Relação com o ARCHITECTURE.md | Primeiro passo da P02 (§14): dois pares reais com sinalização; sem TURN, sem mesh de N pares |
| Status | **Testes automatizados aprovados; validação manual PC ↔ iPhone informada e confirmada pelo usuário e métricas de uma chamada real registradas a partir de captura de tela, em 22/10/2026 (§6). Correções da revisão do PR #3 aplicadas (§12). Aguardando encerramento arquitetural formal; PR não integrado** |

Legenda:
- **[Observado]:** medido em execução automatizada nesta máquina.
- **[Inferido]:** conclusão a partir de observações ou documentação, sem verificação direta.
- **[Informado pelo usuário]:** resultado relatado e confirmado pelo usuário; o agente não executou nem observou
  o teste (§6).
- **[Evidência visual fornecida pelo usuário]:** valores lidos de uma captura de tela enviada pelo usuário; não
  são medições do agente (§6.1).
- **[Não executado]:** teste que não foi feito.

## 1. Objetivo

Validar uma chamada de áudio WebRTC **bidirecional** entre duas instâncias reais: o navegador no PC Windows e o
navegador no celular, na mesma rede local. A sinalização passa por um servidor WebSocket mínimo, e o celular acessa
por HTTPS com certificado local confiável.

## 2. Arquitetura implementada

```text
PC: navegador A ── http://localhost:5180 ──┐                 ┌── https://<IP-DA-LAN>:5443 ── navegador B: celular
                  ws://localhost:5180/ws   │                 │   wss://<IP-DA-LAN>:5443/ws
                                           ▼                 ▼
                        Servidor Node (server/): estáticos + sinalização, sem mídia
                        HTTP só em 127.0.0.1 · HTTPS/WSS só no IP da LAN
A ◄══════════ áudio Opus via WebRTC (DTLS-SRTP), direto entre os aparelhos, ICE host ══════════► B
```

**Servidor** (`server/`), Node 24 executando TypeScript nativamente (type stripping):
- **`registry.ts`:** lógica pura de sessões.
  - IDs de 128 bits (`crypto.randomBytes(16)` em base64url);
  - no máximo 2 participantes, 20 sessões simultâneas e expiração após 10 min sozinho;
  - `epoch` incrementado a cada par formado, e sinais de epoch antigo são rejeitados;
  - só o host oferta e só o guest responde;
  - quem chega depois que o host saiu vira host.
- **`server.ts`:**
  - HTTP somente em loopback literal (padrão `127.0.0.1`; `::1` aceito; qualquer outro valor é rejeitado antes de
    abrir listeners, ver §12.2), e HTTPS (TLS ≥ 1.2) somente no IP da LAN;
  - WebSocket em `/ws` com `Origin` obrigatório e exato;
  - `maxPayload` de 16 KiB, mensagens binárias recusadas (código 1003);
  - token bucket por conexão (fecha com 1008 após reincidência) e heartbeat ping/pong de 15 s;
  - estáticos só do build;
  - cabeçalhos: CSP, `nosniff`, `no-referrer`, `Permissions-Policy`, COOP e `no-store`;
  - `/api/info` com a origem HTTPS, exposto apenas no listener local.
- **`certs.ts` / `certs-cli.ts`:** geração via OpenSSL, detalhada em §4.
- **`share-ca.ts`:** download temporário (5 min) do certificado **público** da CA, com SHA-256 para conferência.

**Protocolo compartilhado** (`src/protocol.ts`), usado pelo navegador e pelo servidor:
- mensagens `create`, `join`, `signal` (`offer`/`answer`/`candidate`) e `leave`;
- validação estrita: chaves extras rejeitadas, tamanho máximo, SDP iniciando em `v=0`, candidato iniciando em
  `candidate:`, faixas numéricas;
- o cliente também valida as mensagens que vêm do servidor.

**Cliente** (`src/`), TypeScript + Vite, sem frameworks:
- **`call.ts`**, classe `PeerCall`:
  - microfone pedido no gesto do usuário, depois a sinalização;
  - uma `RTCPeerConnection` por par, com `iceServers: []`;
  - fila serializada de operações SDP;
  - candidatos enfileirados (até 64) até haver descrição remota;
  - descarte de sinais de epoch antigo e fora de ordem;
  - Opus primeiro via `setCodecPreferences`;
  - mute por `track.enabled`;
  - timeout de negociação de 20 s e stats a cada 1 s;
  - guarda de encerramento após cada `await` (lição da POC-01B).
- **`signaling-client.ts`:** `ws://` em HTTP local e `wss://` em HTTPS, timeout de conexão, e `close()` cancela a
  conexão pendente.
- **`main.ts`:**
  - interface responsiva, com alvos de toque de 44 px;
  - QR code do convite (`uqr`, montado por DOM, sem `innerHTML`);
  - convite pelo fragmento `#s=`, removido da barra de endereço e tratado também em `hashchange`;
  - medidores via Web Audio e saída `<audio>` começando sem som.
- **Copiados da POC-01B**, com atribuição: `stats.ts`, `errors.ts` e `redact.ts`. O `stats.ts` foi estendido com
  `remote-inbound-rtp`, `formatMetric` ("indisponível" em vez de 0) e `describePair`.

## 3. Dependências e versões

| Item | Versão | Observação |
|---|---|---|
| Node / pnpm | 24.19.0 / 12.6.0 | Node executa `.ts` do servidor sem build |
| OpenSSL | 3.5.7 (Git for Windows) | Geração local dos certificados |
| `ws` | 8.22.0 | **Runtime do servidor**; o Node não tem servidor WebSocket nativo. MIT, sem dependências |
| `uqr` | 0.1.3 | **Runtime do cliente**; QR code do convite. MIT, sem dependências |
| typescript / vite / vitest | 7.0.2 / 8.3.5 / 5.0.5 | Iguais às POCs anteriores |
| `@types/node` / `@types/ws` | 24.19.2 / 8.18.2 | Tipos do servidor |
| playwright-core | 1.64.1 | e2e com os navegadores instalados |
| Navegadores do e2e | Chrome 155.0.8059.85 (A), Edge 155.0.4283.62 (B) | Processos separados |

`pnpm audit`: nenhuma vulnerabilidade conhecida **[Observado]**.

## 4. Certificados e HTTPS/WSS

- **Problema:** o celular só libera `getUserMedia` em contexto seguro, então precisa de HTTPS confiável. O PC usa
  `http://localhost`, que já é contexto seguro, e **não precisa confiar em nenhum certificado**.
- **Solução local, sem serviços externos ou pagos:**
  - **CA própria (ECDSA P-256)** com `basicConstraints CA:TRUE, pathlen:0`, `keyUsage keyCertSign/cRLSign` e
    **`nameConstraints` críticos**: só `IP:<IP-DA-LAN>/32` e `DNS:localhost`;
  - **certificado do servidor** com `CA:FALSE`, `serverAuth` e SAN `IP:<IP-DA-LAN>, DNS:localhost`;
  - validade de 30 dias (1 a 90 configurável);
  - **chave privada da CA apagada** após a emissão;
  - arquivos em `%LOCALAPPDATA%\oryn-poc-lan\certs\`, **fora do repositório**.
- **Sem bypass:** nenhuma flag de navegador ignora erros de certificado e nenhuma verificação TLS é desabilitada,
  nem nos testes, que confiam explicitamente apenas na CA gerada.
- **Nada é instalado automaticamente** (nem no Windows, nem no celular, nem no firewall). Instalar a CA no celular
  e permitir o Node no Firewall do Windows são passos manuais do usuário, documentados em
  `poc/webrtc-audio-lan/README.md`, assim como a remoção da CA depois do teste.
- **Transferência da CA:** recomenda-se cabo USB. A alternativa `pnpm share-ca` é HTTP com SHA-256 exibido para
  conferência obrigatória, porque um atacante na mesma rede poderia trocar o arquivo.
- **[Observado, em teste]** O `nameConstraints` funciona: um certificado para `10.9.8.7`, emitido pela própria CA
  (chave mantida só no teste), é rejeitado pelo `openssl verify` com *"permitted subtree violation"*. O legítimo
  verifica normalmente.
- **[Informado pelo usuário]** No **iPhone (Safari)**, o HTTPS funcionou com a CA local, depois da conferência do
  certificado (§6). **[Inferido do relato]** O iOS aceitou a CA de usuário com `nameConstraints` e ECDSA P-256.
  A forma exata de conferência e os passos de confiança não foram detalhados.
- **[Não executado]** Chrome no Android: não testado.

## 5. Resultados automatizados [Observado]

### 5.1 Typecheck, testes e build

| Verificação | Resultado |
|---|---|
| `pnpm typecheck` (frontend + servidor + testes, `erasableSyntaxOnly`) | OK |
| `pnpm test` | **127/127**, 8 arquivos, nenhum pulado |
| `pnpm build` | OK: JS 35,54 kB (12,88 kB gzip), CSS 2,68 kB |
| `pnpm audit` | Sem vulnerabilidades conhecidas |

| Arquivo | Testes | Cobertura (numeração da solicitação) |
|---|---|---|
| `protocol.test.ts` | 32 | (3, 9) Validação estrita de mensagens, limites de tamanho em bytes UTF-8, mensagens do servidor, preferência por Opus |
| `registry.test.ts` | 15 | (1–4) Criação/entrada, limite de 2, encaminhamento, papéis, epoch, saída, troca de host, expiração, `closeAll`, logs sem SDP/ID; token bucket |
| `server.integration.test.ts` | 14 | (1–4, 9) Servidor real + clientes `ws`: cabeçalhos, 404/405, path traversal, `Origin`/caminho (403), sessão completa, 3º recusado, IDs de 128 bits, desconexão, heartbeat, desligamento (1001), JSON inválido, binário (1003), > 16 KiB (1009), rate limit (1008), epoch/papel, logs sem SDP/ufrag/IP/ID |
| `tls.test.ts` | 12 | (10) Certificados reais via OpenSSL; HTTPS/WSS verificando a cadeia só com a CA local; falha sem a CA; `Origin` estranho recusado em WSS; `/api/info` ausente no HTTPS; TLS 1.0/1.1 recusados; `nameConstraints`; chave da CA apagada; detecção de IP errado/expiração; `ws://` vs `wss://` |
| `call.test.ts` | 16 | (5–8) Duas `PeerCall` pelo registro real: offer/answer, candidatos antes da offer enfileirados, Opus primeiro, epoch antigo/fora de ordem, troca de par, timers após encerrar/durante a permissão/durante a negociação/timeout, mute independente, permissão negada, sessão inexistente/cheia, falha/queda de sinalização, falha de ICE, microfone desconectado, métricas ausentes como `null` |
| `signaling-client.test.ts` | 7 | (6, 8) Conexão, timeout sem timers, cancelamento por `close()`, queda vs. fechamento local, mensagens inválidas do servidor; `remote-inbound-rtp` e "indisponível" |
| `stats.test.ts`, `errors-redact.test.ts` | 16 + 15 | Herdados da POC-01B |

**Teste de mutação manual** (`call.ts` alterado temporariamente e restaurado em seguida) **[Observado]**:

| Mutação | Testes que falharam |
|---|---|
| Fila de candidatos removida | 5 |
| Checagem de `epoch` removida | 1 |
| `clearInterval` do stats removido | 5 |

### 5.2 E2E com dois navegadores reais: `pnpm e2e`

- **Configuração:** Chrome 155 (A) e Edge 155 (B) em **processos separados**, cada um com **microfone falso**
  (tom sintético do Chromium).
- **Caminho:** servidor real e WebRTC real entre os dois, via `http://localhost` (sem HTTPS, sem celular).

| Execução | Resultado | Conexão após "Entrar" |
|---|---|---|
| 1 | Falhou: 1 aprovada, 1 reprovada e interrupção por timeout | — |
| 2 | **27/27** | 1289 ms |
| 3 | **27/27** | 1266 ms |

A execução 1 revelou um **defeito real**: um link de convite aberto numa aba que já estava na página não preenchia
o código, porque só o fragmento mudava e a página não recarregava. Foi corrigido com o tratamento de `hashchange`
(§8).

Verificações das execuções 2 e 3:
- **Sessão:** criada com ID de 22 caracteres; o link preenche o código e limpa o fragmento; A e B ficam
  `connected`.
- **Mídia:**
  - Opus nos dois lados (`48000 Hz · PT 111 · minptime=10;useinbandfec=1`);
  - A e B enviam e recebem pacotes;
  - par ICE `host ↔ host · udp`, sem endereços;
  - **áudio nos dois sentidos:** RMS recebido por A ≈ 0,31 e por B ≈ 0,30–0,31.
- **Mute independente:**
  - A mutado: B recebe 0, A continua recebendo B (≈ 0,31) e a conexão segue `connected`;
  - B mutado: A recebe 0 e B volta a receber A.
- **Saída:** com "Ouvir participante" ligado, a reprodução fica "tocando (volume 50%)".
- **Terceiro participante:** recusado ("A sessão já tem dois participantes"), com o microfone dele liberado; A e B
  seguem conectados.
- **A encerra:** tracks `ended`, peer `closed`, `<audio>` removido, métricas mostram "indisponível". B fecha o peer,
  mantém o microfone e volta a aguardar.
- **Nova entrada:** A volta à mesma sessão e o áudio retoma nos dois sentidos.
- **Final:** todas as tracks `ended` e peers `closed`; servidor sem sessões.
- **Privacidade:** páginas, console e servidor sem SDP, candidatos, IPs nem o ID completo da sessão.
- **CSP:** nenhuma violação.

### 5.3 Métricas observadas (loopback no PC, microfone falso)

| Métrica | A (Chrome) | B (Edge) |
|---|---|---|
| Pacotes enviados / recebidos (cerca de 5 s) | 248 / 248 | 226–228 / 227–228 |
| Taxa enviada / recebida | ≈ 25 / 25 kbit/s | ≈ 25 / 25 kbit/s |
| RTT | 1,0 ms (RTCP `remote-inbound-rtp`) | 1,0 ms (RTCP) |
| Jitter recebido | 0–1 ms | 0–1 ms |
| Perda (recebido / visão do outro lado) | 0 % / 0 % | 0 % / 0 % |
| Par ICE | host ↔ host · udp | host ↔ host · udp |

**[Inferido]** Esses valores são de dois navegadores no **mesmo PC**, sem Wi-Fi. Não representam a LAN real. As
métricas de uma chamada real Windows ↔ iPhone estão em §6.1.

## 6. Validação manual — informada e confirmada pelo usuário (22/10/2026)

Os resultados abaixo foram **informados e confirmados pelo usuário**. O agente **não executou nem observou** esses
testes: não teve acesso ao iPhone, ao áudio nem à rede.

**Ambiente informado:**

| Item | Informado |
|---|---|
| Cliente A | Windows, navegador desktop (navegador e versão não informados) |
| Cliente B | iPhone, Safari (modelo e versões do iOS e do Safari não informados) |
| Rede | LAN / Wi-Fi |
| HTTPS no iPhone | Funcionando com a CA local verificada |
| Comunicação | WebRTC bidirecional, sem servidor intermediário de mídia |

**Checklist** (roteiro em `poc/webrtc-audio-lan/README.md`):

| # | Passo | Resultado |
|---|---|---|
| 0 | Certificados, CA instalada e verificada no celular, servidor iniciado | **[Informado pelo usuário]** HTTPS no iPhone funcionando com a CA local verificada |
| 1–4 | Criar a sessão no PC, abrir o link HTTPS no iPhone, entrar e conceder o microfone nos dois | **[Inferido do relato]** Realizados: o áudio só flui nos dois sentidos com a sessão estabelecida e o microfone liberado nos dois aparelhos. Os detalhes de cada passo não foram relatados |
| 5 | Áudio Windows → iPhone | **[Informado pelo usuário] APROVADO** |
| 6 | Áudio iPhone → Windows | **[Informado pelo usuário] APROVADO** |
| 7 | Mute/unmute independente | **[Informado pelo usuário] APROVADO** nos dois dispositivos |
| — | Funcionamento durante alguns minutos | **[Informado pelo usuário]** Confirmado qualitativamente; duração exata não informada |
| 8 | Encerrar e conferir a liberação de recursos (indicador de microfone, outro lado volta a aguardar) | **[Informado pelo usuário]** Encerramento da sessão sem problemas relatados. **A liberação completa de recursos nos aparelhos não foi comprovada:** tracks, peers e timers foram verificados **apenas** nos testes automatizados (§5) |
| — | Métricas reais (codec, taxas, pacotes, perda, jitter, RTT, par ICE, estados) | **[Evidência visual fornecida pelo usuário]** Registradas em §6.1 |
| — | Navegador do PC, modelo do iPhone e versões | **Não informados** |
| — | Problemas relatados durante a chamada | **Nenhum** |
| — | **Remover a CA local do iPhone** (Ajustes → Geral → VPN e Gerenciamento de Dispositivos → perfil "Oryn POC-02A Local CA" → Remover) | **Pendente; deve ser feito após a validação.** A confiança total em Ajustes → Geral → Sobre → Ajustes de Confiança de Certificados deixa de valer com a remoção do perfil. Apagar também `%LOCALAPPDATA%\oryn-poc-lan\` no PC |

**O que esta validação não comprova:**
- **Estabilidade prolongada:** só há confirmação qualitativa de "alguns minutos" e uma captura pontual (§6.1); não
  há série temporal.
- **Latência ponta a ponta (boca-ouvido):** não foi medida. O RTT RTCP de §6.1 não a substitui.
- **Qualidade percebida detalhada:** não informada.
- **Liberação completa de recursos nos aparelhos:** o encerramento ocorreu sem problemas relatados, mas não houve
  verificação de tracks, indicador de microfone ou `ConsentStore`.
- **Representatividade das métricas:** são de uma única chamada, numa única rede e num único instante.
- **Comportamento no Android, com STUN/TURN ou fora da LAN:** não testado e **não validado**.

### 6.1 Métricas observadas em chamada real — 22/10/2026

**Classificação da evidência: [Evidência visual fornecida pelo usuário].** Os valores foram lidos de uma captura de
tela do painel de observabilidade da POC, feita pelo usuário durante uma chamada real Windows ↔ iPhone. O agente não
executou a medição nem viu a chamada. O relato não identifica qual dos dois aparelhos aparece na captura, e cada
lado mostra as próprias estatísticas.

| Indicador | Valor observado |
|---|---|
| Codec | audio/opus |
| Frequência | 48.000 Hz |
| Canais | 2 |
| Payload Type | 111 |
| Taxa enviada | 18,0 kbit/s |
| Taxa recebida | 31,6 kbit/s |
| Pacotes enviados | 8.231 |
| Pacotes recebidos | 8.213 |
| Perda recebida | 0,16% — 13 pacotes |
| Perda enviada, visão remota | 0,00% |
| Jitter recebido | 1,0 ms |
| RTT (RTCP) | 3,5 ms |
| Par ICE selecionado | host ↔ host |
| Transporte ICE | UDP |
| Estado do par ICE | succeeded |
| connectionState | connected |
| iceConnectionState | connected |
| iceGatheringState | complete |
| signalingState | stable |
| Sinalização WebSocket | conectada |
| Microfone | capturando |
| Reprodução | tocando |

**Como a interface calcula cada campo [Observado no código, `src/call.ts` e `src/stats.ts`].** Isso define o que
cada número representa:

| Campo | Origem no `getStats()` | Natureza do valor |
|---|---|---|
| Taxas enviada/recebida | Diferença de `bytesSent`/`bytesReceived` entre duas coletas (1 s), só payload RTP | **Amostra de 1 s**, não média |
| Pacotes | `packetsSent` / `packetsReceived` | Acumulados desde o início da conexão |
| Perda recebida | `packetsLost / (packetsLost + packetsReceived)` do `inbound-rtp` | **Acumulada** desde o início |
| Perda enviada, visão remota | `fractionLost` do `remote-inbound-rtp` | **Último relatório RTCP** apenas, não acumulada |
| Jitter recebido | `jitter` do `inbound-rtp` | Estimativa corrente (RFC 3550), não média nem percentil |
| RTT (RTCP) | `roundTripTime` do `remote-inbound-rtp` | Última medição RTCP |
| Codec | Codec do `outbound-rtp` (ou do `inbound-rtp` na falta dele) | Sentido de envio do cliente da captura |

**Interpretação técnica:**

- **RTT.** O RTT RTCP de 3,5 ms é compatível com uma conexão de baixa latência em LAN. **Não equivale à latência
  ponta a ponta** entre a captura da voz e a reprodução, que inclui captura, codificação, buffer de jitter,
  decodificação e saída de áudio, e não foi medida.
- **Jitter.** O jitter recebido de 1,0 ms indica baixa variação temporal dos pacotes **na amostra apresentada**. Não
  representa média, percentil nem garantia de estabilidade prolongada.
- **Perda de pacotes.**
  - A perda recebida de 0,16% (13 pacotes) foi baixa na amostra. **Consistência verificada:** 13 / (8.213 + 13) =
    0,158% ≈ 0,16%.
  - A perda enviada de 0,00% vem apenas do último relatório RTCP do outro lado.
  - Os pacotes enviados (8.231) e recebidos (8.213) são **fluxos de sentidos opostos**; a diferença entre eles não
    é uma medida de perda.
  - Não extrapolar para outras redes ou períodos.
- **Taxas.** São amostras instantâneas de 1 s, e a diferença entre envio (18,0) e recepção (31,6 kbit/s) não foi
  investigada. **[Inferido]** É compatível com o Opus em taxa variável conforme o conteúdo de cada sentido (fala ou
  silêncio) naquele segundo; não foi verificado.
- **Codec.** O Opus foi efetivamente negociado, a 48 kHz e PT 111. A indicação de 2 canais vem da descrição do
  codec no SDP (RFC 7587 sempre declara `opus/48000/2`) e **não comprova que o áudio capturado seja estéreo**; a
  captura pede `channelCount: 1`. O campo mostra o codec do sentido de envio do aparelho da captura; o do sentido
  oposto não aparece separadamente.
- **ICE.** O par `host ↔ host` via UDP, em estado `succeeded`, mostra o uso de candidatos locais. A evidência é
  **consistente com uma conexão P2P direta na LAN, sem relay TURN**, que a POC nem configura (`iceServers: []`).
  **Não se afirma** que o mesmo comportamento ocorrerá em redes externas.
- **Estados.** `connected`, `connected`, `complete` e `stable`, com sinalização conectada, microfone capturando e
  reprodução tocando, indicam uma chamada estabelecida e ativa **no instante da captura**.
- **[Inferido]** A contagem de pacotes é compatível com o relato qualitativo de "alguns minutos" de chamada. A
  duração exata não foi informada e não é estimada aqui.

## 7. Diferenças em relação às POCs anteriores

| Aspecto | POC-01A/01B | POC-02A |
|---|---|---|
| Participantes | 2 `RTCPeerConnection` na mesma página (loopback) | 2 dispositivos/processos reais, 1 `RTCPeerConnection` cada |
| Direção | A → B | **A ↔ B** |
| Sinalização | Em memória | Servidor WebSocket com validação, limites e epoch |
| Transporte da página | `localhost` / `tauri.localhost` | `localhost` no PC e **HTTPS com CA local** no celular |
| Ordem e corrida | Não aplicável | Candidatos antes da offer, sinais fora de ordem ou de epoch antigo, troca de par |
| Métricas | inbound/outbound/par ICE | + `remote-inbound-rtp` (RTT RTCP, perda vista pelo outro lado), "indisponível" explícito |
| Medidor recebido | Pico RMS por amostra | Medidor contínuo (rAF) |
| Código | — | `stats`/`errors`/`redact` copiados da 01B; `session.ts` substituído por `call.ts` |

## 8. Problemas encontrados

1. **[Observado, corrigido]** Link de convite numa aba já aberta não preenchia o código (só o fragmento mudava).
   Agora `hashchange` é tratado e o código não é trocado durante uma chamada ativa.
2. **[Observado, corrigido durante a implementação]** Encerrar durante a conexão WebSocket deixaria o timer de
   timeout (8 s) ativo. Agora `close()` cancela a conexão pendente, e isso é coberto por teste. É a mesma classe de
   defeito corrigida na POC-01B.
3. **[Observado]** O PC tem mais de uma interface IPv4 privada, uma delas virtual. A detecção automática do IP da
   LAN não é confiável, então `certs` e `serve` exigem `--ip` e listam as opções.

## 9. Limitações

- **Validação real limitada (§6):**
  - um único par Windows ↔ iPhone (Safari), numa LAN/Wi-Fi, informado pelo usuário;
  - métricas de uma única captura de tela (§6.1), sem série temporal nem duração exata;
  - sem verificação de liberação de recursos nos aparelhos;
  - sem teste com Android.
- **Só LAN, sem STUN/TURN:**
  - redes com isolamento de clientes, VLANs separadas, VPN ou CGNAT não funcionarão;
  - a falha de ICE é tratada com mensagem e timeout de 20 s, sem ICE restart.
- **Mudanças de rede:** um IP do PC que muda (DHCP) exige gerar e instalar uma nova CA, e o certificado expira em
  30 dias. A queda de Wi-Fi ou a troca de rede durante a chamada não foram testadas **[Não executado]**.
- **Escopo:** dois participantes e sem reconexão automática. A sessão sobrevive à saída de um participante, mas não
  à queda do servidor.
- **Sem autenticação:** o ID da sessão funciona como convite. É adequado só para a POC em rede local.
- **e2e no mesmo PC:** RTT, jitter e perda ficam próximos de zero por construção.
- **Navegadores do celular:**
  - Safari iOS: áudio e mute funcionaram **[Informado pelo usuário]**;
  - na chamada com o iPhone, Opus 48 kHz e RTT RTCP (`remote-inbound-rtp`) aparecem na captura de um dos clientes
    **[Evidência visual fornecida pelo usuário]**;
  - o efeito de `setCodecPreferences` no Safari não foi verificado **[Não executado]**;
  - Chrome Android: **não testado [Não executado]**.

## 10. Riscos de segurança

| Risco | Severidade | Mitigação nesta POC | Pendência |
|---|---|---|---|
| Confiar numa CA local no celular | Média | `nameConstraints` (só o IP e `localhost`), `pathlen:0`, 30 dias, chave da CA apagada, conferência do SHA-256, instruções de remoção | Decisão e remoção pelo usuário |
| Troca da CA no download por HTTP (`share-ca`) | Média | Opcional; recomenda-se USB; conferência obrigatória do SHA-256; janela de 5 min | — |
| ID de sessão como única credencial | Média (POC) / Alta (produto) | 128 bits, fragmento da URL, não registrado por completo, expiração, limite de 2 | Autenticação real no produto (Supabase, ARCHITECTURE §8) |
| Exposição do servidor na LAN | Baixa/Média | HTTPS só no IP escolhido, HTTP só em loopback, `Origin` exato, limites de tamanho/taxa/sessões, só estáticos do build | Firewall: permitir só em rede privada |
| Endereços IP trocados entre os pares via ICE | Baixa (LAN) | Esperado em P2P (ARCHITECTURE §8.5); nunca registrados em log | Modo só-relay depende da P02/TURN |
| Chave do servidor em disco | Baixa | Fora do repositório, no perfil do usuário, expira em 30 dias | Apagar a pasta após o teste |
| `share-ca` e servidor escutam na rede | Baixa | Só pelo tempo de uso; `share-ca` encerra em 5 min | — |

## 11. Recomendações para a POC-02B

1. **Completar a evidência da LAN antes de sair dela:**
   - registrar versões e modelo do aparelho e repetir a coleta de métricas em série (resumo JSON da interface) por
     tempo definido, nos dois aparelhos;
   - medir a latência boca-ouvido com método externo (ARCHITECTURE §12);
   - verificar a liberação de recursos ao encerrar (indicador de microfone nos dois aparelhos);
   - testar com Android/Chrome;
   - remover a CA local do iPhone ao final.
2. **Ir além da LAN:** STUN e um TURN de teste (UDP, TCP e TLS), com credenciais temporárias emitidas pelo
   servidor (ARCHITECTURE §9.1), e medição em 4G/CGNAT e Wi-Fi diferentes.
3. **Resiliência de rede:** ICE restart com backoff, reconexão da sinalização e retomada do par (o `epoch` já
   permite descartar o antigo), e troca Wi-Fi ↔ 4G.
4. **Medição de qualidade:** séries de RTT, jitter, perda e taxa ao longo do tempo, e latência boca-ouvido com
   medição externa (ARCHITECTURE §12).
5. **Opus:** testar `maxBitrate` entre 24 e 40 kbit/s, mono e DTX, comparando a banda.
6. **Para o produto, não para a POC:** substituir o certificado local por um domínio com certificado público, ou
   pelo app desktop/mobile, e a sessão anônima por autenticação. A CA local é apenas instrumento de teste.
7. **Reaproveitar** o protocolo com `epoch`, a fila de candidatos, a guarda de encerramento e os testes de timers
   como referência para `packages/voice` e `packages/contracts`.

## 12. Correções da revisão arquitetural do PR #3 (22/10/2026)

Aplicadas **depois** do commit de referência `4b6ac1d`, a pedido do arquiteto. Nenhum resultado das seções 5, 6 e
6.1 foi alterado: eles continuam se referindo ao commit de referência. Os resultados abaixo são do código corrigido
**[Observado]**, executado localmente. O commit que conterá estas correções será definido pelo usuário.

### 12.1 Metadados do documento

O campo "Ainda não commitado" foi substituído por:
- PR #3 e sua branch;
- o **commit de referência** `4b6ac1d`, que é o conteúdo validado;
- a indicação de que o **HEAD atual não é fixado** aqui.

### 12.2 HTTP exclusivamente em loopback (`server/server.ts`)

- **Problema:** `httpHost` aceitava qualquer endereço, o que poderia expor HTTP sem TLS na LAN.
- **Correção:**
  - `assertLoopbackHttpHost` roda **antes** de carregar arquivos ou abrir listeners e aceita só **endereços
    literais** de loopback: `127.0.0.0/8` e `::1`, inclusive a forma longa;
  - são rejeitados com erro explícito, sem fallback: `0.0.0.0`, `::`, IPs de LAN, IPs públicos, link-local,
    IPv4 mapeado em IPv6 (`::ffff:127.0.0.1`) e qualquer nome.
- **`localhost` é rejeitado por decisão.** A resolução depende do sistema (arquivo `hosts`, ordem IPv4/IPv6) e o
  `listen` vincularia apenas o primeiro endereço resolvido. Endereços literais são previsíveis. O navegador do PC
  continua acessando por `http://localhost:porta`, cuja origem segue aceita.
- **Defesa em profundidade:** depois do bind, o endereço efetivo é conferido.
- **Fechamento em falha:** se qualquer `listen` falhar (por exemplo, porta HTTPS ocupada), o servidor fecha o que
  já abriu e para o heartbeat. Antes, o HTTP e o intervalo de heartbeat ficavam ativos.
- **IPv6:**
  - URL e `Origin` passam a usar o endereço canônico do bind (`::1` vira `http://[::1]:porta`), e `localhost`
    é aceito como alias também em IPv6;
  - no cliente, a página aberta em `http://[::1]:porta` passa a buscar o endereço do convite, como já fazia em
    `localhost`.
- **Sem alteração:** listener HTTPS/WSS e validação de `Origin`.
- **Testes:** `tests/server-host.test.ts`, 30 casos:
  - aceitação de `127.0.0.1`, `127.x`, `::1` e `0:0:0:0:0:0:0:1`;
  - rejeição de 11 valores;
  - para cada valor rejeitado, prova de que **nenhuma porta HTTP nem HTTPS passou a escutar**;
  - fechamento do HTTP quando o HTTPS falha;
  - HTTP e WebSocket em IPv4, com origens `127.0.0.1` e `localhost` aceitas e origem de LAN recusada;
  - **IPv6 `::1` executado** nesta máquina (não pulado), sem fallback para IPv4;
  - HTTP local e HTTPS/WSS juntos.
- **Mutação:** sem a validação prévia, 11 testes falham.

### 12.3 CI no GitHub Actions (`.github/workflows/poc-02a-ci.yml`)

- **Gatilhos:** PRs para `main` e pushes em `poc/webrtc-audio-lan`, restritos a `poc/webrtc-audio-lan/**` e ao
  próprio workflow.
- **Segurança do workflow:**
  - `permissions: contents: read`, `persist-credentials: false`, actions fixadas por SHA de commit;
  - sem segredos, sem deploy, sem merge e sem instalação de CA;
  - os testes de TLS geram certificados temporários pelo próprio teste.
- **Job `checks`** (matriz `ubuntu-24.04` + `windows-2025`, timeout de 15 min): `pnpm install --frozen-lockfile`,
  typecheck, test e build; `pnpm audit` só no Linux.
- **Job `e2e`** (`windows-2025`, timeout de 20 min):
  - instalação, build, verificação de Chrome e Edge e `pnpm e2e`;
  - usa o Google Chrome e o Microsoft Edge **pré-instalados na imagem do runner**: Chrome 155 e Edge 155, segundo
    o readme oficial das imagens consultado em 22/10/2026;
  - as versões efetivas ficam registradas no log;
  - se algum navegador faltar, o job **falha**: o Edge não é substituído por Chromium;
  - microfones sintéticos preservados, e o script já retorna código 1 em qualquer falha.
- **O script E2E não precisou de ajustes.**

### 12.4 Resultados após as correções [Observado, execução local]

Mesma sequência do CI, executada localmente no Windows (Node 24.19.0, pnpm 12.6.0):

| Verificação | Resultado |
|---|---|
| `pnpm install --frozen-lockfile` | OK |
| `pnpm typecheck` | OK |
| `pnpm test` | **157/157**, 9 arquivos, nenhum pulado (127 anteriores + 30 de `server-host.test.ts`) |
| `pnpm build` | OK |
| `pnpm audit` | Nenhuma vulnerabilidade conhecida |
| `pnpm e2e` | **27/27**, Chrome 155.0.8059.85 ↔ Edge 155.0.4283.62, conexão em 1350 ms, RMS recebido ≈ 0,31 nos dois sentidos |
| Passo "Verificar Chrome e Edge do runner" (rodado localmente) | Encontrou chrome.exe 155.0.8059.85 e msedge.exe 155.0.4283.62 |

**[Não executado]** O workflow **não foi executado no GitHub**. Ele só será considerado aprovado depois de uma
execução real concluída. Pontos que só essa execução confirma:
- o ajuste das inputs das actions fixadas, como `package_json_file` do `pnpm/action-setup` e o cache do
  `setup-node` com pnpm 12;
- a execução dos testes no Linux, que não foi feita localmente;
- **o áudio sintético no runner Windows sem dispositivo de som.** **[Inferido, não verificado]** O Chromium usa
  saída de áudio simulada quando não há dispositivo, mas, se o Web Audio não processar a mídia recebida no runner,
  as verificações de RMS do E2E falharão e exigirão um ajuste de compatibilidade de CI no script.

A sintaxe YAML foi checada apenas estruturalmente (indentação, ausência de tabs, comandos e permissões esperados),
sem `actionlint`, que não está disponível localmente.
