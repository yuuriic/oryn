# POC-02B — Áudio WebRTC bidirecional entre redes distintas

Prova de conceito **descartável** do Oryn. Objetivo final: chamada de áudio WebRTC entre um Windows numa
Wi-Fi residencial e um iPhone (Safari) em rede móvel 4G/5G, com sinalização pública HTTPS/WSS (Cloudflare
Tunnel) e STUN/TURN gerenciado (Cloudflare). Plano, decisões e evidências em `docs/validation/POC-02B.md`.

## Estado atual: incremento 02B.5 (escopo proposto para integração: prontidão offline)

- Baseline copiado da POC-02A (`poc/webrtc-audio-lan/`, conteúdo de `f068509`), isolado no 02B.1.
- **CA local e HTTPS local removidos** no 02B.2A.
- **02B.2B:** admissão (chave efêmera do operador e convites de uso único), allowlist de hostnames públicos
  fechada por padrão, `Origin` coerente com o `Host` e limites contra abuso. A chave efêmera do operador foi
  substituída depois pelo pareamento do 02B.2C. Detalhes em `docs/validation/POC-02B.md` §8.
- **02B.2C:** separação administrativa. Dois listeners em loopback (sinalização 5280, administração 5281),
  pareamento do operador por **código de uso único** exibido no terminal (a chave/token nunca é impressa) e
  análise do Cloudflare Access. Detalhes em `POC-02B.md` §9.
- **02B.3A:** validação criptográfica, na origem, do JWT do **Cloudflare Access** (`Cf-Access-Jwt-Assertion`)
  em toda requisição HTTP e todo upgrade WebSocket da sinalização. Com hostname público, o Access é
  **obrigatório**. Nada da Cloudflare foi configurado. Detalhes em `POC-02B.md` §10.
- **02B.3B:** prontidão Cloudflare **offline**. Inclui:
  - modelos `cloudflare/config.example.yml` e `cloudflare/server.env.example`;
  - pré-validação `pnpm preflight:cloudflare`, que recusa configurações inseguras sem imprimir segredos;
  - runbook com checklist, protocolo de teste real e rollback em `cloudflare/README.md`.

  Nada foi ativado. Detalhes em `POC-02B.md` §11.
- **02B.4:** STUN/TURN. Detalhes em `POC-02B.md` §12.
  - **Modos ICE** escolhidos na página:
    - `auto`: STUN + TURN;
    - `direct`: só STUN;
    - `relay`: só TURN, falha fechada;
    - `relay-tls`: só TURN sobre TLS, falha fechada.
  - **Credenciais TURN temporárias** emitidas pelo servidor só para participantes admitidos, por conexão, com
    limites e revogação. O segredo do provedor fica só no servidor.
  - **Caminho de mídia** comprovado pelo par ICE selecionado, nunca pela configuração.
  - **Sem TURN real nesta etapa:** relay e relay-tls não foram comprovados em rede real.
- **02B.5:** prontidão para os testes WAN, **sem ativar nada**. Detalhes em `POC-02B.md` §13 e no runbook
  `cloudflare/README.md`.
  - Matriz R1–R8 com critérios objetivos (todos não executados).
  - Botão **"Copiar evidência (sanitizada)"** na página.
  - `pnpm evidence:check`: valida as evidências sem imprimir valores.
  - `pnpm diagnose`: diagnóstico local simulado, sem rede.
  - `pnpm readiness`: relatório PASS / FAIL / NOT VERIFIED. **Não autoriza a ativação.**
- **Nada foi ativado:** nenhum Cloudflare Tunnel, nenhum TURN real e nenhum hostname público. O código do
  Access e do TURN existe, mas só roda localmente e falha fechado. **Nenhum serviço desta POC deve ser exposto
  na internet** até a aprovação arquitetural dos critérios de exposição (`POC-02B.md` §9.8, §10.10, §11.8,
  §12.11 e §13.5).
- **Revisão independente (29/10/2026):** IR-1 (caminho malformado derrubava o processo) e IR-2 (conexão de
  host sobrevivia à revogação do token administrativo) corrigidos neste PR, com testes de regressão
  (`tests/malformed-path.test.ts`, `tests/admin-revocation.test.ts`). IR-3 a IR-6 aceitos temporariamente só
  para a integração offline, com correção obrigatória antes de qualquer exposição WAN; IR-7 a IR-13 registrados
  como melhorias, validações ou lacunas de teste. Decisão e detalhes em `POC-02B.md` §13.9 e §14.3.
  - Revogar ou substituir o token administrativo encerra na hora (1008) as conexões de operador autorizadas
    por ele. A **expiração** do token (12 h) encerra essas conexões só na próxima limpeza periódica (até cerca
    de 10 s com os padrões) ou quando uma operação revalidar a autorização; nessa janela o operador ainda
    sinaliza (DR-1).
  - Revisão independente do delta `b4101de..e007f4d`: DR-1 e DR-2 aceitos temporariamente só para a prontidão
    offline, com correção e validação obrigatórias antes de qualquer exposição WAN; DR-3 a DR-5 registrados
    como limitações informativas; DR-6 corrigido nesta documentação.

### Escopo proposto para integração

A integração desta POC à `main` está **proposta, não concluída**, e cobre só a **prontidão offline**. Os
critérios de aceite A1–A9 estão em `POC-02B.md` §14 e só são marcados depois de verificados. Testes WAN
reais (R1–R8), túnel e exposição pública exigem aprovação própria.

## Uso local (operador e convidado no mesmo PC)

