# POC-02B — Áudio WebRTC bidirecional entre redes distintas

Prova de conceito **descartável** do Oryn. Objetivo final: chamada de áudio WebRTC entre um Windows numa
Wi-Fi residencial e um iPhone (Safari) em rede móvel 4G/5G, com sinalização pública HTTPS/WSS (Cloudflare
Tunnel) e STUN/TURN gerenciado (Cloudflare). Plano, decisões e evidências em `docs/validation/POC-02B.md`.

## Estado atual: incremento 02B.2B

- Baseline copiado da POC-02A (`poc/webrtc-audio-lan/`, conteúdo de `f068509`), isolado no 02B.1.
- **CA local e HTTPS local removidos** no 02B.2A.
- **02B.2B:** admissão (chave efêmera do operador e convites de uso único), allowlist de hostnames públicos
  fechada por padrão, `Origin` coerente com o `Host` e limites contra abuso. Detalhes em
  `docs/validation/POC-02B.md` §8.
- **Ainda não há** Cloudflare Tunnel nem STUN/TURN. **Nenhum serviço desta POC deve ser exposto na internet**
  até a aprovação arquitetural dos critérios de exposição (`POC-02B.md` §8.8).

## Uso local (operador e convidado no mesmo PC)

1. `pnpm build && pnpm serve`. O terminal mostra o **link do operador**: `http://localhost:5280/#op=<chave>`.
   - A chave é **efêmera**: muda a cada início do servidor; o servidor guarda só o hash.
   - Abra o link **só neste computador** e não o compartilhe. A página remove a chave da barra de endereço e a
     mantém só em memória.
2. Na página do operador, clique em **Criar sessão**. Aparece um **convite de uso único**, que expira em 10 min.
   Sem hostname público configurado, só o código; com hostname público, também o link `https://…/#i=…` e o QR.
3. O convidado entra pelo link do convite ou colando o código em **Convite** → **Entrar**.
4. **Reentrada:**
   - o operador usa **Voltar à sessão**;
   - o convidado precisa de um **novo convite**, emitido pelo botão **Novo convite** do operador (cada convite
     vale uma única entrada).

## Modelo de rede

```text
 iPhone / PC ──HTTPS/WSS (certificado público)──► Cloudflare ──túnel──► cloudflared ──HTTP──► Node (127.0.0.1:5280)
                    └──────────── TLS termina na Cloudflare ────────────┘          └─ loopback, sem TLS ─┘
```

- O servidor Node escuta **somente em loopback literal** (`127.0.0.1` por padrão; `::1` aceito). Qualquer outro
  endereço é rejeitado antes de abrir o listener, e não existe opção de bind público.
- **Hostnames públicos:** variável `ORYN_PUBLIC_HOSTNAMES` (nomes DNS exatos separados por vírgula; sem curingas,
  IPs, portas ou `localhost`). **Ausente = acesso público fechado.** Com ela, o `Host` público é aceito e o
  `Origin` precisa ser exatamente `https://<hostname>`.
- **Criar sessão exige** a chave do operador **e** um `Host` local. Pelo hostname público, nem a chave correta
  autoriza: atrás do túnel, todas as conexões chegam por loopback, então loopback sozinho não prova nada.
- **Futuro (02B.6):** o túnel recebe HTTPS/WSS da internet, com o TLS terminando na Cloudflare, e entrega o tráfego
  ao Node por HTTP em loopback.
- **Hoje:** só o próprio PC acessa (`http://localhost:5280`). Hostnames públicos não configurados são recusados
  pela validação de `Host` (421) e de `Origin` (403).

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
