# POC-02B — Validação: áudio WebRTC bidirecional entre redes distintas

| Campo | Valor |
|---|---|
| Branch | `poc/webrtc-audio-wan`, criada a partir de `main` em `f068509` (PR #3 da POC-02A) |
| Código | `poc/webrtc-audio-wan/` |
| Relação com o ARCHITECTURE.md | P02 (§14): travessia de NAT, CGNAT, TURN e UDP bloqueado; credenciais TURN temporárias (§9.1) |
| Incremento atual | **02B.2B — segurança da sinalização pública** (§8) |
| Status | **02B.1 e 02B.2A aprovados. 02B.2B aguardando revisão do arquiteto.** Exposição pública **proibida** até a aprovação e o cumprimento dos critérios de §8.8 |

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
| **02B.2A** | Remoção da CA local e do HTTPS local; HTTP só em loopback; CI da POC-02B | **Concluído e aprovado** (§7) |
| **02B.2B** | Admissão (operador e convites), allowlist pública fechada por padrão, `Host`/`Origin` coerentes, limites contra abuso | **Concluído; em revisão** (§8) |
| 02B.3 | ~~Admissão e controle de abuso~~ **antecipado para o 02B.2B**; resta a proteção na borda (Access/WAF), a definir com o túnel | Parcial |
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
| Limites por cliente atrás do túnel (todas as conexões vêm de `127.0.0.1`) | Média | 02B.2B usa limites globais e não confia em cabeçalhos; proteção na borda é critério de exposição (§8.7, §8.8) |
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
3. **Autenticação mínima:** criação pelo operador (chave efêmera + `Host` local) e convite de uso único **implementados no 02B.2B**. Pendente: usar também Cloudflare Access ou rate limiting na borda (critério 4 de §8.8).
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

## 8. Incremento 02B.2B — segurança da sinalização pública

**Pré-condições verificadas [Observado]:**
- branch `poc/webrtc-audio-wan`, working tree limpa;
- HEAD `87d57d5`, commit assinado do 02B.2A;
- CI `POC-02B CI` com `success` em `87d57d5` (push e PR).

**Nada foi exposto à internet.** O servidor continua escutando só em loopback.

### 8.1 Modelo de ameaças

| Ator / vetor | Objetivo | Controle no 02B.2B |
|---|---|---|
| Visitante remoto pelo hostname público (futuro túnel) | Criar sessões, entrar sem convite, ouvir a chamada | Criação só com chave do operador **e** `Host` local; entrada só com convite de uso único; 2 participantes |
| Quem recebe, intercepta ou vê o link do convite | Entrar no lugar do convidado | Convite de uso único, 10 min, revogado ao emitir outro ou ao fim da sessão; o operador vê a entrada e pode encerrar (risco residual, §8.7) |
| Site malicioso no navegador do usuário (CSWSH) | Usar a sinalização com a sessão do usuário | `Origin` obrigatório no WebSocket e coerente com o `Host`; `null` e ausente recusados |
| DNS rebinding contra o loopback | Ler a página ou a API locais por outro domínio | `Host` exato (loopback:porta ou hostname público da allowlist); desconhecido → 421 |
| Host spoofing / cabeçalhos de proxy forjados | Fingir ser local ou outro cliente | `X-Forwarded-*` e `CF-Connecting-IP` **nunca lidos**; a zona vem só do `Host` validado |
| Força bruta da chave do operador ou de convites | Obter acesso | 256 bits; 3 falhas fecham a conexão; 5 falhas locais em 60 s bloqueiam o operador por 60 s |
| Esgotamento de recursos | Negar serviço | Até 3 sessões e 8 conexões; admissão em 10 s; rate limit com janela deslizante; 16 KiB por mensagem; expiração de sessões ociosas |
| Vazamento por logs | Expor segredos | Nenhum token, chave, ID completo de sessão, SDP ou IP em logs; recusas amostradas |

**Fronteira de confiança:** atrás do túnel, todas as conexões chegam de `127.0.0.1`. O endereço da conexão, portanto,
**não identifica cliente nem prova origem local**. O que diferencia o acesso local do público é o `Host` validado,
desde que o túnel preserve o `Host` público (§8.8). Mesmo assim, a criação de sessões exige também a chave.

### 8.2 Fluxos de admissão

**Operador (PC):**
1. O servidor gera, a cada início, uma **chave efêmera** de 256 bits e guarda só o SHA-256. A chave aparece uma
   vez no terminal, no link `http://localhost:5280/#op=<chave>`.
2. A página lê a chave do fragmento, mantém só em memória (nunca em `localStorage`/`sessionStorage`) e a remove da
   barra de endereço e do histórico com `history.replaceState`.
3. `create { operatorKey }`: o servidor exige `Host` local e compara a chave em tempo constante. Cria a sessão
   (operador = host) e emite **um convite**.
4. `invite` (operador na sessão): emite um novo convite e **revoga o anterior**. Não é emitido se a vaga de
   convidado estiver ocupada (`session-full`).
5. `rejoin { sessionId, operatorKey }`: o operador volta à vaga de host da própria sessão.

**Convidado (celular):**
1. Recebe `https://<hostname público>/#i=<convite>` (ou o código). O fragmento não vai ao servidor nem ao
   Referer; a página o remove da URL.
2. `join { invite }`: o servidor verifica e **consome** o convite na mesma chamada síncrona, que é atômica no
   Node; o convidado ocupa só a vaga de convidado.

### 8.3 Políticas de expiração, reentrada e limites

| Item | Política (padrão) |
|---|---|
| Chave do operador | Válida até o servidor encerrar; trocada a cada início; só o hash em memória |
| Convite | Uso único; **10 min**; um ativo por sessão; revogado ao emitir outro ou quando a sessão termina |
| Reentrada do operador | `rejoin` com chave + ID da sessão, se a vaga de host estiver livre |
| Reentrada do convidado | **Novo convite** do operador (convites não são reaproveitáveis) |
| Sessão | Até 2 participantes; expira após 10 min com um participante só; termina quando fica vazia |
| Sessões simultâneas | 3 (`server-busy` acima disso) |
| Conexões WebSocket simultâneas | 8 (upgrade recusado com 503 acima disso; limite global, não por IP) |
| Prazo de admissão | 10 s para entrar numa sessão, verificado no heartbeat; vale também para quem sai e continua conectado (1008) |
| Falhas de autorização | 3 na mesma conexão → fechamento (1008); 5 chaves erradas locais em 60 s → bloqueio do operador por 60 s. Tentativas pelo hostname público não contam para o bloqueio, para não permitir que alguém de fora bloqueie o operador |
| Mensagens | 16 KiB; token bucket de 60 de rajada e 20/s; 3 violações em 10 s → fechamento (1008). Antes as strikes nunca expiravam (A8) |
| Logs de recusa | No máximo 1 linha a cada 10 s, com contador de suprimidas |

### 8.4 Configuração de hostnames públicos

- `ORYN_PUBLIC_HOSTNAMES`: lista separada por vírgulas, lida por `server/index.ts`. **Ausente ou vazia = acesso
  público fechado.**
- **Validação na partida:** um valor inválido impede o servidor de subir. Só **nomes DNS exatos**, normalizados para
  minúsculas: sem curinga (`*.`), IP, esquema, porta ou caminho, `localhost` ou nome sem domínio.
- **`Host` aceito:**
  - zona **local**: `127.0.0.1:porta`, `[::1]:porta` (conforme o bind) e `localhost:porta`;
  - zona **pública**: exatamente o hostname, sem porta.
  - Subdomínios, sufixos enganosos, porta explícita e ponto final são recusados (421).
- **`Origin`:** zona local exige `http://<Host>`; zona pública exige `https://<Host>`.
  - **WebSocket:** `Origin` obrigatório.
  - **HTTP:** pode faltar (navegação), mas, se vier, precisa corresponder ao `Host` (senão 403).
- O convite emitido ao operador traz `publicOrigin = https://<primeiro hostname>`, usado no link e no QR.

### 8.5 Segurança de tokens

- **Geração:** `crypto.randomBytes(32)` em base64url (43 caracteres).
- **Armazenamento:** no servidor, só **hashes SHA-256** (chave e convites).
- **Comparação:** em tempo constante na chave do operador; convites por busca do hash.
- **Frontend:** nenhum segredo administrativo no bundle; a chave só chega à página do operador pelo fragmento do
  link do terminal.
- **Navegador:** sem `localStorage`/`sessionStorage`; fragmento removido com `replaceState`; `Referrer-Policy:
  no-referrer`; CSP restritiva. O campo do convite é limpo ao entrar.
- **Mensagens de erro:** genéricas (`unauthorized`, `invite-invalid`). Não revelam se o convite existiu, expirou ou
  foi usado.
- **Riscos residuais de convites por URL:** §8.7.

### 8.6 Matriz de testes [Observado, 22/10/2026]

| Requisito | Onde | Casos |
|---|---|---|
| Convite válido, expirado, revogado, reutilizado | `admission.test.ts`, `registry.test.ts`, `call.test.ts`, E2E | Unitários e integração; E2E com terceiro participante recusado |
| Concorrência no consumo do mesmo convite | `admission.test.ts`, `registry.test.ts`, `abuse.test.ts` | 20 consumos simultâneos (1 sucesso); 10 joins; **6 clientes reais** enviando o mesmo convite (1 entra, 5 `invite-invalid`) |
| Criação sem autorização | `registry.test.ts`, `public-access.test.ts` | Chave errada; chave certa pelo hostname público (via proxy) → `unauthorized` |
| `Host` e `Origin` válidos e inválidos | `public-access.test.ts`, `host-header.test.ts`, `server.integration.test.ts`, `server-host.test.ts` | Esquema errado, cruzado, `null`, ausente, porta, subdomínio, sufixo, caixa |
| Configuração pública ausente | `public-access.test.ts`, `server-host.test.ts` | Fechado por padrão, inclusive via proxy com `X-Forwarded-Host` local |
| Limite de sessões e participantes | `registry.test.ts`, `abuse.test.ts`, `server.integration.test.ts` | `server-busy`; terceiro recusado; `session-full` no novo convite |
| Rate limiting | `abuse.test.ts`, `server.integration.test.ts` | Janela deslizante (violações espaçadas não fecham; 3 na janela fecham) |
| Desconexão e limpeza | `abuse.test.ts`, `registry.test.ts` | Sessão e convites somem; admissão vencida; conexões liberadas |
| Reentrada legítima | `registry.test.ts`, `call.test.ts`, `call-queue.test.ts`, E2E | Operador (`rejoin`) e convidado (novo convite), com áudio nos dois sentidos no E2E |
| Atrás de proxy local simulado | `public-access.test.ts` | Proxy reverso que reescreve `Host` e injeta `X-Forwarded-*`/`CF-Connecting-IP`; o limite global vale para "IPs" diferentes |
| DNS rebinding e Host spoofing | `public-access.test.ts`, `host-header.test.ts` | 5 variantes de `Host` + cabeçalhos de proxy ignorados |
| Segredos fora dos logs | `registry.test.ts`, `abuse.test.ts`, E2E | Chave, convites, IDs, SDP; recusas amostradas |

**Resultados:**

| Verificação | Resultado |
|---|---|
| `pnpm install --frozen-lockfile` | OK |
| `pnpm typecheck` | OK |
| `pnpm test` | **243/243**, 13 arquivos, nenhum pulado (`abuse` 10, `admission` 14, `public-access` 26 novos; `protocol` 40, `registry` 23 reescrito) |
| Arquivos sensíveis a tempo (`abuse`, `public-access`) repetidos 3 vezes | 36/36 nas três |
| `pnpm build` | OK (JS 37,71 kB, 13,50 kB gzip) |
| `pnpm audit` | Nenhuma vulnerabilidade conhecida |
| `pnpm e2e` | **35/35** em duas execuções: Chrome 155.0.8059.85 (operador) ↔ Edge 155.0.4283.62 (convidado); convite de uso único; reentrada do operador e do convidado; chave e convites ausentes de logs |

**Mutações (todas detectadas):**

| Mutação | Testes que falharam |
|---|---|
| Chave aceita por `Host` público | 5 |
| Convite reutilizável | 9 |
| `Origin` sempre aceito | 7 |
| Sem teto de conexões | 2 |
| Sem prazo de admissão | 2 |
| `Host` desconhecido tratado como público | 22 |

**Defeito encontrado pelo E2E e corrigido:** o botão "Novo convite" ficava dentro do bloco do convite, oculto depois
de "Voltar à sessão"; o operador não conseguia emitir convite. Agora o botão aparece para o operador em sessão.

**CI:** o workflow foi preservado sem alterações. Os novos testes rodam nos jobs `checks` (Ubuntu e Windows) e
`e2e` (Windows) já existentes. **[Não executado]** a execução no GitHub com estas mudanças depende do commit e do
push do usuário.

### 8.7 Riscos residuais

| Risco | Severidade | Situação |
|---|---|---|
| **Convite por URL:** quem obtiver o link (app de mensagens, captura de tela, QR visto por terceiros, área de transferência) pode entrar antes do convidado legítimo. Não há aprovação manual da entrada | Média | Uso único, 10 min, revogação, 2 vagas. O operador percebe a entrada e pode encerrar. Opção futura: confirmação do operador antes de admitir |
| **Chave do operador no terminal:** fica no histórico do terminal e pode vazar por compartilhamento de tela ou redirecionamento de saída | Média | Efêmera (troca a cada início), só local; exige também `Host` local. Não compartilhar o link |
| **Negação de serviço pelo hostname público:** conexões sem convite podem ocupar as 8 vagas por até cerca de 10 s cada, de forma repetida | Média, ao expor | Limite global e prazo de admissão; **proteção na borda (Cloudflare Access ou rate limiting) é critério de exposição** (§8.8) |
| **Sem limites por cliente:** atrás do túnel não há identidade de cliente confiável | Média, ao expor | `CF-Connecting-IP` só poderia ser usado se a origem fosse comprovadamente o túnel. Fica para avaliação com a configuração real |
| Túnel configurado para reescrever o `Host` para `localhost` | Alta, se ocorrer | O tráfego público seria classificado como local. A chave continua exigida, mas uma camada se perde. **Critério de exposição** |
| XSS na página do operador exporia a chave em memória | Baixa | CSP `script-src 'self'`, nenhum HTML dinâmico (`textContent`), sem dependências de UI além de `uqr` |
| Bloqueio do operador por um processo local malicioso | Baixa | Exige acesso ao próprio PC; bloqueio dura só 60 s |

### 8.8 Critérios para permitir a futura exposição pública (02B.6)

Todos obrigatórios, sujeitos à aprovação do arquiteto:

1. 02B.2B aprovado e `POC-02B CI` verde no GitHub com este código.
2. Túnel com **um único hostname**, entrada para `http://127.0.0.1:5280` e **sem reescrita do `Host`** (o
   `cloudflared` deve preservar o hostname público); regra final devolvendo 404 para o resto.
3. `ORYN_PUBLIC_HOSTNAMES` com exatamente esse hostname, conferido no banner de partida do servidor.
4. **Proteção na borda:** Cloudflare Access ou, no mínimo, rate limiting/WAF na Cloudflare para o hostname
   (decisão pendente, §6).
5. Exposição só durante a janela de teste; túnel e servidor encerrados ao fim.
6. Link do operador nunca compartilhado; convite enviado por canal privado e entrada conferida pelo operador.
7. Revisão dos logs do servidor e do túnel após o teste (sem segredos).
8. TURN não exposto antes do 02B.4.
