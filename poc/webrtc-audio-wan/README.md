# POC-02B — Áudio WebRTC bidirecional entre redes distintas

Prova de conceito **descartável** do Oryn. Objetivo final: chamada de áudio WebRTC entre um Windows numa
Wi-Fi residencial e um iPhone (Safari) em rede móvel 4G/5G, com sinalização pública HTTPS/WSS (Cloudflare
Tunnel) e STUN/TURN gerenciado (Cloudflare). Plano, decisões e evidências em `docs/validation/POC-02B.md`.

## Estado atual: incremento 02B.2A

- Baseline copiado da POC-02A (`poc/webrtc-audio-lan/`, conteúdo de `f068509`), isolado no 02B.1.
- **CA local e HTTPS local removidos** no 02B.2A: não há geração de CA, compartilhamento de certificado, instalação
  de certificado no iPhone nem listener HTTPS.
- **Ainda não há** Cloudflare Tunnel, STUN/TURN, admissão nem convites. Até a aprovação do incremento 02B.2B,
  **nenhum serviço desta POC deve ser exposto na internet**.

## Modelo de rede

```text
 iPhone / PC ──HTTPS/WSS (certificado público)──► Cloudflare ──túnel──► cloudflared ──HTTP──► Node (127.0.0.1:5280)
                    └──────────── TLS termina na Cloudflare ────────────┘          └─ loopback, sem TLS ─┘
```

- O servidor Node escuta **somente em loopback literal** (`127.0.0.1` por padrão; `::1` aceito). Qualquer outro
  endereço é rejeitado antes de abrir o listener, e não existe opção de bind público.
- **Futuro (02B.6):** o túnel recebe HTTPS/WSS da internet, com o TLS terminando na Cloudflare, e entrega o tráfego
  ao Node por HTTP em loopback.
- **Hoje:** só o próprio PC acessa (`http://localhost:5280`). Hostnames públicos são recusados pela validação de
  `Host` (421) e de `Origin` (403) até serem configurados explicitamente num incremento futuro.

## Comandos

Requisitos: Node 24+, pnpm 12+ e, para o E2E, Google Chrome e Microsoft Edge instalados.

```powershell
cd "C:\Dev\Projeto - Oryn\poc\webrtc-audio-wan"
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test        # unitários e integração
pnpm build
pnpm audit
pnpm e2e         # Chrome ↔ Edge no próprio PC, microfones sintéticos, via http://localhost
pnpm serve       # requer pnpm build; abre só em http://localhost:5280 (--http-port=N para trocar)
```

CI: `.github/workflows/poc-02b-ci.yml`.

## Diferenças em relação à POC-02A

| Item | POC-02A | POC-02B |
|---|---|---|
| Pacote | `@oryn/poc-webrtc-audio-lan` | `@oryn/poc-webrtc-audio-wan` |
| Acesso do celular | HTTPS da LAN com CA local instalada no aparelho | Túnel público com certificado público (futuro); **sem CA local** |
| Listeners | HTTP em loopback + HTTPS no IP da LAN | **Somente HTTP em loopback** |
| `/api/info` | Informava a origem HTTPS ao PC | Removido |
| Convite (link/QR) | Montado com a origem HTTPS da LAN | Montado com a origem da própria página quando ela não é loopback; em `localhost`, só o código |
| Porta padrão | 5180 | 5280 |

A POC-02A permanece intacta em `poc/webrtc-audio-lan/`.
