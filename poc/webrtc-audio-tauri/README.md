# POC-01B — Áudio WebRTC no Tauri 2 / WebView2

Prova de conceito **descartável** do Oryn. Verifica se captura, transmissão e reprodução de áudio WebRTC
funcionam dentro de um aplicativo Windows Tauri 2, usando apenas as APIs nativas do WebView2. Não é base de
código do aplicativo.

## Como funciona

A mesma topologia da POC-01A, agora dentro do WebView2:

```text
microfone ──► A (emissor) ══ SRTP/DTLS, ICE host ══► B (receptor) ──► <audio> (começa mudo)
                │  offer/answer e candidatos ICE trocados em memória │
                └──────────────── sem servidor de sinalização ──────┘
```

- **Host Rust mínimo:** só `tauri::Builder::default()`. Não há plugins, comandos IPC, capabilities nem
  `@tauri-apps/api`; o frontend não tem acesso a APIs nativas.
- **Origem em produção:** `http://tauri.localhost`, que o Chromium trata como contexto seguro. Em desenvolvimento,
  `http://localhost:1420`.
- **CSP** definida em `src-tauri/tauri.conf.json`, com `freezePrototype` ativo.
- **Módulos puros** (`stats`, `errors`, `redact`, `summary`) copiados da POC-01A, sem import cruzado.
- **Instrumentação adicional para o WebView2:**
  - motor (WebView2, Edge ou Chrome) identificado por `userAgentData.brands`;
  - Opus conferido em `RTCRtpSender.getCapabilities`;
  - estado da Permissions API;
  - estado do `AudioContext` e resultado do `play()`;
  - eventos `mute`/`ended` da track e `devicechange`;
  - visibilidade e foco da janela;
  - intervalo real entre amostras de `getStats`.

## Requisitos

- Windows 10/11 x64 com WebView2 Runtime (Evergreen).
- Node 24+ e pnpm 12+.
- Rust stable com toolchain MSVC e as Build Tools do Visual Studio (C++ x64 e Windows SDK).

## Executar

```powershell
pnpm install

# Desenvolvimento: Vite em localhost:1420 + janela Tauri (compila em debug)
pnpm tauri:dev

# Executável de release, sem instalador
pnpm tauri:build
.\src-tauri\target\release\oryn-poc-webrtc-audio-tauri.exe
```

| Comando | O que faz |
|---|---|
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` | Testes unitários (Vitest) |
| `pnpm build` | Typecheck + build do frontend em `dist/` |
| `pnpm tauri:build` | Frontend + executável Windows de release (`--no-bundle`) |
| `pnpm e2e:webview2` | Teste funcional no WebView2 do executável de release, com **microfone falso** (requer `pnpm tauri:build` antes) |

O `e2e:webview2` abre a janela do aplicativo várias vezes, minimiza, restaura e fecha. Durante o teste, o
WebView2 recebe `--remote-debugging-port` pela variável `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`; o aplicativo
nunca habilita isso sozinho.

## Roteiro de validação manual (microfone real + fones)

Use o **executável de release**, não o `tauri:dev`, para validar o mesmo caminho que um usuário teria. Anote o
resultado de cada passo.

### 1. Permissão do microfone
1. Abra `oryn-poc-webrtc-audio-tauri.exe`. Confira em **Runtime**: motor `WebView2 …`, origem
   `http://tauri.localhost`, contexto seguro `true`, Opus `sim`. Anote o estado da **Permissão**.
2. Clique em **Iniciar conexão**. Anote o que aparece:
   - um diálogo de permissão do WebView2;
   - um aviso de privacidade do Windows;
   - ou nada (permissão concedida direto).
3. Se aparecer um diálogo, primeiro **negue**. O app deve mostrar "Permissão de microfone negada" e reabilitar
   "Iniciar". Clique em Iniciar de novo e anote se o diálogo reaparece ou se a negação ficou memorizada.
4. Feche o app, abra de novo e permita. Anote se a decisão foi lembrada entre execuções.
5. Opcional: com **Configurações do Windows → Privacidade → Microfone → "Permitir que aplicativos da área de
   trabalho acessem o microfone"** desligado, repita e anote a mensagem exibida. Religue depois.

### 2. Transmissão e reprodução
1. **Coloque os fones** antes. Com a permissão concedida e o estado `conectado`, fale:
   - o medidor **Recebido (B)** e o **Pico RMS recebido** devem subir;
   - anote o codec (esperado `audio/opus`).
2. Marque **Ouvir áudio recebido** com volume baixo. Você deve ouvir a própria voz com atraso.
3. Mova o controle de volume e confirme que o nível muda.

### 3. Mute
1. Clique em **Mutar microfone** e fale. O nível recebido deve ir a zero, os estados devem continuar
   `connected` e os pacotes devem continuar subindo.
2. **Reativar**: o áudio volta.

### 4. Foco e minimização
1. Com a saída ligada, clique em outra janela (perda de foco) e continue falando. O áudio deve continuar.
2. **Minimize** o app por cerca de 30 s enquanto fala. Anote se o áudio continua nos fones.
3. Restaure. Anote **Intervalo máximo entre amostras** e o log "Ciclo de vida" (visibilidade, foco).

### 5. Microfone indisponível ou desconectado
1. Com a chamada ativa, desconecte o headset USB ou Bluetooth. Anote:
   - se aparece o erro "microfone foi desconectado";
   - eventos `mute` e `devicechange` no log;
   - se o Windows trocou para outro microfone.
2. Com o app parado e sem nenhum microfone (ou com todos desativados em Som → Gravação), clique em Iniciar e anote
   a mensagem.

### 6. Encerramento e fechamento
1. Clique em **Encerrar**. O ícone de microfone em uso na bandeja do Windows deve sumir em poucos segundos.
2. Inicie de novo e **feche a janela** (X) com a chamada ativa. O processo deve terminar e o indicador de
   microfone deve sumir.
3. Opcional, para evidência objetiva: o Windows registra quando cada executável deixou de usar o microfone.

   ```powershell
   Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone\NonPackaged' |
     Where-Object { $_.PSChildName -like '*oryn-poc-webrtc-audio-tauri*' } |
     ForEach-Object { $p = Get-ItemProperty $_.PSPath; [pscustomobject]@{
       inicio = [DateTime]::FromFileTime($p.LastUsedTimeStart); fim = [DateTime]::FromFileTime($p.LastUsedTimeStop) } }
   ```

   `fim` deve ser posterior a `inicio` e próximo ao momento em que você encerrou ou fechou o app.
4. Clique em **Gerar resumo (JSON)** antes de encerrar, se quiser anexar métricas ao relatório.

## Segurança e privacidade

- O microfone só é solicitado depois do clique.
- Nenhum áudio é gravado ou persistido e não há rede além do loopback local.
- Nenhuma credencial é usada.
- O log mostra apenas metadados não sensíveis: nada de SDP, IPs, portas, ufrag ou fingerprints.
- O WebView2 guarda o perfil (incluindo decisões de permissão) em
  `%LOCALAPPDATA%\dev.oryn.poc.webrtcaudio\EBWebView`. Apague essa pasta para voltar ao estado inicial.
