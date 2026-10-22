# POC-01B — Validação: áudio WebRTC no Tauri 2 / WebView2

| Campo | Valor |
|---|---|
| Data | 22/10/2026 |
| Branch | `poc/webrtc-audio-tauri`, a partir de `main` em `bc8cf02` (merge do PR #1) |
| Commit | Ainda não commitado; operações Git ficam a cargo do usuário |
| Código | `poc/webrtc-audio-tauri/` |
| Relação com o ARCHITECTURE.md | Parte da P01 (§14): captura, Opus, autoplay, saída, minimização e limpeza no WebView2 |
| Status | **Aprovada funcionalmente pelo arquiteto em 22/10/2026 — revisão de código e segurança pendente antes do merge** |
| Revisão de código e segurança | Correções autorizadas aplicadas em 22/10/2026 (§11); **aguardando revisão do arquiteto** |

Legenda usada neste documento:
- **[Observado]:** medido ou visto durante uma execução automatizada.
- **[Inferência]:** conclusão tirada das observações, sem verificação direta.
- **[Informado pelo usuário]:** resultado da validação manual relatado pelo usuário (§8); o agente não executou
  nem observou esse teste.
- **[Não executado]:** teste que não foi feito.

## 1. Ambiente e versões

| Item | Versão / detalhe |
|---|---|
| SO | Windows 11 IoT Enterprise Subscription 10.0.26200, x64 |
| CPU / RAM | Intel Core i5-12500H (12 núcleos), 15,7 GiB |
| WebView2 Runtime | **155.0.4283.62** (Evergreen), Chromium 155.0.8059.85 |
| Node / pnpm | 24.19.0 / 12.6.0 |
| Rust / Cargo | 1.99.1, toolchain `stable-x86_64-pc-windows-msvc` |
| MSVC | VS Community 2026 **Insiders** 18.12 (prerelease), MSVC 14.52.37025, Windows SDK 10.0.26100.0 |
| Referência de navegador | POC-01A: Chrome 155.0.8059.85 e Edge 155.0.4283.62 |

Dependências:

| Pacote | Versão | Tipo |
|---|---|---|
| `tauri` (crate) | =2.12.5, sem features extras | Runtime |
| `tauri-build` (crate) | =2.7.4 | Build |
| Resolvidas no `Cargo.lock` | wry 0.57.0, tauri-runtime-wry 2.12.3, webview2-com 0.39.1 | Transitivas |
| `@tauri-apps/cli` | 2.12.4 | Dev |
| vite / typescript / vitest | 8.3.5 / 7.0.2 / 5.0.5 | Dev (iguais à POC-01A) |
| playwright-core | 1.64.1 | Dev (automação via CDP) |

Não há plugins Tauri nem `@tauri-apps/api`, e nenhuma dependência de áudio em Rust.

## 2. Escopo

**Dentro do escopo:**
- loopback A → B com dois `RTCPeerConnection` no WebView2 do aplicativo compilado, com SDP e ICE trocados em memória;
- confirmação do Opus;
- reprodução com controle de saída e volume;
- mute sem renegociação;
- encerramento com liberação de recursos;
- estados e métricas de `getStats`;
- investigação de permissão, autoplay, foco e minimização, desconexão de dispositivo, Opus, limpeza ao fechar e
  diferenças em relação ao Chrome/Edge.

**Fora do escopo:** Supabase, autenticação, salas, sinalização em rede, STUN/TURN, SFU, instalador e assinatura,
monorepo definitivo.

## 3. Decisões de implementação

1. **Host Rust mínimo.** `main.rs` só executa `tauri::Builder::default()`. Não há comandos IPC, plugins,
   capabilities nem `withGlobalTauri`, e o frontend não tem acesso a nenhuma API nativa. Captura, WebRTC e
   reprodução usam apenas APIs do WebView2. **[Observado]** Isso bastou: nenhum código Rust foi necessário para
   permissão ou áudio.
2. **Isolamento da POC-01A.** Os módulos puros (`stats`, `errors`, `redact`, `summary`) e seus testes foram
   **copiados**, com a origem indicada no cabeçalho, em vez de importados. A POC-01A não foi alterada.
   `session.ts` e `main.ts` foram derivados da 01A com instrumentação extra:
   - estado do `AudioContext` e resultado do `play()`;
   - eventos `mute`, `unmute` e `ended` da track, e `devicechange`;
   - intervalo real entre amostras de `getStats`, para detectar throttling;
   - visibilidade e foco;
   - estado da Permissions API.
3. **Detecção do runtime por `userAgentData.brands`.** O User-Agent do WebView2 é idêntico ao do Edge
   (`… Edg/155.0.0.0`), e só os brands o distinguem (`Microsoft Edge WebView2 155`). Isso está no módulo puro
   `runtime.ts`, com testes.
4. **Segurança.**
   - CSP em `tauri.conf.json` (`default-src 'self'`; `devCsp` acrescenta só o WebSocket do HMR) e
     `freezePrototype: true`. Depois da revisão, `media-src` ficou restrito a `'self'` (§11.2).
   - O log não mostra SDP, IPs ou candidatos.
   - O microfone só é pedido após o clique.
   - O áudio recebido começa mudo.
5. **Executável sem instalador** (`tauri build --no-bundle`, `bundle.active: false`). O ícone é um placeholder liso,
   não um ativo de marca.
6. **Teste automatizado dentro do WebView2 real.**
   - `scripts/e2e-webview2.mjs` inicia o `.exe` de release com `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`
     (`--remote-debugging-port` e, no cenário principal, `--use-fake-ui-for-media-stream
     --use-fake-device-for-media-stream`) e conecta o Playwright via CDP.
   - Janela minimizada, restaurada e fechada via Win32 (`ShowWindow` e `WM_CLOSE`).
   - As flags existem só no processo de teste; o aplicativo não as configura.

## 4. Resultados dos testes

> Resultados **anteriores** às correções da revisão, preservados como histórico. Os resultados atuais estão em
> §11.4.

### 4.1 Verificações estáticas e build

| Verificação | Resultado |
|---|---|
| `pnpm install` | OK, 40 pacotes |
| `pnpm typecheck` | OK, sem erros |
| `pnpm test` | **38/38** (33 herdados da 01A + 5 de `runtime.test.ts`) |
| `pnpm build` | OK: JS 23,17 kB (8,22 kB gzip), CSS 2,25 kB |
| `pnpm tauri:build` | **OK, sem avisos**, em 4 min 27 s (primeiro build). `oryn-poc-webrtc-audio-tauri.exe` de 8,6 MB |
| `cargo fmt --check` | OK |
| `cargo clippy --release --all-targets -D warnings` | OK, sem avisos |

### 4.2 Funcional no WebView2: `pnpm e2e:webview2`, com microfone **falso**

| Execução | Resultado | Conexão após o clique | Observação |
|---|---|---|---|
| 1 | 26/28 | 343 ms | 2 falhas no fechamento da janela. **Causa: defeito do teste** (§7.1), não do aplicativo |
| 2 | **29/29** | 206 ms | Teste corrigido; inclui o cenário de permissão sem a flag `fake-ui` |
| 3 | **29/29** | 193 ms | Repetição sem o cenário de permissão |

Verificações aprovadas nas execuções 2 e 3:

- **Runtime:** motor `WebView2 155`, origem `http://tauri.localhost`, `isSecureContext = true` e Opus anunciado em
  `RTCRtpSender.getCapabilities('audio')`.
- **Conexão:** `connected` nos peers A e B.
- **Codec:** `audio/opus`, 48000 Hz, 2 canais, PT 111, fmtp `minptime=10;useinbandfec=1`.
- **Recepção:** pacotes > 0 e pico RMS do áudio recebido ≈ 0,31.
- **`AudioContext`:** `running` após o clique.
- **Autoplay:** `play()` do `<audio>` mudo resolvido **sem** a flag `--autoplay-policy`.
- **Mute:** RMS recebido = 0, conexão mantida e pacotes continuando a chegar (ex.: 249 → 809). Reativar devolve o
  sinal.
- **Saída ligada:** `audioLevel` do `getStats` > 0.
- **Minimizar e restaurar:** a janela fica iconizada e depois volta. Enquanto minimizada, pacotes e áudio
  continuam (§5.3). A conexão segue `connected` depois de restaurar.
- **Encerrar:** track em `ended`, 2 peers em `closed`, `<audio>` removido.
- **Fechar a janela com a chamada ativa:** o processo termina em cerca de 0,6 s e os 7 processos
  `msedgewebview2.exe` do app são encerrados.
- **Privacidade:** log e console sem SDP, candidatos ou IPs.
- **CSP:** nenhuma violação.

### 4.3 Métricas observadas (loopback, cerca de 39 s, tom sintético)

| Métrica | Execução 2 | Execução 3 |
|---|---|---|
| Pacotes recebidos | 1970 | 1971 |
| Amostras com áudio recebido | 33/39 | 33/39 |
| Taxa recebida, média / máxima (kbit/s)¹ | 19,9 / 33,2 | 19,4 / 32,1 |
| RTT do par ICE (ms) | 0–2 | 0–1 |
| Jitter (ms) | 1 | 0–1 |
| Perda | 0 % | 0 % |
| Amostras ocultadas (PLC) | 0,071 % | 0,081 % |
| Track local (`getSettings`) | 48000 Hz, 1 canal, AEC/NS/AGC = true | idem |

¹ Só payload RTP. A média inclui o período mudo. O pico ficou acima do observado no Chrome/Edge da 01A (cerca de
26 kbit/s). **[Inferência]** Isso não indica diferença de codec, porque a configuração negociada é idêntica e o
cenário de teste é diferente. Não comparar como desempenho.

## 5. Investigações obrigatórias

### 5.1 Permissão de microfone
- **[Observado]** Sem a flag `fake-ui`, o clique em "Iniciar" exibe um **diálogo nativo do WebView2** ancorado no
  canto superior esquerdo da janela: "http://tauri.localhost quer — Use seus microfones — **Bloquear / Permitir**".
  A sessão fica em `requesting_permission` e a Permissions API retorna `prompt` antes e durante o diálogo.
  Evidência: captura limitada à janela do app, feita pelo e2e (guardada fora do repositório).
- **[Observado]** Nenhum código Rust foi necessário: o Tauri/wry não nega a permissão silenciosamente.
- **[Inferência]** O diálogo identifica a origem técnica `http://tauri.localhost`, não o nome do produto. Para o
  Oryn, isso é UX fraca e pode confundir usuários.
- **[Informado pelo usuário]** Negar, tentar novamente e permitir funcionou (§8).
- **[Observado, após a validação manual]** Na execução e2e de §11.4, o cenário sem a flag `fake-ui` **não
  mostrou o diálogo**: a Permissions API já retornava `granted` e a sessão conectou direto. Nas execuções anteriores
  com `fake-ui`, a permissão não persistia (o cenário seguinte voltava a mostrar o diálogo).
  **[Inferência]** A concessão manual do usuário (§8) foi gravada no perfil do WebView2
  (`%LOCALAPPDATA%\dev.oryn.poc.webrtcaudio\EBWebView`) e **persiste entre execuções**. O aplicativo não oferece
  forma de revogá-la; só é possível apagando o perfil.
- **[Não executado]** Interação com a privacidade de microfone do Windows para aplicativos desktop.

### 5.2 Reprodução e autoplay
- **[Observado]** O `AudioContext` criado no clique fica `running`, e o `play()` do `<audio>` mudo resolve sem
  flags de autoplay. Ligar a saída (um segundo gesto) produz `audioLevel` > 0.
- **[Observado]** Mesmo comportamento de `audioLevel` do Chrome/Edge (01A): fica em 0 com a saída muda. A medição
  por Web Audio funciona igual.
- **[Informado pelo usuário]** Transmissão e reprodução da voz e controle de volume funcionaram (§8).
- **[Não executado]** Troca de dispositivo de saída (`setSinkId`) e saída Bluetooth.

### 5.3 Perda de foco e minimização
- **[Observado]** Com a janela minimizada via `ShowWindow(SW_MINIMIZE)` por 10 s, `IsIconic` = true e:
  - **`document.visibilityState` continuou `visible` e `document.hasFocus()` continuou `true`**, sem nenhum
    evento `visibilitychange`, `blur`, `freeze` ou `focus`;
  - `AudioContext` continuou `running` e o áudio recebido seguiu (pico RMS ≈ 0,30 em 10/10 amostras);
  - os pacotes seguiram, com cerca de 50/s (1262 → 1821);
  - os timers **não** sofreram throttling: intervalo entre amostras de 997 a 1005 ms e máximo da sessão de 1008 ms.
- **Diferença em relação ao navegador:** no Chrome/Edge, minimizar uma aba ou janela muda a página para `hidden`.
  **[Inferência]** No Tauri, o frontend **não** é notificado pela Page Visibility API. O Oryn desktop precisa usar
  os eventos de janela do Tauri (foco, redimensionamento e minimização) para lógica de ciclo de vida. O lado
  positivo é que a chamada continua com o app minimizado, o que um app de voz para jogos exige.
- **[Informado pelo usuário]** Minimização por 30 s com áudio contínuo funcionou (§8). O relato não detalha o
  método de minimização nem os valores de visibilidade ou foco nesse teste.
- **[Não executado]**
  - minimização por mais de 5 min (o throttling intensivo do Chromium começa depois disso);
  - troca para um jogo em tela cheia;
  - bloqueio de sessão e suspensão do Windows;
  - perda de foco sem minimizar (o processo de teste não tinha como roubar o foco de forma confiável).

### 5.4 Microfone indisponível ou desconectado
- **[Observado]** Só indiretamente: o mapeamento de erros (`NotFoundError` → "Nenhum microfone encontrado",
  `NotReadableError` → "indisponível") está coberto por testes unitários. O tratamento de `track.onended` encerra
  a sessão com a mensagem "microfone foi desconectado".
- **[Informado pelo usuário]** Desconexão do headset ou microfone durante a chamada funcionou (§8). O relato não
  detalha a mensagem exibida, os eventos do log nem o tipo de dispositivo.
- **[Não executado]** Início sem microfone e microfone bloqueado nas configurações do Windows.

### 5.5 Compatibilidade com Opus
- **[Observado]** O WebView2 155 anuncia `audio/opus 48000/2 minptime=10;useinbandfec=1`, além de `audio/red`,
  `G722`, `PCMU`, `PCMA`, `CN` e `telephone-event`. A negociação escolhe Opus PT 111 com o mesmo fmtp do Chrome/Edge.
  Não há DTX por padrão.

### 5.6 Limpeza ao encerrar e ao fechar
- **[Observado]** "Encerrar" deixa as tracks em `ended`, os peers em `closed`, remove o `<audio>` e para a coleta.
  Reiniciar volta a conectar.
- **[Observado]** Fechar a janela (`WM_CLOSE`, o mesmo do botão X) com a chamada ativa faz o processo sair com
  código 0 em cerca de 0,6 s, e os processos WebView2 do app caem de 7 para 0.
- **[Inferência]** A liberação do dispositivo real é garantida pelo fim dos processos. Não foi possível confirmar
  se o handler `pagehide` chegou a rodar antes do encerramento.
- **[Informado pelo usuário]** Encerramento e fechamento pelo X, com liberação de recursos, funcionaram (§8).
- **[Não executado]** Verificação objetiva da liberação do microfone físico pelo registro `ConsentStore`, porque o
  relato não inclui esse dado.

### 5.7 Diferenças relevantes entre Chrome/Edge e WebView2

| Aspecto | Chrome/Edge 155 (POC-01A) | WebView2 155 no Tauri (POC-01B) |
|---|---|---|
| Origem / contexto seguro | `http://localhost:5173`, seguro | `http://tauri.localhost`, seguro |
| Identificação | UA e brands do navegador | UA **igual ao Edge**; só `brands` revela "Microsoft Edge WebView2" |
| Diálogo de permissão | UI do navegador (e2e usou `fake-ui`) | Diálogo nativo do WebView2 com a origem técnica |
| Opus / fmtp | opus/48000/2, `minptime=10;useinbandfec=1` | Idêntico |
| `audioLevel` com saída muda | 0 | 0 (igual) |
| Minimizar | Página fica `hidden` (comportamento documentado do Chromium; **não medido na 01A**) | **Continua `visible` e `hasFocus=true`**, sem eventos [Observado] |
| Throttling de timers com a janela minimizada | Aplicável a páginas ocultas (documentado; não medido) | Não observado em 10 s [Observado] |
| Fechar | Fecha a aba | Encerra o processo e todos os processos WebView2 |

## 6. Limitações conhecidas

As limitações da POC-01A continuam valendo e se aplicam aqui:
- loopback na mesma página, sem rede real, NAT, perda ou jitter;
- RTT, jitter e perda próximos de zero por construção;
- fluxo unidirecional;
- sem STUN/TURN.

Limitações específicas desta POC:
- **Microfone falso:** o pipeline foi validado no WebView2, mas não a captura real, o AEC/NS/AGC com voz nem a
  qualidade percebida.
- **Minimização programática:** foi feita via `ShowWindow`, não pelo botão da janela, e só por 10 s.
- **Uma máquina e uma versão do WebView2 (155).** O WebView2 é Evergreen e se atualiza sozinho; o comportamento
  pode mudar entre versões.
- **Só o executável de release.** O modo `tauri:dev` (debug + Vite) não foi executado.
- **Amostra pequena:** duas execuções aprovadas e uma com defeito do teste.

## 7. Problemas encontrados

1. **Defeito do teste, corrigido.** Depois de minimizar, o `Process.MainWindowHandle` do .NET passa a apontar para
   a janela oculta do tao (`Tao Thread Event Target`). Na execução 1, o restore e o `WM_CLOSE` foram enviados a ela,
   e o processo "não fechou".
   - Com o handle correto da `Tauri Window`, o app minimiza, restaura e fecha em cerca de 80 ms, sem processos
     remanescentes. Isso foi verificado em 2 rodadas isoladas, além das execuções 2 e 3.
   - O e2e agora captura o handle uma vez e valida a classe.
   - O dado é relevante para qualquer automação futura do Oryn desktop.
2. **A Page Visibility API não reflete a minimização no Tauri** (§5.3). Não é um bug da POC, mas exige outra
   estratégia no produto.
3. **A variável de ambiente `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` foi aplicada ao app de produção**, por exemplo
   para habilitar a depuração remota. **[Inferência]** Qualquer processo com os privilégios do usuário pode abrir
   a porta CDP do Oryn e controlar a interface. O risco é limitado, porque quem tem esse acesso já controla a
   sessão do usuário, mas deve ser registrado no modelo de ameaça junto com tokens em memória (§8.1 da
   arquitetura).
4. **Toolchain MSVC Insiders** (prerelease, expira em 14/01/2027). Compilou sem problemas, mas não é adequado
   para builds reproduzíveis.

## 8. Validação manual informada pelo usuário (22/10/2026)

O usuário executou o roteiro de `poc/webrtc-audio-tauri/README.md` ("Roteiro de validação manual") com o
aplicativo Tauri e microfone real, e informou o seguinte resultado:

| Item | Resultado informado |
|---|---|
| Permissão do microfone: negar, tentar novamente e permitir | Funcionou |
| Transmissão e reprodução da voz | Funcionou |
| Controle de volume | Funcionou |
| Mute e unmute sem desconexão | Funcionou |
| Minimização por 30 s com áudio contínuo | Funcionou |
| Desconexão do headset ou microfone durante a chamada | Funcionou |
| Encerramento e fechamento pelo X, liberando recursos | Funcionou |
| Observações | Nenhuma |

Natureza da evidência:

- É um **relato do usuário**. O agente não executou nem observou estes testes.
- Não foram informados versões, dispositivos de entrada e saída, método de minimização, duração das sessões,
  métricas, logs, resumo JSON nem leitura do registro `ConsentStore`. Esses dados ficam **não informados**.
- O relato não mede qualidade, inteligibilidade nem latência boca-ouvido.

Itens do roteiro **não cobertos** pelo relato, que continuam pendentes:

1. ~~Persistência da decisão de permissão entre execuções.~~ Observada indiretamente depois do teste manual
   (§5.1 e §11.4); o usuário não a informou.
2. Início sem nenhum microfone disponível e microfone bloqueado na privacidade do Windows.
3. Verificação objetiva da liberação do microfone pelo registro `ConsentStore`.

## 9. Recomendação técnica para a arquitetura do Oryn

Com base nas observações automatizadas e na validação manual informada pelo usuário (§8):

1. **O WebView2 é viável como camada de áudio WebRTC do desktop sem código Rust de áudio.** Captura, Opus,
   ICE/DTLS, recepção, Web Audio, autoplay após gesto e limpeza funcionaram iguais ao Chrome/Edge 155. Isso reforça
   o ADR-002 e a decisão de manter o áudio no frontend compartilhado (ADR-001), atrás do `VoiceTransport` e do
   `AudioDevicePort`.
2. **Ciclo de vida da janela via `DesktopIntegration`, não via Page Visibility.** No desktop, minimização e foco
   devem vir de eventos de janela do Tauri, expostos por um adaptador. O adaptador web continua usando
   `visibilitychange`. Isso confirma a orientação do §5 contra detecção de plataforma espalhada pelo código.
3. **UX de permissão: decisão para ADR.** O diálogo padrão mostra `http://tauri.localhost`. A alternativa é tratar
   `PermissionRequested` em Rust (via `with_webview` e `webview2-com`), concedendo **apenas** microfone e **apenas**
   para a origem do próprio app, com explicação na interface antes do pedido. Isso exige dependência e código
   nativo, que esta POC evitou de propósito. Na validação manual (§8), o fluxo de permissão funcionou e não houve
   observações; a decisão pode esperar por feedback de usuários reais.
4. **Indicadores de fala e deafen baseados em Web Audio**, não em `audioLevel` (confirmado também no WebView2).
5. **Encerramento explícito.** Ao fechar, o processo libera tudo, mas o produto precisará avisar o backend da saída
   da sala (leases, §11.3). Recomenda-se interceptar `CloseRequested` no Tauri, executar o leave e fechar em
   seguida, com timeout curto.
6. **Ambiente de build:** instalar as Build Tools estáveis do MSVC antes da fundação do monorepo.
7. **Próximos experimentos** (P01/P02, depois de aprovado):
   - minimização longa e jogo em tela cheia, medindo CPU;
   - Bluetooth e troca de dispositivo;
   - matriz de versões do WebView2;
   - mesh com sinalização real e TURN.

## 10. Decisão

**Aprovada funcionalmente pelo arquiteto em 22/10/2026 — revisão de código e segurança pendente antes do merge.**

A aprovação se apoia em dois tipos de evidência:

- **Automatizada:** 29/29 verificações no WebView2 do executável de release com dispositivo de mídia falso (§4).
- **Manual, informada pelo usuário:** permissão, transmissão, reprodução, volume, mute, minimização,
  desconexão do dispositivo e encerramento funcionaram com microfone real (§8).

As limitações (§6), os problemas (§7) e os itens não executados (§5 e §8) continuam valendo.

As correções autorizadas pela revisão de código e segurança foram aplicadas e validadas (§11). **O merge depende
da revisão do arquiteto sobre essas correções.** O agente não declara aprovação arquitetural final.

## 11. Correções pós-revisão de código e segurança (22/10/2026)

Três achados da revisão estática foram corrigidos com autorização do arquiteto, sem ampliar o escopo. Nenhuma
dependência foi adicionada.

### 11.1 Correção 1: ciclo de vida dos timers (`src/session.ts`)

- **Defeito [Observado em teste].** `negotiate()` podia retornar normalmente depois de um `close()` ou `fail()`
  ocorrido durante a negociação. Isso acontecia por três caminhos: os retornos antecipados depois de
  `A.setLocalDescription` e `B.setLocalDescription`, a etapa final (`A.setRemoteDescription`) sem checagem, ou um
  timeout de negociação. Em todos eles, `start()` criava os intervalos de `getStats` (1 s) e de níveis (40 ms)
  **depois** da liberação dos recursos. Tracks e conexões já estavam liberadas, mas os dois intervalos ficavam
  ativos até a janela fechar.
- **Correção.** Uma guarda única `if (this.disposed) return;` imediatamente antes da criação dos intervalos em
  `start()`. A liberação de tracks e conexões e o fluxo de áudio não mudaram, e nenhum timer novo foi criado.
- **Teste de regressão determinístico** (`tests/session-lifecycle.test.ts`). Usa fakes de `RTCPeerConnection`,
  `AudioContext` e `getUserMedia` e timers falsos do Vitest; cada etapa da negociação pode ser retida enquanto a
  sessão é encerrada e liberada depois.
  - Cenários: `close()` com `A.createOffer`, `A.setLocalDescription`, `B.setLocalDescription` ou
    `A.setRemoteDescription` pendentes; timeout de negociação; e um controle com negociação completa.
  - **Antes da correção:** 5 falhas, com 2 timers remanescentes em cada uma. O controle passou.
  - **Depois:** 6/6 aprovados, com 0 timers, tracks em `ended`, peers em `closed`, fase final `closed` e nada
    recriado após 20 s de relógio simulado.
- **[Inferência]** Em navegadores reais, operações de SDP iniciadas antes de `close()` podem nunca se resolver; nesse
  caso `start()` fica pendente sem criar timers, o que é inofensivo. O fake cobre o pior caso, em que elas se
  resolvem depois.

### 11.2 Correção 2: CSP `media-src` (`src-tauri/tauri.conf.json`)

- `media-src 'self' blob: mediastream:` passou a `media-src 'self'` em `csp` e em `devCsp`. Nenhuma outra
  diretiva mudou.
- **[Observado]** O cabeçalho `Content-Security-Policy` entregue pelo app em `http://tauri.localhost` contém
  `media-src 'self'`. O `script-src` continua `'self'`, com o hash que o próprio Tauri injeta, sem
  `unsafe-inline` nem `unsafe-eval`. Isso é verificado no e2e.
- **[Observado]** A reprodução continua: `play()` resolvido, `audioLevel` > 0 com a saída ligada, RMS recebido > 0
  e nenhuma violação de CSP no console. Não foi necessário restaurar a configuração anterior. **[Inferência]**
  `srcObject` com `MediaStream` não passa pela verificação de `media-src`, por isso `mediastream:` e `blob:` eram
  desnecessários.

### 11.3 Correção 3: escapamento no PowerShell (`scripts/e2e-webview2.mjs`)

- **Defeito.** O caminho `--artifacts` e os handles eram interpolados no texto dos comandos PowerShell; um `'` no
  caminho permitia injetar comandos. O impacto era restrito ao teste local.
- **Correção.** Novo módulo `scripts/powershell.mjs` (com tipos em `powershell.d.mts`):
  - `runPowerShell(script, vars)` passa valores como variáveis de ambiente `ORYN_PS_<NOME>`, lidas no script
    como `$env:ORYN_PS_<NOME>`; o PowerShell as trata apenas como dado;
  - o texto dos scripts passou a conter só constantes;
  - nomes de variável são validados, e handles e PIDs são validados como inteiros por `toHandle`;
  - continua compatível com o Windows PowerShell 5.1 (`powershell.exe`).
- **Testes** (`tests/powershell.test.ts`, 8 casos). Executam o PowerShell real em uma pasta temporária, que também
  tem `'` no nome, com estes nomes de arquivo:
  - `o'ryn.txt`;
  - `a'; New-Item -ItemType File -Name injected.txt; 'b.txt`;
  - `c$(New-Item -ItemType File -Name sub.txt)d.txt`;
  - um nome com duas aspas e crase.

  Em todos, o arquivo é criado com o nome exato e **nenhum** arquivo injetado aparece. Também cobrem
  `Bitmap.Save`, o mesmo padrão da captura do e2e, e a validação de entrada.
- **[Observado]** De ponta a ponta, o e2e gravou a captura em uma pasta chamada `artifacts o'ryn; $(x)`.
- Para tipar os testes sem adicionar `@types/node`, foi criado `tests/node-shim.d.ts`, com as 7 assinaturas do
  Node usadas.

### 11.4 Resultados após as correções

| # | Verificação | Resultado |
|---|---|---|
| 1 | `pnpm typecheck` | OK |
| 2 | `pnpm test` | **52/52** em 6 arquivos (38 anteriores + 6 de ciclo de vida + 8 de PowerShell) |
| 3 | `pnpm build` | OK: JS 23,18 kB (8,22 kB gzip) |
| 4 | `cargo fmt --check` | OK |
| 5 | `cargo clippy -- -D warnings` | OK, sem avisos. Também `--release --all-targets` |
| 6 | `pnpm tauri:build` (release) | OK, sem avisos, em 52 s (incremental), `.exe` de 8,6 MB |
| 7 | `pnpm e2e:webview2` (microfone falso) | **31/31** em duas execuções: as 29 anteriores + 2 de CSP |

Dados das duas execuções do e2e **[Observado]**:

| Métrica | Execução A (com cenário de permissão) | Execução B (`--skip-prompt`) |
|---|---|---|
| Conexão após o clique | 332 ms | 188 ms |
| Minimizado por 10 s | `visible`/`hasFocus=true`; pacotes 1315 → 1871; intervalos de 995 a 1004 ms | Idem; 1262 → 1871; de 997 a 1001 ms |
| Fechar pelo X com a chamada ativa | Sai em 631 ms; processos WebView2 de 7 para 0 | 636 ms; de 7 para 0 |
| Resumo (cerca de 39 s) | 1970 pacotes, 33/39 amostras com áudio, perda 0 %, PLC 0 % | 1970 pacotes, 33/39, perda 0 %, PLC 0,038 % |

**Regressões:** nenhuma. Os comportamentos observados antes (minimização, autoplay, codec, limpeza e fechamento)
se repetiram.

### 11.5 Decisão: POC-01A inalterada

A POC-01A (`poc/webrtc-audio-browser/`) **não foi alterada**, por restrição explícita e porque já foi aprovada e
integrada (PR #1). Ela contém o **mesmo defeito latente de timers** (§11.1), herdado do `session.ts` original.
Como a POC é descartável e o risco se limita a dois intervalos inofensivos depois de um encerramento durante a
negociação, o defeito fica registrado aqui. A correção e o teste de §11.1 devem servir de referência para a
implementação definitiva de `packages/voice`.

### 11.6 Riscos remanescentes

| Risco | Severidade | Situação |
|---|---|---|
| `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` é aceita pelo `.exe` de release. Um processo com os privilégios do usuário pode habilitar a porta de depuração remota (controle total da interface) ou `--use-fake-ui-for-media-stream` (microfone sem diálogo). **[Observado]** | Média para o produto, baixa para a POC | Não corrigido; fora do escopo. Vai para o ADR de §11.7 |
| Outras variáveis `WEBVIEW2_*` (pasta do runtime, pasta de dados, canal) devem ter o mesmo efeito **[Inferência, não testado]** | Média para o produto | ADR de §11.7 |
| A concessão de microfone persiste no perfil e não pode ser revogada pelo app; o perfil é compartilhado entre o uso manual e o e2e **[Observado e inferência, §5.1]** | Baixa | ADR de §11.7 |
| A execução do `pagehide` ao fechar pelo X não é verificável; a liberação depende do fim do processo | Baixa | Recomendação 5 de §9 (`CloseRequested`) |
| A ponte interna de IPC do Tauri com a lista de permissões vazia não foi verificada em execução | Informativo | Testar no bootstrap do produto |
| `cargo audit` não executado (não instalado); `pnpm audit` sem vulnerabilidades | Informativo | Incluir no CI |
| A captura do e2e pega tudo o que está sobre o retângulo da janela (ex.: a barra de tarefas). Os arquivos ficam fora do repositório | Baixa, só no teste | Documentado |
| POC-01A com o defeito latente de timers | Baixa | §11.5 |
| Toolchain MSVC Insiders | Baixa | Recomendação 6 de §9 |

### 11.7 Recomendação: ADR futuro sobre segurança do WebView2

Abrir um ADR antes da fundação do cliente desktop, cobrindo:

1. **Argumentos de inicialização.** Em release, descartar as variáveis `WEBVIEW2_*` do ambiente antes de criar o
   WebView2 e definir explicitamente os argumentos permitidos. Avaliar as políticas corporativas do WebView2
   como camada adicional.
2. **Permissões.** Decidir entre o diálogo padrão (origem `http://tauri.localhost`) e tratar `PermissionRequested`
   no host, concedendo **apenas** microfone e **apenas** para a origem do app, negando todo o resto. Definir uma
   explicação na interface antes do pedido e a forma de revogação nas configurações.
3. **CDP e depuração.** A porta de depuração remota e as devtools nunca ficam habilitadas em release. Testes
   automatizados usam um build ou perfil de teste dedicado, porta efêmera e encerramento garantido.
4. **Isolamento do perfil.** Pasta de dados separada para testes e para uso real, decisão sobre partição por conta
   e limpeza no logout. Também registrar onde ficam as permissões, caches e storage do WebView2 e como apagá-los
   (relaciona-se com §7.1 e §8.1 da arquitetura).
5. **CSP e capabilities.** Manter `media-src 'self'`, sem `unsafe-*`, e capabilities mínimas por janela, testadas
   em execução, incluindo a verificação de que a ponte de IPC rejeita comandos fora da lista.