1. `pnpm build && pnpm serve`. O terminal mostra os dois endereços e um **código de pareamento** (ex.: `K7QD-3M9X`).
   - O código é de **uso único**, expira em 5 min e é queimado após 5 tentativas erradas.
   - Para gerar outro (página recarregada, código expirado ou esgotado), digite `codigo` + Enter no terminal.
     Isso também revoga a sessão administrativa anterior e encerra as conexões de operador abertas com ela.
2. Abra o **endereço administrativo** (`http://localhost:5281`) **só neste computador** e digite o código em
   **Parear operador**. A página recebe um token administrativo que fica **só em memória**: nunca vai para URL,
   armazenamento do navegador ou log. Recarregar a página exige um novo código.
3. Clique em **Criar sessão**. Aparece um **convite de uso único**, que expira em 10 min.
   Sem hostname público configurado, só o código; com hostname público, também o link `https://…/#i=…` e o QR.
4. O convidado usa o **endereço de sinalização** (`http://localhost:5280` hoje; o hostname público no futuro) e
   entra pelo link do convite ou colando o código em **Convite** → **Entrar**.
5. **Reentrada:**
   - o operador usa **Voltar à sessão**;
   - o convidado precisa de um **novo convite**, emitido pelo botão **Novo convite** do operador (cada convite
     vale uma única entrada).

## Modelo de rede

```text
 iPhone / PC ──HTTPS/WSS (certificado público)──► Cloudflare ──túnel──► cloudflared ──HTTP──► Node sinalização (127.0.0.1:5280)
                    └──────────── TLS termina na Cloudflare ────────────┘          └─ loopback, sem TLS ─┘

 Operador (este PC) ──HTTP──► Node administração (127.0.0.1:5281)   ← NUNCA alvo do túnel
```

- O servidor Node escuta **somente em loopback literal** (`127.0.0.1` por padrão; `::1` aceito). Qualquer outro
  endereço é rejeitado antes de abrir o listener, e não existe opção de bind público.
- **Hostnames públicos:** variável `ORYN_PUBLIC_HOSTNAMES` (nomes DNS exatos separados por vírgula; sem curingas,
  IPs, portas ou `localhost`). **Ausente = acesso público fechado.** Com ela, o `Host` público é aceito e o
  `Origin` precisa ser exatamente `https://<hostname>`.
- **Criar sessão, voltar à sessão e emitir convites** só no **listener administrativo** e com o **token
  administrativo** obtido por pareamento. O privilégio vem da porta que aceitou a conexão mais o token, nunca do
  `Host`, do loopback ou de cabeçalhos de proxy. O listener de sinalização não tem nenhum endpoint
  administrativo: mesmo com o `Host` reescrito para `localhost`, nada é autorizado ali.
- O listener administrativo aceita só `Host` local da própria porta (hostnames públicos → 421) e exige `Origin`
  exatamente igual à origem administrativa.
- `--http-port` e `--admin-port` iguais são recusados (configuração ambígua).
- **Cloudflare Access (02B.3A):** com `ORYN_PUBLIC_HOSTNAMES` definido, o servidor **só inicia** com
  `ORYN_ACCESS_MODE=required`, `ORYN_ACCESS_TEAM_DOMAIN=<equipe>.cloudflareaccess.com` e `ORYN_ACCESS_AUD=<AUD tag>`.
  - O listener 5280 inteiro passa a exigir o JWT válido, qualquer que seja o `Host`. Sem token → 403; chaves
    indisponíveis → 503.
  - O 5281 não usa Access.
  - O Access não substitui o convite nem dá privilégio administrativo.
  - Sem hostname público, o padrão é `ORYN_ACCESS_MODE=off` (uso local).
  - Outras variáveis estão em `POC-02B.md` §10.4.
- **STUN/TURN (02B.4):** `ORYN_TURN_PROVIDER=cloudflare|off` (padrão `off`), `ORYN_TURN_KEY_ID`,
  `ORYN_TURN_API_TOKEN` (**segredo**: só em arquivo de ambiente fora do repositório, nunca na linha de comando),
  `ORYN_TURN_TTL_S` e `ORYN_ICE_STUN_URLS`. Com `off`, `relay` e `relay-tls` falham com "TURN indisponível".
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
pnpm preflight:cloudflare -- --config=<config.yml> --env-file=<arquivo>   # offline; ver cloudflare/README.md
pnpm readiness -- --config=<config.yml> --env-file=<arquivo>             # prontidão consolidada (offline)
pnpm diagnose                                                            # diagnóstico local simulado
pnpm evidence:check -- <evidência.json> ...                              # valida evidências sanitizadas
pnpm serve       # requer pnpm build; sinalização em :5280 e administração em :5281 (--http-port=N, --admin-port=N)
```

CI: `.github/workflows/poc-02b-ci.yml`.

## Diferenças em relação à POC-02A

| Item | POC-02A | POC-02B |
|---|---|---|
| Pacote | `@oryn/poc-webrtc-audio-lan` | `@oryn/poc-webrtc-audio-wan` |
| Acesso do celular | HTTPS da LAN com CA local instalada no aparelho | Túnel público com certificado público (futuro); **sem CA local** |
| Listeners | HTTP em loopback + HTTPS no IP da LAN | **Somente HTTP em loopback**: sinalização (5280) e administração (5281) |
| Criar sessão | Qualquer um com acesso à página | Só o operador pareado, pelo listener administrativo |
| `/api/info` | Informava a origem HTTPS ao PC | Removido |
| Convite (link/QR) | Montado com a origem HTTPS da LAN | Montado com a origem da própria página quando ela não é loopback; em `localhost`, só o código |
| Porta padrão | 5180 | 5280 |

A POC-02A permanece intacta em `poc/webrtc-audio-lan/`.
