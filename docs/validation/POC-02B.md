# POC-02B — Validação: áudio WebRTC bidirecional entre redes distintas

| Campo | Valor |
|---|---|
| Branch | `poc/webrtc-audio-wan`, criada a partir de `main` em `f068509` (PR #3 da POC-02A) |
| Código | `poc/webrtc-audio-wan/` |
| Relação com o ARCHITECTURE.md | P02 (§14): travessia de NAT, CGNAT, TURN e UDP bloqueado; credenciais TURN temporárias (§9.1) |
| Incremento atual | **02B.2A — remoção da CA local e CI** (§7) |
| Status | **02B.1 aprovado. 02B.2A aguardando revisão do arquiteto.** Exposição pública **proibida** antes da aprovação do 02B.2B (§7.7) |

Legenda:
- **[Observado]:** medido em execução pelo agente.
- **[Inferido]:** conclusão sem verificação direta.
- **[Informado pelo usuário]:** relato do usuário.
- **[Não executado]:** teste que não foi feito.

## 1. Escopo

**Objetivo da POC-02B:**
- chamada de áudio WebRTC bidirecional entre **Windows numa Wi-Fi residencial** e **iPhone (Safari) só em
  4G/5G**;
- sinalização pública por HTTPS/WSS, com STUN para descoberta e TURN para fallback e testes de relay;
- coleta de métricas ICE e de qualidade.

**Decisões arquiteturais aprovadas:**
- Node.js para a sinalização, exposto por **Cloudflare Tunnel** com certificado publicamente confiável (provisória);
- **Cloudflare TURN gerenciado**, sujeito à validação de disponibilidade e custos (provisória);
- **sem Supabase nesta POC**;
- 02B.1 aprovado (baseline isolado);
- **remoção da CA local e do HTTPS local da POC-02B** e **criação do CI** no incremento 02B.2A.

**Modelo de rede:**

```text
 iPhone / PC ──HTTPS/WSS (certificado público)──► Cloudflare ──túnel──► cloudflared ──HTTP──► Node (127.0.0.1)
                    └──────────── TLS termina na Cloudflare ────────────┘          └─ loopback, sem TLS ─┘
```

- **O TLS público termina na infraestrutura da Cloudflare.** O trecho da Cloudflare até o `cloudflared` no PC
  segue pelo túnel, e o `cloudflared` entrega ao Node por **HTTP em loopback**.
- O Node nunca escuta na rede: só em loopback literal (§7.2).
- O túnel é incremento futuro (02B.6). **Hoje** apenas o próprio PC acessa a POC.

**Fora do escopo:** Supabase, autenticação definitiva, SFU, Android, produção, e reuso da CA local da POC-02A na
internet.

### Incrementos

| Incremento | Conteúdo | Situação |
|---|---|---|
| **02B.1** | Cópia isolada da POC-02A, baseline de testes, este documento | **Concluído e aprovado** |
| **02B.2A** | Remoção da CA local e do HTTPS local; HTTP só em loopback; CI da POC-02B | **Concluído; em revisão** (§7) |
| 02B.2B | Configuração por ambiente (falha fechada) e `Host`/`Origin` para o hostname público | Não iniciado |
| 02B.3 | Admissão e controle de abuso: criação só pelo operador, convite de uso único, tetos, expiração (A2, A8) | Não iniciado |
| 02B.4 | Credenciais TURN emitidas no servidor (TTL, revogação, provedor simulado nos testes) | Não iniciado |
| 02B.5 | Cliente: `iceServers`, modos `auto`/`direto`/`relay`/`relay-tls`, estados `disconnected`/`failed` (A6), métricas de relay | Não iniciado |
| 02B.6 | Exposição via Cloudflare Tunnel (runbook) | Não iniciado |
| 02B.7 | E2E opcional com TURN real em ambiente local (o CI sem segredos foi antecipado para o 02B.2A) | Não iniciado |
| 02B.8 | Testes manuais da matriz (§5) e registro de evidências | Não iniciado |

## 2. Incremento 02B.1 — preparação e isolamento

### 2.1 Origem do código

- **Fonte:** os 37 arquivos **rastreados pelo Git** em `poc/webrtc-audio-lan/` (conteúdo de `f068509`), copiados
  para `poc/webrtc-audio-wan/`.
- **Antes dos ajustes [Observado]:** os 37 eram idênticos byte a byte à origem.
- **Não copiados:** `node_modules/`, `dist/`, certificados, chaves, `.env` e artefatos temporários (nenhum era
  rastreado).

### 2.2 Ajustes de isolamento (sem mudança de comportamento)

| Arquivo | Ajuste | Motivo |
|---|---|---|
| `package.json` | Nome `@oryn/poc-webrtc-audio-wan` e descrição | Identidade própria |
| `server/index.ts` | Portas padrão HTTP **5280** e HTTPS **5543**; banner "POC-02B" | Rodar ao lado da POC-02A (5180/5443) sem conflito |
| `server/share-ca.ts` | Porta padrão **5281** | Idem |
| `server/certs.ts` | Pasta `oryn-poc-wan` (era `oryn-poc-lan`); CN "Oryn POC-02B" | Não ler nem sobrescrever a CA da POC-02A; evitar confusão no aparelho |
| `index.html` | Título e cabeçalho "POC-02B" | Identificação visível |
| `server/server.ts`, `src/protocol.ts` | Cabeçalho do arquivo com atribuição de origem | Rastreabilidade |
| `tests/…` (4 arquivos) | Prefixos de pastas temporárias `oryn-wan-` | Execuções paralelas não se misturam |
| `README.md` | Reescrito como README de baseline | O da POC-02A ensina a instalar a CA local, o que **não deve** ser seguido para acesso pela internet |

Os valores de exemplo `5180`/`5443` em testes puros (`host-header.test.ts`, `tls.test.ts`) foram **mantidos**: são
literais de teste que não dependem das portas padrão.

### 2.3 Baseline [Observado, 22/10/2026, Windows, Node 24.19.0, pnpm 12.6.0]

| Verificação | Resultado | Referência (POC-02A) |
|---|---|---|
| `pnpm install --frozen-lockfile` | OK | — |
| `pnpm typecheck` | OK | OK |
| `pnpm test` | **184/184**, 11 arquivos, nenhum pulado | 184/184 |
| `pnpm build` | OK (JS 35,74 kB, 12,94 kB gzip) | Idem |
| `pnpm audit` | Nenhuma vulnerabilidade conhecida | Idem |
| `pnpm e2e` | **27/27**, Chrome 155.0.8059.85 ↔ Edge 155.0.4283.62 | 27/27 |
| Execução lado a lado | 02B em `localhost:5280` ("Oryn POC-02B…") e 02A em `localhost:5180`, ao mesmo tempo, ambas HTTP 200 | — |

**Nenhuma diferença em relação ao baseline esperado.**

### 2.4 Integridade da POC-02A

`git diff` vazio para `poc/webrtc-audio-lan/` e `docs/validation/POC-02A.md`, e nenhum arquivo novo nessas
pastas **[Observado]**. O `dist/` e o `node_modules/` locais da POC-02A, ignorados pelo Git, também não foram
alterados pela cópia.

## 3. Limitações conhecidas no baseline

- **O comportamento é o da POC-02A:** só LAN, sem STUN/TURN (`iceServers: []`), sem sinalização pública.
- ~~O modo HTTPS da LAN com CA local continua no código herdado.~~ **Removido no 02B.2A** (§7).
- **Achados da auditoria mantidos como dívida técnica** (POC-02A §13.5): A2 (sem limite de conexões por cliente),
  A4 (ID de sessão como única credencial), A5 a A8, A9 e A10. Os incrementos 02B.3 e 02B.5 tratam A2, A6 e A8, por
  serem pré-requisitos para exposição pública.
- ~~Sem CI.~~ **CI criado no 02B.2A** (§7.4), ainda não executado no GitHub.

## 4. Riscos

| Risco | Severidade | Situação |
|---|---|---|
| Expor o servidor herdado na internet antes de 02B.2/02B.3 (sem admissão nem tetos; A2 confirmado na auditoria) | **Alta, se ocorrer** | Mitigação: não expor nada até concluir 02B.3; registrar como pré-condição do 02B.6 |
| Código duplicado entre 02A e 02B (correções futuras não se propagam) | Baixa | Aceito: POCs são descartáveis e isoladas, com atribuição de origem |
| Uso indevido da CA local herdada | — | **Eliminado:** CA removida no 02B.2A |
| CI ainda não executado no GitHub | Baixa | Lógica testada localmente; aprovação depende de execução real após o push |
| `poc-02a-ci.yml` marcado como obrigatório (filtro de caminho no PR) | Média, se ocorrer | Não marcar; usar só `POC-02B CI (resultado)` como obrigatório |
| Limites por cliente atrás do túnel (todas as conexões vêm de `127.0.0.1`) | Média | Tratar no 02B.3 sem confiar em cabeçalhos não verificados |
| Franquia e disponibilidade do TURN da Cloudflare | Média | Confirmados em documentação: 1.000 GB/mês grátis e US$ 0,05/GB. Ainda **não verificados na conta**: se exige forma de pagamento e se há limites da conta |

## 5. Matriz inicial de testes (a executar nos incrementos seguintes)

Todos **[Não executado]** neste incremento.

| # | Teste | Pré-condições | Execução | Evidência | Critério de aprovação |
|---|---|---|---|---|---|
| 1 | Regressão na LAN | Windows e iPhone na mesma Wi-Fi; 02B.6 concluído | Modo `auto` pela URL pública | Resumo de stats dos dois aparelhos; relato | Áudio nos dois sentidos; tipo do par registrado |
| 2 | Windows Wi-Fi ↔ iPhone 4G/5G | iPhone com Wi-Fi desligado | Modo `auto` | Tipos de candidato, `relayProtocol`, RTT, perda, jitter; relato | Áudio nos dois sentidos; par efetivo registrado |
| 3 | Tentativa direta (STUN) | Cenário do teste 2 | Modo `direto` (sem TURN) | Estado ICE final e pares tentados | Resultado registrado, sucesso ou falha. Falha não reprova a POC |
| 4 | TURN forçado | Credenciais TURN válidas | `iceTransportPolicy: "relay"` nos dois lados | Par `relay ↔ relay`, `relayProtocol`, métricas | Áudio nos dois sentidos com par `relay` comprovado nos stats |
| 5 | UDP bloqueado / TURN TLS | Método definido (§6) | Modo `relay-tls` e, se viável, bloqueio de UDP | `relayProtocol` = tls ou tcp | Chamada via TLS/TCP **ou** limitação documentada |
| 6 | Mute e saída/entrada | Chamada ativa | Mute em cada lado; iPhone sai e entra de novo | Relato; `epoch` e pares no resumo | Mute independente; reentrada restabelece o áudio |
| 7 | Encerramento e liberação | Chamada ativa | Encerrar em cada lado | Indicador de microfone; revogação da credencial TURN; servidor sem sessões | Recursos liberados; credencial inválida após o fim |
| 8 | Queda da sinalização | Chamada ativa | Derrubar o túnel ou o servidor | Comportamento e tempo até o estado final | Comportamento decidido em §6, sem recursos órfãos e com mensagem clara |

**Regressão automatizada exigida em todo incremento:** typecheck, testes unitários e de integração, build, audit e
E2E Chrome ↔ Edge. O CI não deve usar segredos.

## 6. Decisões pendentes

Registradas sem antecipar implementação. Cabem ao arquiteto e ao usuário.

1. **Conta Cloudflare e chave TURN:** criação pelo usuário; segredos só no `.env` local (o `.gitignore` já ignora
   `.env`/`.env.*` e permite `.env.example`), nunca no chat nem no repositório. Confirmar se o TURN exige forma de
   pagamento.
2. **Domínio:** túnel nomeado com domínio próprio (URL fixa; permite Cloudflare Access) ou Quick Tunnel (URL
   aleatória, limite de 200 requisições simultâneas, sem garantia de disponibilidade).
3. **Autenticação mínima:** só criação pelo loopback com convite de uso único, ou também Cloudflare Access.
4. ~~Destino do modo HTTPS/CA local herdado.~~ **Resolvida:** removido no 02B.2A.
5. **ICE restart:** nesta POC ou na seguinte.
6. **Comportamento na queda da sinalização (teste 8):** encerrar de forma limpa (comportamento atual) ou manter o
   áudio por uma janela tentando reconectar.
7. **Método do teste de UDP bloqueado:**
   - modo `relay-tls` no navegador;
   - flag de política de IP do Chromium (a verificar);
   - regra no Firewall do Windows, que é alteração de sistema e exige autorização do usuário.
8. ~~CI da POC-02B.~~ **Resolvida:** criado no 02B.2A.
9. **Uso de dados móveis:** estimativa de cerca de 22 MB/h de áudio **[Inferido]**.
10. **Proteção da `main`:** se for usada, marcar como obrigatório apenas `POC-02B CI (resultado)`.

## 7. Incremento 02B.2A — remoção da CA local e CI

**Pré-condições verificadas [Observado]:**
- branch `poc/webrtc-audio-wan`, working tree limpa;
- baseline do 02B.1 registrado no commit assinado `62690a2`.

### 7.1 Removido da POC-02B (somente da POC-02B)

| Item | Detalhe |
|---|---|
| Geração da CA própria e do certificado do servidor | `server/certs.ts`, `server/certs-cli.ts`; script `pnpm certs` |
| Compartilhamento da CA por HTTP | `server/share-ca.ts`; script `pnpm share-ca` |
| Instalação de certificado no iPhone | Instruções removidas do README |
| Listener HTTPS local | `HttpsOptions`, `https.createServer`, `httpsOrigin`, lista de hosts HTTPS e o upgrade WSS local em `server/server.ts`; opções `--ip`, `--https-port`, `--cert-dir`, `--no-https` em `server/index.ts` |
| `/api/info` | Só servia para informar a origem HTTPS da LAN ao PC |
| Testes da CA e do HTTPS | `tests/tls.test.ts` (12 testes), substituídos conforme §7.3 |

**Fail-closed:** uma configuração legada com a opção `https` agora é **recusada com erro explícito**, antes de
abrir qualquer porta, em vez de ser ignorada.

### 7.2 Preservado

- HTTP **somente em loopback literal** (`127.0.0.0/8` ou `::1`), validado antes de abrir o listener, com conferência
  do endereço efetivo após o bind e **sem opção de bind público**.
- Validação de `Host` (400/421, A3) e de `Origin` no WebSocket (403).
- Protocolo com validação estrita, limite de 16 KiB, recusa de binário, rate limit, heartbeat e expiração de
  sessões.
- Fila de negociação isolada por par (A1); fluxo de mute, saída e reentrada.

**Mudança no cliente:** sem `/api/info`, o link e o QR do convite usam a **origem da própria página** quando ela não
é loopback (no futuro, a URL pública do túnel). Em `localhost`, só o código da sessão é exibido.

### 7.3 Testes adicionados, substituídos e removidos

| Antes (herdado) | Agora | Motivo |
|---|---|---|
| `tls.test.ts` — `isPrivateOrLoopbackIPv4`, extensões OpenSSL, `pathlen`/`nameConstraints`, SAN, prova de violação de `nameConstraints`, chave da CA apagada, `checkCertificates` (7) | **Removidos** | Testavam a CA local, que deixou de existir. Não há comportamento equivalente a testar |
| `tls.test.ts` — `ws://` × `wss://` (1) | **Movido** para `signaling-client.test.ts`, com caso de página HTTPS pública (túnel) e `[::1]` | O comportamento continua válido |
| `tls.test.ts` — HTTPS só com a CA local; TLS 1.0/1.1 recusados (2) | **Substituídos** por "não há TLS local: handshake TLS no listener falha" | Novo comportamento: o TLS é responsabilidade do túnel |
| `tls.test.ts` — `/api/info` ausente no HTTPS; WSS com `Origin` estranho (2) | **Substituídos** por "`/api/info` removido" e "upgrade com Host/Origin público recusado" | Idem |
| `host-header.test.ts` — listener HTTPS da LAN (4) | **Substituídos** por 4 testes de "sem acesso público nesta etapa": hostname público recusado (421), Host do antigo HTTPS da LAN recusado, upgrade com Host público (421) e Origin público (403), handshake TLS falha | Proíbem exposição pública acidental antes do 02B.2B |
| `host-header.test.ts` / `server.integration.test.ts` — `/api/info` (2) | **Substituídos** por "`/api/info` não existe (404; 421 com Host inválido)" | Endpoint removido |
| `server-host.test.ts` — configuração inválida "não abre HTTP nem HTTPS" (11) | **Atualizados:** não abre listener **e não cria o heartbeat** | Mais forte que antes |
| `server-host.test.ts` — falha do HTTPS fecha o HTTP (1) | **Substituído** por "porta HTTP ocupada: rejeita sem heartbeat órfão" | Mesmo objetivo (sem recursos órfãos) |
| `server-host.test.ts` — HTTP e HTTPS juntos (1) | **Substituído** por "sessão completa sem CA nem certificado" | Funcionamento sem CA |
| — | **Novos:** opção `https` legada recusada sem abrir portas; encerramento limpo (porta fechada, WebSockets 1001, heartbeat parado, `close()` idempotente); verificação estática de que não existem módulos ou scripts de certificados nem imports de `node:https`/`node:tls`/OpenSSL no servidor (4) | Pedidos do incremento |

- **Contagem:** 184 − 12 (`tls.test.ts`) + 4 (novos em `server-host`) + 1 (`signalingUrl` movido) = **177**.
- Nenhum teste de segurança foi removido sem substituto aplicável.
- **Verificação dos testes de heartbeat:** feita espionando `setInterval`/`clearInterval` com um período exclusivo,
  de forma determinística. A primeira versão, que contava timers ativos do processo, era instável e foi descartada.
- **Mutações:** sem `clearInterval` no `close()`, 2 testes falham; sem a recusa da opção `https`, 1 falha; sem a
  validação de loopback, 11 falham.

### 7.4 CI (`.github/workflows/poc-02b-ci.yml`)

- **Gatilhos:** push em `poc/webrtc-audio-wan` (com filtro de caminho) e PR para `main`.
- **Jobs:**
  - `checks`: Ubuntu 24.04 e Windows 2025; install `--frozen-lockfile`, typecheck, test, build; audit no Linux;
  - `e2e`: Windows 2025, Chrome e Edge do runner verificados; falha se algum faltar;
  - Node 24.19.0 e pnpm do `packageManager`; actions fixadas por SHA, `contents: read`, `persist-credentials: false`;
  - sem segredos, tokens Cloudflare ou certificados.
- **Checks obrigatórios × filtros de caminho:**
  - um workflow com filtro de caminho no gatilho de PR **nem é criado** quando o PR não toca esses caminhos, e um
    check obrigatório ficaria pendente para sempre, travando o merge;
  - por isso o PR **não tem filtro no gatilho**: o job `changes` compara `base...head` e decide;
  - os jobs pesados só rodam com mudança relevante;
  - o job **`POC-02B CI (resultado)`** roda sempre e é **o único indicado como check obrigatório**.
- **Lógica testada localmente com commits reais [Observado]:**
  - detecção: `f068509...62690a2` (toca a 02B) dá `relevant=true`; `ad8059d...f068509` (PR da 02A) dá
    `relevant=false`; push dá `true`;
  - consolidação: passa só com tudo aprovado ou sem mudança relevante; falha, cancelamento ou pulo indevido dão
    falha.
- **[Não executado]** O workflow **ainda não rodou no GitHub**: depende do commit e do push do usuário. A sintaxe
  foi checada só estruturalmente, porque não há `actionlint` nem parser YAML disponível localmente.
- **Observação sobre a POC-02A:** o `poc-02a-ci.yml` (preservado, sem alterações) usa filtro de caminho no PR e
  **não deve** ser marcado como check obrigatório.

### 7.5 Resultados [Observado, 22/10/2026, Windows, Node 24.19.0, pnpm 12.6.0]

| Verificação | Resultado |
|---|---|
| `pnpm install --frozen-lockfile` | OK |
| `pnpm typecheck` | OK |
| `pnpm test` | **177/177**, 10 arquivos, nenhum pulado (`server-host` 34; `host-header` 23; `signaling-client` 8; demais iguais ao baseline) |
| `server-host.test.ts` repetido 3 vezes | 34/34 nas três (estável) |
| `pnpm build` | OK |
| `pnpm audit` | Nenhuma vulnerabilidade conhecida |
| `pnpm e2e` | **27/27**, Chrome 155.0.8059.85 ↔ Edge 155.0.4283.62, incluindo reentrada na mesma sessão |

### 7.6 Análise de segurança

- **Superfície reduzida:** não há listener na rede local nem na internet; só HTTP em loopback. Nenhuma chave privada
  ou CA é gerada, armazenada ou servida.
- **Sem confiança local adicional:** nenhuma CA precisa ser instalada no iPhone ou no PC. O certificado público do
  túnel (futuro) é validado normalmente pelos navegadores.
- **Falha fechada:** hosts não-loopback, nomes e a opção `https` legada são recusados antes de qualquer recurso ser
  criado. Hostnames públicos são recusados pela validação de `Host`/`Origin` até serem configurados explicitamente.
- **Risco do modelo com túnel (para o 02B.2B e seguintes):**
  - todo o tráfego do túnel chegará ao Node vindo de `127.0.0.1`, então qualquer limite por cliente não pode se
    basear no endereço da conexão;
  - cabeçalhos como `CF-Connecting-IP` só podem ser usados se a origem for comprovadamente o túnel;
  - outros processos do próprio PC também alcançam o loopback (inalterado em relação à POC-02A).

### 7.7 Proibição de exposição pública

**Nenhum serviço da POC-02B pode ser exposto na internet antes da aprovação do 02B.2B.** A exposição pelo túnel
(02B.6) depende também da admissão e do controle de abuso (02B.3), pela severidade do achado A2.
