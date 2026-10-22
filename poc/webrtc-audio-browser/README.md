# POC-01A — Áudio WebRTC no navegador

Prova de conceito **descartável** do Oryn. Valida captura de microfone, negociação SDP/ICE, transporte Opus e
coleta de métricas usando apenas APIs WebRTC nativas. Não é base de código do aplicativo.

## Como funciona

Dois `RTCPeerConnection` na **mesma página** simulam dois participantes:

```text
microfone ──► A (emissor) ══ SRTP/DTLS, ICE host ══► B (receptor) ──► <audio> (começa mudo)
                │  offer/answer e candidatos ICE trocados em memória │
                └──────────────── sem servidor de sinalização ──────┘
```

- A envia a track do microfone; B recebe e reproduz. Fluxo unidirecional A → B.
- `iceServers: []`: no mesmo computador bastam candidatos host. STUN/TURN ficam para a P02.
- Candidatos ICE que chegam antes da descrição remota ficam em fila e são aplicados depois.
- Mute usa `track.enabled = false`: o envio continua (silêncio), sem renegociação.
- `getStats()` é coletado a cada 1 s nos dois peers.

## Executar

Requisitos: Node 24+, pnpm 12+, Chrome ou Edge recente.

```bash
pnpm install
pnpm dev          # http://localhost:5173 — localhost é contexto seguro, sem TLS
```

Outros comandos:

| Comando | O que faz |
|---|---|
| `pnpm typecheck` | `tsc --noEmit` (TypeScript estrito) |
| `pnpm test` | Testes unitários (Vitest) das funções determinísticas |
| `pnpm build` | Typecheck + build de produção em `dist/` |
| `pnpm e2e` | Teste funcional no Chrome instalado com **microfone falso** (`--channel=msedge` para Edge, `--headed` para ver) |

## Testar sem microfonia

O áudio recebido é a sua própria voz, com atraso, depois de atravessar a conexão WebRTC. Com alto-falantes,
o som volta ao microfone e realimenta.

1. **Use fones de ouvido** com fio, de preferência. Bluetooth adiciona latência e pode mudar o perfil do microfone.
2. Clique em **Iniciar conexão** e permita o microfone.
3. Sem ligar a saída, fale e observe:
   - o medidor **Recebido (B)** e o **Pico RMS recebido** sobem, o que prova que o áudio chega sem precisar ouvi-lo;
   - a **Taxa recebida** e os **Pacotes recebidos** aumentam.
4. Só então marque **Ouvir áudio recebido** com o volume baixo (padrão 30%).
5. Clique em **Mutar microfone**: os níveis recebidos caem a zero, mas os estados continuam `connected` e os pacotes
   seguem chegando.
6. Clique em **Gerar resumo (JSON)** para obter as métricas agregadas e em **Encerrar** para liberar tudo. O indicador
   de microfone do navegador deve se apagar.

Sem fones: mantenha “Ouvir áudio recebido” desligado e valide pelos medidores e pelas métricas.

## Segurança e privacidade

- O microfone só é solicitado depois do clique em “Iniciar conexão”.
- O servidor de desenvolvimento escuta apenas em `localhost`.
- Nenhum áudio é gravado ou persistido, e não há chamadas de rede além do dev server local.
- Nenhuma credencial é usada.
- O log em tela fica só em memória e mostra apenas o tipo e o protocolo dos candidatos (`host/udp`) e o tipo
  da descrição (`offer — mídia: audio`). SDP, IPs, portas, ufrag e fingerprints nunca são exibidos.
- A página tem uma CSP restritiva (`default-src 'self'`).

## Estrutura

```text
src/
  session.ts   LoopbackSession: captura, 2 peers, negociação, ICE, mute, stats, cleanup
  stats.ts     funções puras sobre getStats (codec, par ICE, taxa, perda, jitter)
  summary.ts   agregação das amostras para o resumo exportável
  errors.ts    tradução de erros do getUserMedia
  redact.ts    resumos de SDP/candidatos sem dados de rede
  main.ts      interface (DOM puro)
tests/         testes unitários (Vitest)
scripts/       e2e com Playwright + dispositivo de mídia falso
```
