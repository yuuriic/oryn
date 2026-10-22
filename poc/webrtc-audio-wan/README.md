# POC-02B — Áudio WebRTC bidirecional entre redes distintas

Prova de conceito **descartável** do Oryn. Objetivo final: chamada de áudio WebRTC entre um Windows numa
Wi-Fi residencial e um iPhone (Safari) em rede móvel 4G/5G, com sinalização pública HTTPS/WSS (Cloudflare
Tunnel) e STUN/TURN gerenciado (Cloudflare). Plano e decisões em `docs/validation/POC-02B.md`.

## Estado atual: incremento 02B.1 (baseline)

Esta pasta é uma **cópia da POC-02A** (`poc/webrtc-audio-lan/`, conteúdo de `f068509`, PR #3), ajustada só para
funcionar de forma isolada:

| Ajuste | POC-02A | POC-02B |
|---|---|---|
| Pacote | `@oryn/poc-webrtc-audio-lan` | `@oryn/poc-webrtc-audio-wan` |
| Portas padrão (HTTP, HTTPS e `share-ca`) | 5180, 5443 e 5181 | **5280, 5543 e 5281** |
| Pasta de certificados | `%LOCALAPPDATA%\oryn-poc-lan\` | `%LOCALAPPDATA%\oryn-poc-wan\` |
| Identificação visível e CN dos certificados | "POC-02A" | "POC-02B" |

**Ainda não há** sinalização pública, Cloudflare Tunnel, STUN/TURN nem qualquer funcionalidade nova. O
comportamento é idêntico ao da POC-02A.

> **Atenção:** o código herdado ainda contém o modo HTTPS da LAN com **CA local** (`server/certs*.ts`,
> `server/share-ca.ts`). Ele existe só como baseline e **não deve ser usado para acesso pela internet**, nem a CA da
> POC-02A deve ser instalada para esta POC. A substituição por certificado público via túnel é decisão dos próximos
> incrementos.

## Requisitos

Node 24+, pnpm 12+ e, para o E2E, Google Chrome e Microsoft Edge instalados.

## Comandos

```powershell
cd "C:\Dev\Projeto - Oryn\poc\webrtc-audio-wan"
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test        # unitários e integração (herdados da POC-02A)
pnpm build
pnpm audit
pnpm e2e         # Chrome ↔ Edge no próprio PC, microfones sintéticos, via http://localhost
```

Para uso manual no próprio PC (sem celular): `pnpm build` e `pnpm serve --no-https`, depois abra
`http://localhost:5280`.

## Origem

Código e testes copiados de `poc/webrtc-audio-lan/` (POC-02A). A documentação de arquitetura e de segurança
herdada está em `poc/webrtc-audio-lan/README.md` e em `docs/validation/POC-02A.md`. A POC-02A permanece intacta.
