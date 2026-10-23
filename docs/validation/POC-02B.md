# POC-02B — Validação: áudio WebRTC bidirecional entre redes distintas

| Campo | Valor |
|---|---|
| Branch | `poc/webrtc-audio-wan`, criada a partir de `main` em `f068509` (PR #3 da POC-02A) |
| Código | `poc/webrtc-audio-wan/` |
| Relação com o ARCHITECTURE.md | P02 (§14): travessia de NAT, CGNAT, TURN e UDP bloqueado; credenciais TURN temporárias (§9.1) |
| Incremento atual | **02B.4 — integração STUN/TURN** (§12) |
| Status | **02B.1, 02B.2A e 02B.2C aprovados (02B.2C em `b3e1bf2`, informado pelo usuário). 02B.3A publicado em `ed4d948` com CI verde. 02B.3B publicado em `4b765fe` + `44c82e4` com CI verde. 02B.4 aguardando revisão do arquiteto.** Exposição pública **proibida** até a aprovação e o cumprimento dos critérios de §9.8, §10.10, §11.8 e §12.11 |

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
| **02B.2C** | Listener administrativo separado, pareamento do operador por código de uso único, análise do Cloudflare Access | **Concluído e aprovado** (§9) |
| **02B.3A** | Validação criptográfica do JWT do Cloudflare Access na origem (HTTP e WebSocket), JWKS com cache e falha fechada | **Concluído** (§10); `ed4d948`, CI verde |
| **02B.3B** | Prontidão Cloudflare offline: modelos, pré-validação, fronteira de confiança, runbook e protocolo de teste real | **Concluído** (§11); `4b765fe` + `44c82e4`, CI verde |
| 02B.3 | ~~Admissão e controle de abuso~~ **antecipado para o 02B.2B**; resta a proteção na borda (Access/WAF), a definir com o túnel | Parcial |
| **02B.4** | Modos ICE (auto/direct/relay/relay-tls), credenciais TURN temporárias emitidas no servidor (adaptador, limites, revogação), estatísticas do par selecionado | **Concluído; em revisão** (§12) |
| 02B.5 | ~~Modos ICE e métricas de relay~~ **antecipados para o 02B.4**; resta o tratamento de `disconnected`/`failed` (A6) e o ICE restart (§6, item 5) | Parcial |
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
3. **Autenticação mínima:** convite de uso único **implementado no 02B.2B**; operador por listener administrativo + pareamento **no 02B.2C** (substitui a chave + `Host` local). Pendente: proteção na borda, Cloudflare Access com validação do JWT na origem ou alternativa (§9.5, critério 4 de §9.8).
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

## 9. Incremento 02B.2C — hardening da sinalização WAN

**Pré-condições verificadas [Observado]:**
- branch `poc/webrtc-audio-wan`, working tree limpa;
- HEAD `77f4c77` igual a `origin/poc/webrtc-audio-wan`;
- `POC-02B CI` com `success` em push e pull_request.

**Nada foi exposto à internet.** Os dois listeners escutam só em loopback. Não há configuração de Cloudflare
(Tunnel, Access, WAF) nem de TURN, e nenhuma credencial real foi usada.

### 9.1 Decisões

| # | Decisão | Motivo |
|---|---|---|
| D1 | **Dois listeners HTTP em loopback**: sinalização (padrão **5280**, futuro alvo do túnel) e administração (padrão **5281**, só para o operador neste PC) | Separar a superfície pública da administrativa. O túnel aponta para uma porta que **não tem** capacidade administrativa |
| D2 | O privilégio de operador vem do **listener que aceitou a conexão** (`context.admin`) **e** de um **token administrativo** válido | O `Host` é controlado pelo cliente (ou reescrito pelo túnel) e loopback não identifica ninguém (§8.1). Nenhum dos dois concede privilégio |
| D3 | O listener de sinalização **não tem** `/admin/pair`, nem `create`, `rejoin` ou `invite` autorizados, mesmo com token válido | Separação real: um token vazado não serve pelo túnel |
| D4 | O listener administrativo aceita **só `Host` local da própria porta**. Hostnames públicos, a porta da sinalização e nomes desconhecidos → 421 | Um túnel mal apontado para 5281 não serve nada com `Host` público |
| D5 | `Origin` exato por listener: `http://<Host administrativo>` no administrativo; regras do §8.4 na sinalização | A página de sinalização (outra porta = outra origem) não fala com o administrativo |
| D6 | Configurações ambíguas recusadas antes de abrir qualquer porta: `--http-port` = `--admin-port`; opção legada `operatorKeyHash`; opção legada `https` | Falha fechada, nunca ignorar silenciosamente |
| D7 | **Entrega da credencial por código de pareamento** (§9.3). O terminal mostra só um código curto de uso único; o token nunca é impresso | Requisito B: nada de chave completa no terminal, em arquivo ou no histórico |
| D8 | Uma sessão administrativa por vez: novo pareamento revoga o token anterior; `codigo` + Enter no terminal revoga tudo e gera outro código | Recuperação simples se o código ou a página vazarem |
| D9 | Limites globais (conexões, sessões) e prazo de admissão **somados entre os dois listeners** | Um WebSocketServer compartilhado; o listener administrativo não abre uma "segunda cota" |

### 9.2 Alternativas consideradas para a entrega da credencial

| Alternativa | Avaliação | Decisão |
|---|---|---|
| Link com a chave no fragmento (`#op=`, 02B.2B) | Chave completa no terminal: fica no scrollback, em logs de terminal e em compartilhamento de tela | **Removida** |
| Abrir o navegador automaticamente com a chave na URL | A URL passa pela linha de comando do processo (visível a outros processos) e entra no histórico do navegador | Rejeitada |
| Cookie de sessão administrativa | Cookies **não são isolados por porta**: um cookie de `localhost:5281` também é enviado a `localhost:5280`. Exigiria `SameSite`/flags e ainda mistura as origens | Rejeitada |
| Endpoint de bootstrap que devolve a chave a quem pedir em loopback | Qualquer processo local ou página com acesso ao loopback obteria a chave | Rejeitada (proibida pelo requisito) |
| Chave persistida (DPAPI, cofre do SO, arquivo) | Persistência contraria o requisito; mais complexidade | Rejeitada |
| **Código de pareamento curto, de uso único, trocado por token em memória** | Simples, sem persistência; o terminal mostra só um segredo de curta duração e uso único; resistente a CSRF com as proteções de §9.3 | **Adotada** |

### 9.3 Fluxos de autenticação

**Pareamento do operador (listener administrativo):**
1. Na partida, o servidor gera um **código de pareamento**: 8 caracteres Crockford base32 (**40 bits**),
   exibido como `XXXX-XXXX`. Ele é de **uso único**, vale **5 min** e é **queimado após 5 tentativas erradas**.
   O servidor guarda só o SHA-256.
2. O operador abre `http://localhost:5281`. O formulário de pareamento só aparece em páginas de loopback.
3. A página envia `POST /admin/pair` com `{"code": "…"}`. O servidor exige, **todos**:
   - `Host` local da porta administrativa (senão 421);
   - `Origin` **presente e exatamente** a origem administrativa (`null`, ausente, outra porta ou `https` → 403);
   - `X-Oryn-Admin: 1` e `Content-Type: application/json` (cabeçalho customizado e tipo não "simples" forçam
     preflight CORS, que o servidor nunca autoriza: nenhum `Access-Control-Allow-*` é enviado);
   - `Sec-Fetch-Site`, quando enviado, igual a `same-origin`;
   - corpo de até 1 KiB, exatamente `{code}` com string de até 32 caracteres (senão 400; tipo errado → 415).
4. Sucesso: resposta `{token, expiresAt}` com `Cache-Control: no-store`. O token tem **256 bits**, vale **12 h**,
   e o servidor guarda só o SHA-256, comparado em tempo constante. O código é descartado.
5. A página mantém o token **só em memória** (nunca URL, `localStorage`, `sessionStorage` ou log) e limpa o campo
   do código. Recarregar a página exige novo código (`codigo` + Enter no terminal).
6. `create`/`rejoin` levam o token no campo `operatorKey`. Só são autorizados por conexões do listener
   administrativo.

Requisições recusadas por origem, cabeçalhos ou formato **não consomem o código nem contam tentativa**. Só um
código errado bem-formado conta.

**Convidado (listener de sinalização):** inalterado em relação ao §8.2. Convite de uso único emitido pelo
operador; `join { invite }` consome o convite atomicamente.

**Recuperação:** `codigo` + Enter no terminal revoga o token vigente e o código pendente e gera outro código.
Encerrar o servidor revoga tudo (nada é persistido).

### 9.4 Modelo de ameaças (atualização do §8.1)

| Ator / vetor | Controle no 02B.2C |
|---|---|
| Visitante remoto pelo túnel (5280) | Nenhuma operação administrativa existe nesse listener; token válido é recusado (`unauthorized`); `/admin/pair` → 405 |
| Túnel que reescreve `Host` para `localhost:5280` | A requisição parece local, mas chega pelo listener de sinalização: **nenhum privilégio**. Testado com proxy |
| Túnel mal apontado para 5281 com `Host` público | 421 em HTTP, WebSocket e `/admin/pair` |
| Pior caso: túnel para 5281 reescrevendo `Host` para `localhost` | Ainda exige o código, que só aparece no terminal. 5 palpites (40 bits) queimam o código. **Proibido pelos critérios de exposição** |
| Página maliciosa no navegador do operador (CSRF, outra origem local ou da internet) | Preflight bloqueado (cabeçalho customizado + JSON); `Origin` exato; `Sec-Fetch-Site`; POST "simples" (`text/plain`, formulário) → 415/403 sem consumir o código. WebSocket administrativo exige `Origin` exato |
| DNS rebinding contra 5281 | `Host` exato da porta administrativa; desconhecido → 421 |
| Cabeçalhos de proxy forjados (`X-Forwarded-*`, `CF-Connecting-IP`) | Nunca lidos (§8.1) |
| Força bruta do código | 40 bits, 5 tentativas por código, TTL de 5 min: probabilidade por código ≈ 5/2⁴⁰ |
| Outros **usuários do SO** no mesmo PC (alcançam o loopback) | Não veem o terminal do operador: precisam do código |
| Vazamento por terminal, logs ou histórico | O token nunca é impresso nem registrado; o código é curto, de uso único e expira |

**Fora do modelo de ameaças (decisão explícita):** processos executando **com o mesmo usuário do SO** do operador.
Eles podem ler o buffer do console, a memória do navegador e do Node, injetar código no navegador ou registrar
teclas. Nenhum mecanismo local simples protege contra isso. Esse cenário equivale a comprometer o PC do operador.

### 9.5 Proteção na borda: Cloudflare Access (análise; nada configurado)

**Fatos da documentação oficial [Informado pela documentação da Cloudflare, consultada no planejamento]:**
- O Access autentica na borda e encaminha à origem o JWT da sessão no cabeçalho **`Cf-Access-Jwt-Assertion`**.
- A Cloudflare recomenda que a origem **valide esse JWT**:
  - assinatura com as chaves de `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, pelo `kid`;
  - `aud` (tag da aplicação), `iss` (domínio da equipe) e `exp`.
- O cookie `CF_Authorization` **não tem garantia de ser repassado** à origem. Não deve ser a base da validação.
- No Safari, o Access exige que o bloqueio de **todos** os cookies esteja desligado.
- A duração padrão da sessão é de 24 h (configurável).

**Impacto e desenho [Inferido; a validar com a configuração real no 02B.6]:**
- **Ordem no navegador:** o login do Access acontece numa **navegação** (redirecionamento para a página de
  login e volta). Um WebSocket não segue redirecionamentos de login. Portanto, a sessão do Access precisa existir
  **antes** de a página abrir o WebSocket:
  1. o convidado abre o link do convite;
  2. o Access exige login e redireciona de volta;
  3. a página carrega já autenticada;
  4. o upgrade WSS para o mesmo hostname leva o cookie de sessão do Access, e a borda injeta o JWT.

  Se a sessão expirar no meio da chamada, a reconexão falha até uma nova navegação. A página deve orientar
  "recarregue a página".
- **iPhone Safari:** exige cookies não bloqueados por completo. O cookie é primário no hostname do túnel, então
  o ITP não deveria afetá-lo, mas isso precisa de teste no aparelho. Login por e-mail (código de uso único) é o
  método menos dependente de terceiros.
- **Validação na origem (incremento futuro, não implementado):**
  - o listener de sinalização validaria `Cf-Access-Jwt-Assertion` em **toda** requisição HTTP e em **todo**
    upgrade com `Host` público;
  - as chaves JWKS ficariam em cache e a validação falharia fechada se o JWT faltasse ou fosse inválido;
  - configuração por `ORYN_ACCESS_TEAM_DOMAIN` e `ORYN_ACCESS_AUD`, sem segredos;
  - isso cobre um Access removido ou mal configurado (caminho ou hostname não cobertos) e não depende de cookies;
  - requisições com `Host` local (listener de sinalização a partir do próprio PC) não teriam JWT e
    continuariam atendidas só em loopback.
- **Camadas independentes:** o Access controla **quem** pode chegar à página. O convite de uso único continua
  sendo exigido para **entrar numa sessão**, e as operações administrativas continuam só na porta 5281. Uma
  camada não substitui a outra.
- **Custo de uso:** o convidado precisa estar na política do Access (e-mail permitido), o que é aceitável para
  um teste controlado com um só aparelho.

**Se o Access for inadequado** (fricção no Safari, convidados sem e-mail conhecido), estas são as alternativas,
em ordem de preferência:
1. Regra de rate limiting/WAF da Cloudflare restrita ao hostname e a `/ws`, mais desafio gerenciado na
   navegação inicial (não no WebSocket).
2. Exposição só durante a janela de teste, com o túnel encerrado logo depois.
3. Manter o convite e os limites globais atuais como única defesa, aceitando o risco de DoS do §8.7.

**Recomendação:** Access com validação do JWT na origem, **implementada e testada antes do 02B.6**. O WAF/rate
limiting fica como alternativa se o teste no iPhone mostrar fricção inaceitável. **Decisão do arquiteto.**

### 9.6 Testes [Observado, 22/10/2026, Windows, Node 24.19.0]

| Requisito | Onde | Casos |
|---|---|---|
| Separação entre listeners | `admin-listener.test.ts`, `server-host.test.ts` | Portas distintas, ambas loopback (IPv4 e `::1`); portas iguais recusadas sem abrir porta; porta administrativa ocupada libera a de sinalização; sem `adminPort` não há operador |
| Endpoints administrativos bloqueados no listener público | `admin-listener.test.ts`, `abuse.test.ts`, `public-access.test.ts` | `POST /admin/pair` → 405 com cabeçalhos perfeitos (código intacto); `create`/`rejoin`/`invite` com token válido → `unauthorized`; rejoin só pelo administrativo |
| `Host`/`Origin` forjados no administrativo | `admin-listener.test.ts` | Hostname público, porta da sinalização, rebinding, sem porta, `X-Forwarded-Host` local; WebSocket com `Origin` `null`, ausente, da sinalização, `https`, incoerente |
| `Host` reescrito para `localhost` | `public-access.test.ts` | Proxy para 5280 reescrevendo para `localhost`: sem privilégio e `/admin/pair` 405; proxy para 5281 com `Host` público: 421; pior caso (5281 + `localhost`): exige código e 5 palpites o queimam |
| Ausência de vazamento da chave | `cli-leak.test.ts`, `admin-listener.test.ts`, `abuse.test.ts`, E2E | Processo real (`server/index.ts`): a saída tem o código e **nenhuma** sequência de 43 caracteres base64url, nem token, convite ou ID de sessão; logs sem código e sem token; token fora da URL e do armazenamento do navegador (E2E) |
| CSRF no bootstrap | `admin-listener.test.ts` (16 variações), E2E | Sem `Origin`, `Origin` de outro site, `null`, da sinalização, incoerente ou `https`; sem ou com valor errado de `X-Oryn-Admin`; `Sec-Fetch-Site` `cross-site`/`same-site`; `text/plain`; formulário; JSON extra, não textual, inválido ou longo. Todos recusados **sem consumir o código**. GET/OPTIONS → 405 sem CORS. No E2E, página maliciosa real em outra origem local: `fetch` com preflight → `TypeError`; POST `no-cors` opaco; código intacto |
| Pareamento | `admin-auth.test.ts` (13), `admin-listener.test.ts` | Formato, normalização (hífen, minúsculas, I/L/O), uso único, expiração, 5 erros → 429, novo código invalida o anterior, novo pareamento revoga o token, só hashes em memória, `no-store` |
| Limites globais e limpeza | `abuse.test.ts`, `server-host.test.ts` | Teto de conexões **somado** entre os listeners; prazo de admissão também no administrativo; `close()` fecha as duas portas, encerra os WebSockets (1001), revoga o token e para o heartbeat único |
| Fluxos legítimos e reentrada | `server.integration.test.ts`, `host-header.test.ts`, `cli-leak.test.ts`, E2E | Operador no 5281, convidado no 5280; reentrada do operador (`rejoin`) e do convidado (novo convite); `codigo` + Enter no processo real revoga o token e gera outro código |
| Regressão WebRTC Chrome ↔ Edge | E2E | Áudio bidirecional, mute, encerramento e reentradas |

**Resultados:**

| Verificação | Resultado |
|---|---|
| `pnpm typecheck` | OK |
| `pnpm test` | **289/289**, 16 arquivos, nenhum pulado. Novos: `admin-auth` 13, `admin-listener` 32, `cli-leak` 1. Ajustados: `abuse` 12, `public-access` 29, `admission` 9 (testes da chave do operador migraram para `admin-auth`), `server-host` 34, `host-header` 23 |
| Arquivos sensíveis a tempo (`abuse`, `public-access`, `admin-listener`, `cli-leak`) repetidos 3 vezes | 74/74 nas três |
| `pnpm build` | OK (JS 38,59 kB, 13,85 kB gzip) |
| `pnpm audit` | Nenhuma vulnerabilidade conhecida |
| `pnpm e2e` | **41/41** em duas execuções: Chrome 155.0.8059.85 (operador, endereço administrativo) ↔ Edge 155.0.4283.62 (convidado, endereço de sinalização) |

**Mutações (todas detectadas; código restaurado após cada uma):**

| Mutação | Testes que falharam |
|---|---|
| Contexto administrativo em todo listener | 5 |
| Registro ignora o listener (só o token) | 7 |
| Sem exigência de `X-Oryn-Admin` | 2 |
| `Origin` opcional no pareamento | 1 |
| Listener administrativo aceita hostnames públicos | 3 |
| Sem checagem de `Sec-Fetch-Site` | 2 |
| Código de pareamento reutilizável | 2 |
| Sem exigência de `Content-Type` JSON | 2 |
| `/admin/pair` também no listener de sinalização | 2 |
| Sem limite de tentativas do código | 3 |
| Portas iguais aceitas | 1 |
| CLI imprime segredo longo | 1 |

**Defeito encontrado pelo E2E e corrigido:** `.row { display: flex }` anulava o atributo `hidden`, então o
formulário de pareamento nunca era ocultado (nem após parear, nem fora do loopback). Corrigido com
`[hidden] { display: none !important; }` em `src/style.css`.

**CI:** workflow inalterado; os novos testes rodam nos jobs existentes. **[Não executado]** a execução no GitHub
depende do commit e do push do usuário.

### 9.7 Riscos residuais

| Risco | Severidade | Situação |
|---|---|---|
| Processos do mesmo usuário do SO | Alta, se ocorrer | **Fora do modelo** (§9.4). Equivale a comprometer o PC do operador |
| Código visto por terceiros (compartilhamento de tela, foto do terminal) | Baixa | Uso único, 5 min, e o atacante precisa alcançar o loopback (5281 nunca exposto). Se alguém parear antes, o pareamento do operador falha de forma visível; `codigo` + Enter revoga o token do atacante |
| XSS na página administrativa exporia o token em memória | Baixa | CSP `script-src 'self'`, sem HTML dinâmico; o token vale só no listener administrativo (loopback) |
| Clientes sem `Sec-Fetch-Site` (navegadores antigos, ferramentas locais) | Baixa | Defesas principais são `Origin` exato e o preflight; ferramentas locais são processos locais (fora do modelo) |
| Queima repetida do código por um processo local de outro usuário (DoS do pareamento) | Baixa | Exige acesso local; o operador gera outro código. Sem bloqueio persistente |
| Sessão administrativa de 12 h sem botão de logout | Baixa | Fechar a aba descarta o token; `codigo` + Enter ou reiniciar o servidor revoga |
| Riscos do §8.7 não tratados aqui: convite por URL, DoS pelo hostname público, ausência de limite por cliente | Média, ao expor | Proteção na borda (§9.5) segue como critério de exposição |
| Túnel apontado para 5281 | Alta, se ocorrer | 421 para `Host` público; com reescrita para `localhost`, ainda exige o código. **Critério de exposição** |

O risco "chave do operador no terminal" do §8.7 foi **eliminado**: o token nunca é impresso. O risco "túnel
reescrevendo `Host` para `localhost`" foi **reduzido**: a reescrita não concede privilégio administrativo e só
quebra a validação de `Origin` dos convidados.

### 9.8 Critérios para permitir a futura exposição pública (02B.6), substituindo o §8.8

Todos obrigatórios, sujeitos à aprovação do arquiteto:

1. 02B.2B e 02B.2C aprovados e `POC-02B CI` verde no GitHub com este código.
2. Túnel com **um único hostname**, entrada **somente** para `http://127.0.0.1:5280` e regra final devolvendo 404.
   **Nunca** uma entrada para a porta administrativa (5281), nem como caminho, porta alternativa ou serviço
   catch-all.
3. Sem reescrita do `Host`: o `cloudflared` preserva o hostname público.
4. `ORYN_PUBLIC_HOSTNAMES` com exatamente esse hostname, conferido no banner de partida.
5. **Proteção na borda** decidida e implementada:
   - Cloudflare Access com validação do JWT `Cf-Access-Jwt-Assertion` na origem, implementada e testada; ou
   - a alternativa aprovada (§9.5).
6. Pareamento feito só no PC do operador. O código não é mostrado em compartilhamento de tela durante o teste.
7. Exposição só durante a janela de teste; túnel e servidor encerrados ao fim.
8. Convite enviado por canal privado; entrada conferida pelo operador.
9. Revisão dos logs do servidor e do túnel após o teste (sem segredos).
10. TURN não exposto antes do 02B.4.

## 10. Incremento 02B.3A — validação do JWT do Cloudflare Access

**Pré-condições verificadas:**
- [Observado] branch `poc/webrtc-audio-wan`, working tree limpa;
- [Observado] HEAD `b3e1bf2` igual a `origin/poc/webrtc-audio-wan`;
- [Informado pelo usuário] CI do 02B.2C verde. O `gh` não está disponível neste ambiente para conferir.

**Escopo:** tudo local e automatizado. **Não** há Tunnel, DNS, aplicação Access real nem credencial real
configurados. Nenhuma porta foi exposta, e os testes não usam rede pública.

### 10.1 Arquitetura de autenticação

```text
 Navegador ──HTTPS/WSS──► Borda Cloudflare (Access) ──túnel──► Node :5280 (sinalização)
   cookie CF_Authorization    valida a sessão e INJETA            valida o JWT em TODA requisição HTTP
   (enviado pelo navegador)   Cf-Access-Jwt-Assertion             e em TODO upgrade WebSocket

 Operador (este PC) ──HTTP──► Node :5281 (administrativo): sem Access; pareamento + token (02B.2C)
```

| Camada | Pergunta que responde | Onde |
|---|---|---|
| Cloudflare Access (política da aplicação) | Esta pessoa pode chegar à página? | Borda; **conferido na origem pelo JWT** |
| Convite de uso único (02B.2B) | Esta conexão pode entrar **nesta** sessão? | Registro de sessões |
| Listener administrativo + token de pareamento (02B.2C) | Esta conexão é o operador? | Porta 5281 |

As camadas são independentes:
- um JWT válido não substitui o convite nem dá privilégio administrativo;
- o token administrativo não substitui o JWT na porta 5280.

### 10.2 Decisões

| # | Decisão | Motivo |
|---|---|---|
| E1 | **Biblioteca `jose` 6.2.13** (MIT, sem dependências, versão exata no lockfile) para verificar assinatura e claims. As chaves são importadas por `importJWK`; nenhuma primitiva criptográfica foi implementada | Requisito de biblioteca consolidada; `node:crypto` sozinho exigiria escrever o parser e a validação de JWT à mão |
| E2 | **Somente RS256.** `alg` diferente, `none` ou ausência de `kid` são recusados **antes** de buscar chaves; `crit` é recusado | O Access assina com RS256 (documentação). Impede confusão de algoritmos e buscas provocadas pelo cliente |
| E3 | **Seleção explícita da chave pelo `kid`**, num mapa construído e validado na busca do JWKS. O JWT é verificado contra essa chave, com `algorithms: ['RS256']` | Nenhuma chave escolhida por tentativa; `kid` desconhecido nunca autoriza |
| E4 | `iss` e URL do JWKS **derivados** do domínio da equipe (`https://<equipe>.cloudflareaccess.com` e `…/cdn-cgi/access/certs`). O domínio é validado por padrão estrito | Nenhum valor vindo do cliente (nem configuração livre de URL) determina de onde vêm as chaves |
| E5 | Access aplicado ao **listener 5280 inteiro, qualquer `Host`**, inclusive `localhost` | Um túnel que reescrevesse o `Host` para `localhost` não pode escapar da validação |
| E6 | **Sem fallback silencioso:** hostname público sem Access impede a partida. `ORYN_ACCESS_MODE=off` só é aceito sem hostnames públicos e sem nenhuma outra variável `ORYN_ACCESS_*` | Modo sem Access restrito ao uso local |
| E7 | Upgrade: `Host` → caminho → `Origin` → **JWT (assíncrono)** → teto de conexões → upgrade. HTTP: `Host` → `Origin` → JWT → rotas | Checagens baratas primeiro; o teto é verificado depois da espera assíncrona, sem corrida |
| E8 | Conexão WebSocket autenticada **encerrada quando o `exp` do JWT vence** (1008 `access expired`, verificado no heartbeat) | Sessão autenticada com prazo definido; um JWT expirado não sustenta conexão nem abre outra |
| E9 | No máximo 16 validações de Access **pendentes** no upgrade (acima disso, 503) | JWKS lento não acumula sockets abertos |
| E10 | O cookie `CF_Authorization` **não é aceito** pela origem; só o cabeçalho | Documentação: o cookie não tem garantia de chegar; uma única fonte de verdade |

### 10.3 Como o JWT chega à origem no handshake WebSocket

**Restrição:** a API `WebSocket` dos navegadores, inclusive o Safari no iPhone, **não permite** definir
cabeçalhos HTTP. A página **não envia** `Cf-Access-Jwt-Assertion`, e o servidor não presume que envie.

**Fluxo adotado (sem mudança no frontend):**
1. O convidado abre o link do convite. Sem sessão, o Access o leva ao login (navegação) e cria o cookie
   `CF_Authorization` no hostname da aplicação.
2. A página carrega. A requisição chega à origem com `Cf-Access-Jwt-Assertion`, que o servidor valida.
3. A página abre `wss://<hostname>/ws` (mesma origem). O **navegador** envia o cookie automaticamente no
   handshake; a **borda** valida a sessão e injeta `Cf-Access-Jwt-Assertion` no upgrade encaminhado; a **origem**
   valida o JWT antes de concluir o upgrade.

**Evidência:**
- [Informado pela documentação da Cloudflare] "When Cloudflare sends a request to your origin, the request will
  include an application token as a `Cf-Access-Jwt-Assertion` request header", e o cookie "is not guaranteed to
  be passed".
- [Não verificado] A documentação consultada **não trata especificamente** do upgrade WebSocket. Que a borda
  injete o cabeçalho também no upgrade é **[Inferido]** e precisa ser comprovado no teste real (critério 3 de §10.10).

**Alternativas se o teste real mostrar que o cabeçalho não chega no upgrade** (cada uma exige aprovação; nenhuma
foi implementada):

| Alternativa | Como | Prós | Contras |
|---|---|---|---|
| A. Validar também o cookie `CF_Authorization` no upgrade | Mesmo JWT, mesma validação criptográfica, lido do cookie só no upgrade | Sem mudança no frontend; segurança equivalente (o cookie contém o JWT assinado) | Documentação diz que o cookie não tem garantia de ser repassado |
| B. Ticket de sessão emitido pela origem | A página, já autenticada (JWT validado em HTTP), obtém um ticket curto e de uso único; o WebSocket o apresenta no protocolo (`Sec-WebSocket-Protocol`) ou na primeira mensagem | Independe do comportamento da borda no upgrade | Mudança arquitetural: novo endpoint, estado de tickets, mudança no frontend |
| C. Access service token | Cabeçalhos `CF-Access-Client-Id`/`Secret` | Para máquinas | **Inviável** em navegador (segredo no cliente) |

**Recomendação:** manter o fluxo adotado e comprová-lo no 02B.6. Se falhar, preferir **A** (mínima e com a
mesma garantia criptográfica); **B** só se A também falhar.

### 10.4 Configuração

| Variável | Valores | Padrão | Observação |
|---|---|---|---|
| `ORYN_ACCESS_MODE` | `required`, `off` | `off` | `off` com `ORYN_PUBLIC_HOSTNAMES` → **não inicia** |
| `ORYN_ACCESS_TEAM_DOMAIN` | `<equipe>.cloudflareaccess.com` | — | Obrigatório com `required`; define `iss` e a URL das chaves |
| `ORYN_ACCESS_AUD` | AUD tag (64 hex) | — | Obrigatório com `required` |
| `ORYN_ACCESS_JWKS_TIMEOUT_MS` | 100–30 000 | 3 000 | Inclui a leitura do corpo |
| `ORYN_ACCESS_JWKS_MAX_BYTES` | 1 KiB–1 MiB | 64 KiB | Declarado (`Content-Length`) e contado no fluxo |
| `ORYN_ACCESS_JWKS_CACHE_TTL_MS` | 10 s–24 h | 10 min | Validade do cache |
| `ORYN_ACCESS_JWKS_MAX_STALE_MS` | 0–24 h | 1 h | Uso de chaves em cache após falha de atualização |
| `ORYN_ACCESS_JWKS_COOLDOWN_MS` | 0–TTL | 30 s | Intervalo mínimo entre atualizações por `kid` desconhecido |
| `ORYN_ACCESS_CLOCK_TOLERANCE_S` | 0–300 | 30 | Tolerância para `exp`/`nbf` |

Nenhum valor é segredo; mesmo assim, valores reais não são versionados. Qualquer valor inválido impede a partida.
O banner mostra `Cloudflare Access (sinalização): OBRIGATÓRIO (equipe …)` ou `DESLIGADO (somente uso local)`.

### 10.5 Ciclo de vida do JWT

1. **Emissão** (borda): após o login, o Access cria a sessão (cookie). A duração é configurada na aplicação
   Access (padrão 24 h).
2. **Apresentação** (borda → origem): `Cf-Access-Jwt-Assertion` em cada requisição encaminhada.
3. **Validação** (origem), em toda requisição HTTP e todo upgrade do 5280:
   - formato compacto e até 8 KiB; cabeçalho repetido recusado;
   - `alg = RS256` e `kid` presente; sem `crit`;
   - chave pelo `kid`;
   - assinatura;
   - `iss` exato e `aud` contendo a AUD tag;
   - `exp` e `iat` obrigatórios; `nbf` quando presente; tolerância de 30 s.
4. **Uso:** só autoriza a requisição ou conexão; a identidade (e-mail, `sub`) **não** é registrada nem usada para
   autorização na origem. Quem pode entrar é decidido pela **política** do Access.
5. **Expiração:** nenhuma nova requisição ou conexão; conexões abertas são encerradas no heartbeat seguinte ao
   `exp` (até 10 s depois, com os padrões). Renovar exige navegação (recarregar a página).

### 10.6 Gerenciamento do JWKS

- **Origem:** URL `https` fixa, derivada; sem credenciais, consulta ou fragmento; `redirect: 'error'`;
  `credentials: 'omit'`.
- **Limites:** timeout total, tamanho declarado e real, até 20 chaves, `kid` único.
- **Validação das chaves:**
  - só RSA com `alg` RS256 ou ausente e `use` `sig` ou ausente; outras chaves são ignoradas;
  - material privado ou RSA inválida → o conjunto inteiro é recusado;
  - módulo mínimo de 2048 bits;
  - pelo menos uma chave utilizável.
- **Cache:**
  - 10 min de validade;
  - buscas simultâneas unificadas;
  - chaves já em cache continuam valendo por até 1 h se a atualização falhar;
  - um JWKS inválido nunca substitui um cache bom.
- **Rotação:**
  - [Informado pela documentação] o Access troca a chave a cada 6 semanas, e a anterior continua válida por 7 dias;
  - um `kid` desconhecido provoca **no máximo uma** atualização a cada 30 s (anti-amplificação);
  - um `kid` que continua desconhecido → recusa.
- **Indisponibilidade:** sem chaves utilizáveis → **503**. Após uma falha, novas tentativas esperam 2 s, sem
  martelar a origem das chaves.
- **Pré-carregamento** na partida. A falha é registrada, mas não impede a partida: as requisições falham fechadas
  até as chaves chegarem.

### 10.7 Comportamento fail-closed

| Situação | HTTP | Upgrade WebSocket |
|---|---|---|
| `Host` desconhecido (antes do Access) | 421 | 421 |
| `Origin` incoerente (antes do Access) | 403 | 403 |
| JWT ausente, malformado, repetido | 403 | 403 |
| Assinatura, `alg`, `kid`, `iss`, `aud`, `exp`, `nbf` inválidos | 403 | 403 |
| JWKS indisponível, lento, grande ou malformado | 503 | 503 |
| Validações pendentes acima do limite | — | 503 |
| JWT vence com a conexão aberta | — | Fechamento 1008 `access expired` |
| Hostname público sem Access; configuração do Access inválida | Servidor não inicia | Servidor não inicia |

Respostas de recusa não trazem conteúdo da página e não indicam o motivo ao cliente. O motivo vai ao log
(`access: missing|malformed|invalid|unavailable`), amostrado, sem JWT, e-mail ou `sub`.

### 10.8 Limitações do Safari e dos navegadores

- **Cabeçalhos no WebSocket:** impossíveis pela API; resolvido pelo fluxo de §10.3, com a ressalva [Não verificado].
- **Cookies:** o Access exige que "Bloquear todos os cookies" esteja desligado no Safari. O cookie é primário no
  hostname do túnel e não deve ser afetado pelo ITP, mas isso é **[Não verificado]** no iPhone.
- **Login:** só ocorre por navegação. Se a sessão vence, a reconexão automática do WebSocket falha (403) e o
  usuário precisa recarregar a página.
- **Fim da sessão Access durante a chamada:**
  - a sinalização é encerrada (E8), e a chamada termina como em qualquer queda de sinalização;
  - para voltar, o convidado precisa recarregar, logar e receber um **novo convite**;
  - mitigação: duração da sessão Access maior que a janela de teste.
- **Uso local com Access ligado:** a página em `localhost:5280` também exige JWT e, portanto, não funciona sem a
  borda (E5). O teste local usa o modo `off`, que é o padrão sem hostname público.

### 10.9 Testes [Observado, 22/10/2026, Windows, Node 24.19.0]

| Requisito | Onde | Casos |
|---|---|---|
| JWT válido; `aud` em lista ou string | `access.test.ts` | `expiresAt` = `exp` |
| Assinatura inválida | `access.test.ts`, `access-server.test.ts` | Chave do atacante com o mesmo `kid`; payload adulterado |
| Emissor e audiência incorretos | `access.test.ts`, `access-server.test.ts` | Outra equipe, barra final, outra AUD, sem `aud` |
| Expirado; `nbf` futuro; sem `exp`/`iat` | `access.test.ts`, `access-server.test.ts` | Limites da tolerância; tolerância 0 |
| Algoritmos e confusão | `access.test.ts` | `none` (assinatura vazia e falsa), HS256 com a chave pública como segredo, ES256 com `kid` publicado, RS512 com assinatura válida, `crit` |
| `kid` inexistente; sem `kid` | `access.test.ts` | Uma atualização no máximo; sem `kid` não busca chaves |
| JWKS: indisponível, HTTP 500/302/404, timeout (cabeçalhos e corpo), tamanho (declarado e em fluxo), malformado (9 variações) | `access.test.ts`, `access-server.test.ts` | Sempre `unavailable` → 503 |
| Rotação; cache; *stale*; recuo após falha; anti-amplificação; JWKS inválido não substitui o bom | `access.test.ts` | Contagem de buscas |
| Configuração | `access.test.ts`, `access-server.test.ts`, `cli-access.test.ts` | 11 inválidas na API; 9 casos no processo real (sem rede); hostname público sem Access não abre porta |
| HTTP sem autenticação | `access-server.test.ts` | 403 com `Host` público e local; token administrativo, `Authorization` e cookie não substituem |
| WebSocket sem autenticação | `access-server.test.ts` | 403 antes do upgrade; token inválido ou expirado; JWKS indisponível → 503 |
| `Host`/`Origin` preservados | `access-server.test.ts`, `public-access.test.ts` | JWT válido não compensa `Host` desconhecido (421) nem `Origin` incoerente (403); proxy simulado injeta o JWT como a borda |
| Operações administrativas pelo público | `access-server.test.ts` | `create`/`rejoin` com token administrativo + JWT → `unauthorized`; `/admin/pair` → 405 |
| Administrativo sem Access | `access-server.test.ts` | Página, pareamento e WebSocket sem JWT; `Host` público continua 421 |
| Convite e limites preservados | `access-server.test.ts` | Convite inválido recusado; prazo de admissão; teto de conexões; limite de pendentes |
| Prazo da sessão autenticada | `access-server.test.ts` | Conexão encerrada no `exp`; o token vencido não abre outra |
| Admissão e reentrada | `access-server.test.ts`, suíte existente, E2E | Convidado autenticado entra e reentra com novo convite; operador pelo 5281 |
| Logs | `access-server.test.ts` | Sem JWT, e-mail ou `sub` |
| Regressão WebRTC Chrome ↔ Edge | E2E (modo local, Access desligado) | Fluxo completo do 02B.2C |

**Resultados:** §10.12.

### 10.10 Critérios de aprovação e de exposição (substituem §9.8)

**Para aprovar o 02B.3A:**
1. Suíte, build, audit e E2E verdes localmente e no `POC-02B CI`.
2. Revisão do arquiteto das decisões E1–E10 e da estratégia de §10.3.

**Para expor (02B.6), além dos itens 2, 3, 4 e 6 a 10 de §9.8:**
1. Aplicação Access **self-hosted** cobrindo o hostname **inteiro** (todos os caminhos, inclusive `/ws`), com
   política por e-mails explícitos e duração de sessão maior que a janela de teste.
2. `ORYN_ACCESS_MODE=required`, `ORYN_ACCESS_TEAM_DOMAIN` e `ORYN_ACCESS_AUD` reais **só** no ambiente local
   (nunca no repositório), conferidos no banner.
3. **Comprovar no teste real**, antes de enviar o convite:
   - acesso direto sem login → página de login do Access, não a página da POC;
   - upgrade WebSocket autenticado funcionando no Chrome do PC e no Safari do iPhone, isto é, a borda injeta o
     JWT no upgrade;
   - logs do servidor sem recusas `access:` inesperadas.

   Se o upgrade falhar, parar e decidir entre as alternativas de §10.3.
4. TURN continua fora até o 02B.4.

### 10.11 Riscos residuais

| Risco | Severidade | Situação |
|---|---|---|
| Borda não injeta o JWT no upgrade WebSocket | **Alta para o uso** (a sinalização pelo túnel não funcionaria); não é risco de segurança, pois falha fechada | [Não verificado]. Critério 3 de §10.10; alternativas em §10.3 |
| Política do Access permissiva (ex.: qualquer e-mail) | Alta, se ocorrer | A origem só confere `iss`/`aud`; quem entra é decidido pela política. Critério 1 de §10.10. O convite continua exigido |
| Fim da sessão Access encerra a chamada em andamento | Média (experiência) | Duração da sessão maior que a janela de teste; novo convite para voltar |
| Confiança na borda e no endpoint de chaves da Cloudflare (TLS validado pelo Node com o repositório de CAs dele) | Baixa | Inerente ao Access; chave privada da Cloudflare fora do nosso controle |
| Tolerância de relógio de 30 s | Baixa | Configurável (0–300) |
| Custo de verificação RSA para tokens com `kid` válido e assinatura falsa | Baixa | Verificação RS256 é barata; tokens sem `kid` conhecido não buscam chaves; pendentes limitados |
| Dependência nova (`jose`) | Baixa | Versão exata, lockfile, `pnpm audit` sem vulnerabilidades; só no servidor (bundle do frontend inalterado: mesmo hash) |
| Encerramento da conexão no `exp` tem granularidade do heartbeat | Baixa | Até 10 s com os padrões |
| Modo `off` usado por engano com exposição | — | **Eliminado** para a configuração de exposição: hostname público sem Access não inicia |

### 10.12 Resultados [Observado, 22/10/2026]

| Verificação | Resultado |
|---|---|
| `pnpm install --frozen-lockfile` | OK (lockfile com `jose` 6.2.13) |
| `pnpm typecheck` | OK |
| `pnpm test` | **374/374**, 19 arquivos, nenhum pulado. Novos: `access` 55, `access-server` 21, `cli-access` 9. Ajustados: `public-access` (o proxy simulado injeta o JWT como a borda; `Host` local sem JWT → 403) e `admin-listener` (hostname público com Access) |
| Arquivos sensíveis a tempo (`access`, `access-server`, `abuse`, `public-access`, `admin-listener`) repetidos 3 vezes | 148/148 nas três |
| `pnpm build` | OK (JS 38,59 kB, 13,85 kB gzip; **mesmo hash do 02B.2C**: o frontend não mudou e `jose` não entra no bundle) |
| `pnpm audit` | Nenhuma vulnerabilidade conhecida |
| `pnpm e2e` | **41/41** em duas execuções, Chrome 155.0.8059.85 ↔ Edge 155.0.4283.62 (modo local, Access desligado): admissão, reentrada do operador e do convidado, áudio bidirecional |
| Rede pública nos testes | Nenhuma: JWKS por transporte em memória; chaves RSA/EC geradas a cada execução |

**Mutações:**

| Mutação | Testes que falharam |
|---|---|
| HTTP sem verificação do Access | 6 |
| Upgrade sem verificação do Access | 4 |
| Sem verificação de `iss` | 3 |
| Sem verificação de `aud` | 3 |
| `exp` não obrigatório | 1 |
| Tolerância de relógio enorme | 5 |
| `kid` desconhecido usa qualquer chave | 1 (detectada após acrescentar o teste "kid desconhecido assinado por chave publicada") |
| JWKS indisponível libera | 18 |
| Sem limite de tamanho do JWKS | 1 |
| Sem intervalo mínimo para `kid` desconhecido | 1 |
| Material privado aceito no JWKS | 2 |
| Hostname público sem Access permitido | 3 |
| Sem fechamento no `exp` | 1 |
| Access só para `Host` público | 2 |
| Chaves antigas sem limite após falha | 1 |
| Sem limite de validações pendentes | 1 (detectada após o teste passar a exigir recusa imediata) |
| Sem lista de algoritmos **ou** sem recusa antecipada de `alg` (isoladas e combinadas) | 0. **Mutação equivalente:** a chave é importada vinculada a RS256 (`importJWK(…, 'RS256')`), e a biblioteca recusa HS256, ES256, RS512 e `none` mesmo sem as duas checagens explícitas. Os testes negativos de algoritmo continuam passando por essa terceira camada. As checagens explícitas ficam como defesa em profundidade e evitam buscar chaves para algoritmos proibidos |

**CI:** workflow inalterado; os novos testes rodam nos jobs existentes. **[Não executado]** a execução no GitHub
depende do commit e do push do usuário.

## 11. Incremento 02B.3B — prontidão da infraestrutura Cloudflare (offline)

**Pré-condições verificadas [Observado]:**
- branch `poc/webrtc-audio-wan`, working tree limpa;
- HEAD `ed4d948` (02B.3A) igual a `origin/poc/webrtc-audio-wan`;
- `POC-02B CI` com **success** em push e pull_request para `ed4d948`, consultado pela API pública do GitHub;
- suíte local 374/374 antes das mudanças.

**Nada foi ativado:** sem túnel, sem DNS, sem aplicação Access, sem `cloudflared` instalado ou iniciado e sem porta
exposta. Os testes não usam rede pública.

O runbook operacional está em [`poc/webrtc-audio-wan/cloudflare/README.md`](../../poc/webrtc-audio-wan/cloudflare/README.md).

### 11.1 Arquitetura de integração

```text
 Navegador ─HTTPS/WSS─► Borda (Access: app self-hosted do hostname inteiro, política por e-mails)
                          │ injeta Cf-Access-Jwt-Assertion
                          ▼
                       cloudflared (túnel nomeado, local; access.required; Host preservado)
                          │ <HOSTNAME> → http://127.0.0.1:5280   ·   catch-all → http_status:404
                          ▼
                       Node :5280 (JWT + Host/Origin + convite + limites)      Node :5281: nunca no túnel
```

| Decisão | Motivo |
|---|---|
| F1. Túnel **nomeado e gerenciado localmente** | `config.yml` validável offline (pré-validação própria, `ingress validate`/`ingress rule`); sem token na linha de comando; suporta `originRequest.access` |
| F2. Túnel remoto (token) e Quick Tunnel **recusados** | Ingress no painel não é validável offline, e `--token` aparece em argumentos. Quick Tunnel não tem Access |
| F3. **JWT validado três vezes**: borda (login), `cloudflared` (`access.required`, `teamName`, `audTag`) e origem (02B.3A) | Defesa em profundidade; um erro de configuração numa camada não libera o acesso |
| F4. **Uma regra + catch-all 404**, sem `path` | O Access e o túnel cobrem o hostname inteiro, inclusive `/ws`; nenhum outro serviço |
| F5. **Sem `httpHostHeader`** | Preserva o `Host` público, coerente com o `Origin` `https://<HOSTNAME>` exigido pela origem |
| F6. `loglevel` só `info`/`warn`/`error`/`fatal` | [Informado pela documentação] em `debug`, o `cloudflared` registra todos os cabeçalhos, inclusive o JWT |
| F7. Cookies do Access: HttpOnly, SameSite **Lax**, Binding Cookie ligado | [Informado pela documentação] o padrão do SameSite é `None`; Lax basta para a navegação e para o WebSocket de mesma origem. O Binding Cookie impede o reuso de um cookie roubado. Efeito no WebSocket **[Não verificado]** (P6/P8) |
| F8. Configuração real e credenciais **fora do repositório**; `.gitignore` reforçado (`.cloudflared/`, `<UUID>.json`) | Nada secreto versionado, mesmo por engano |
| F9. Diagnóstico do handshake **sem JWT**: o servidor registra `[access] upgrade WebSocket autenticado (kid <8 caracteres>…, expira em N min)`; as recusas do Access indicam `http` ou `upgrade` | Permite comprovar a injeção do JWT no upgrade real sem registrar o token |
| F10. **Nenhum fallback por cookie** implementado | Depende de aprovação (§10.3) |

### 11.2 Arquivos versionados (só exemplos)

| Arquivo | Conteúdo |
|---|---|
| `cloudflare/config.example.yml` | Modelo do `config.yml` (UUID de zeros, `oryn-poc.example.com`, equipe `oryn-example`, AUD de zeros) |
| `cloudflare/server.env.example` | Modelo do ambiente do servidor (`ORYN_*`) com os mesmos valores de exemplo |
| `cloudflare/README.md` | Runbook: arquitetura, dependências do usuário, checklist, ativação, protocolo de teste real e rollback |
| `server/cloudflare-preflight.ts`, `server/preflight-cli.ts` | Pré-validação offline (`pnpm preflight:cloudflare`) |

Os valores de exemplo passam no modo `template` (estrutura) e são **recusados** no modo `activation`. Assim, os
modelos nunca podem ser ativados sem a troca dos valores.

### 11.3 Pré-validação offline

`pnpm preflight:cloudflare -- --config=<config.yml> --env-file=<arquivo>` (modo `activation` por padrão).

- **Entrada só por arquivos.** Argumentos desconhecidos (ex.: `--aud=…`, `--token=…`) são recusados com saída 2,
  para que nada sensível passe pela linha de comando ou pelo histórico.
- **Sem rede**, sem iniciar nada. Saída 0 = OK; 1 = violação.
- **Nunca imprime segredos:**
  - o segredo do túnel só tem presença e coerência conferidas;
  - a AUD aparece mascarada (`4f2a9c…(64)`);
  - mensagens citam a regra violada, não o conteúdo.
- **Regras:**

| Código | Recusa |
|---|---|
| `PORTS` | Portas de sinalização e administrativa iguais |
| `ENV_HOSTNAMES`, `ENV_PLACEHOLDER` | Hostname ausente, múltiplo, inválido, de exemplo, reservado (`.example`, `.test`, `.invalid`, `.local`…) ou `trycloudflare.com` |
| `ENV_ACCESS_MODE`, `ENV_ACCESS` | Access diferente de `required`; equipe/AUD/opcionais inválidos (mesma validação do servidor) |
| `ENV_UNKNOWN`, `ENV_FILE` | Variáveis `ORYN_*` desconhecidas; arquivo de ambiente real versionado ou não ignorado |
| `CFG_PARSE`, `CFG_ALIAS`, `CFG_KEYS` | YAML inválido ou com chaves duplicadas; âncoras e aliases; chaves de topo fora da lista |
| `CFG_TOKEN`, `CFG_WARP`, `CFG_LEGACY`, `CFG_QUICK_TUNNEL`, `CFG_TUNNEL` | Token (túnel remoto), `warp-routing`, modos legados (`url`, `hello-world`, `bastion`), Quick Tunnel, ausência de UUID |
| `CFG_CREDENTIALS`, `CFG_FILE`, `CFG_PLACEHOLDER` | Credenciais relativas, dentro do repositório, ilegíveis, sem segredo ou de outro túnel; `config.yml` real versionado; UUID de exemplo |
| `CFG_INGRESS`, `CFG_RULE`, `CFG_HOSTNAME`, `CFG_SERVICE`, `CFG_CATCHALL` | Ingress diferente de [hostname → `http://127.0.0.1:5280`, `http_status:404`]; `path`; curinga; hostname divergente do ambiente |
| `CFG_ADMIN_PORT`, `CFG_SERVICE_TYPE` | Porta 5281 em **qualquer** campo; serviços ssh/rdp/tcp/unix/bastion/hello_world |
| `CFG_HOST_HEADER`, `CFG_ORIGIN_REQUEST`, `CFG_ACCESS` | `httpHostHeader`; `noTLSVerify`, `proxyType` e outros fora da lista; `access` ausente, não obrigatório, com equipe diferente ou AUD diferente/extra |
| `CFG_LOGLEVEL`, `CFG_METRICS` | `debug`/`trace`; métricas fora do loopback |

**Limites:**
- a pré-validação não substitui `cloudflared tunnel ingress validate` (T4), porque não conhece todas as regras do
  `cloudflared`;
- ela não enxerga o painel da Cloudflare (aplicação Access, política, DNS). Por isso esses itens têm checklist
  manual com evidência (runbook §4.1).

### 11.4 Fronteira de confiança: casos e evidência offline

O `tests/helpers/tunnel.ts` simula a borda e o `cloudflared` com um proxy local: destino, `Host` preservado ou
reescrito, JWT injetado ou não e cabeçalhos extras.

| Caso | Resultado | Onde |
|---|---|---|
| Túnel apontado para 5281 com `Host` público | 421 em HTTP, WebSocket e `/admin/pair` | `trust-boundary`, `public-access` |
| Túnel para 5281 com `Host` reescrito para `localhost` | O `Origin` do navegador (`https://<HOSTNAME>`) é recusado (403); o pareamento também; o código não é consumido | `trust-boundary` |
| `Host` reescrito para `localhost:5280` | Navegador recusado (403); `/admin/pair` → 405 | `trust-boundary`, `public-access` |
| Hostname desconhecido (mesmo com JWT válido) | 421 | `trust-boundary` |
| `Origin` incompatível | 403 | `trust-boundary`, `access-server` |
| JWT ausente, expirado, outra chave, outra AUD, outra equipe | 403 em HTTP e WebSocket | `trust-boundary`, `access-server`, `access` |
| Cabeçalhos de proxy e de "autorização" forjados (`X-Forwarded-Host`, `Forwarded`, `X-Original-Host`, `X-Real-IP`, `Authorization: Bearer <token administrativo>`, cookie `CF_Authorization`, `X-Oryn-Admin`) | 403 | `trust-boundary` |
| WebSocket não autenticado | 403 antes do upgrade | `trust-boundary`, `access-server` |
| Convite inválido ou reutilizado pelo túnel autenticado | `invite-invalid` | `trust-boundary` |
| **Matriz** destino {5280, 5281} × `Host` {público, `localhost`, `127.0.0.1`, porta trocada} × JWT {válido, ausente} × `Origin` {público, local}: 32 combinações | Nenhuma autoriza `create` sem token administrativo; toda recusa é 403/421 (não 503) | `trust-boundary` |
| Token administrativo **vazado** | Só uma combinação o aceitaria: túnel para 5281 + `Host` reescrito + `Origin` local, que um navegador nunca envia pelo hostname. Essa configuração é recusada pela pré-validação (`CFG_SERVICE`, `CFG_ADMIN_PORT`, `CFG_HOST_HEADER`) | `trust-boundary` |

### 11.5 Compatibilidade com WebSocket

- [Informado pela documentação]:
  - a Cloudflare suporta WebSockets via proxy em todos os planos; o 101 inicial passa pelo WAF;
  - o Tunnel encaminha WebSockets;
  - toda requisição encaminhada à origem leva `Cf-Access-Jwt-Assertion`.
- [Não verificado] a injeção do cabeçalho no **upgrade** real. O protocolo do runbook §6 (P5–P8) verifica isso no
  Chrome e no Safari do iPhone pela linha `[access] upgrade WebSocket autenticado (kid …)`, sem registrar o JWT.
  Se aparecer `access (upgrade): missing`, o teste é **interrompido** para decisão (§10.3), e nenhum fallback é
  implementado sem aprovação.

### 11.6 Testes [Observado, 22/10/2026]

| Verificação | Resultado |
|---|---|
| `pnpm install --frozen-lockfile` | OK (`yaml` 2.9.1 como devDependency exata, só para a pré-validação) |
| `pnpm typecheck` | OK |
| `pnpm test` | **442/442**, 21 arquivos. Novos: `cloudflare-preflight` 59, `trust-boundary` 9. `public-access` usa o túnel simulado compartilhado. `access`/`access-server` cobrem as novas linhas de diagnóstico |
| Arquivos de fronteira (`trust-boundary`, `cloudflare-preflight`, `access-server`, `public-access`, `abuse`) repetidos 3 vezes | 130/130 nas três |
| `pnpm build` | OK; bundle com o **mesmo hash** (frontend inalterado) |
| `pnpm audit` | Nenhuma vulnerabilidade conhecida |
| `pnpm e2e` | **41/41** em duas execuções, Chrome 155.0.8059.85 ↔ Edge 155.0.4283.62 (modo local; funcionamento local preservado) |
| Modelos versionados | `template` → OK (saída 0); `activation` → 7 violações (saída 1) |

### 11.7 Riscos residuais

| Risco | Severidade | Situação |
|---|---|---|
| Borda não injeta o JWT no upgrade (ou o Binding Cookie interfere) | Alta para o uso; falha fechada | [Não verificado]; P6–P8 do protocolo; decisão em §10.3 |
| Configuração no painel (aplicação, política, cookies, DNS) fora da validação automática | Média | Checklist A1–A7 e T7 com evidência (prints); política por e-mails explícitos |
| Sintaxe exata dos comandos `cloudflared` (`ingress validate/rule`, `run`) | Baixa | [Inferido] da documentação; nenhum comando foi executado aqui. Conferir com `cloudflared --help` na versão instalada |
| Credenciais do túnel (`<UUID>.json`) e `cert.pem` no PC do usuário | Média, se vazarem | Fora do repositório, `.gitignore` reforçado, pré-validação, rollback R5 |
| Logs do `cloudflared` | Baixa | `loglevel` restrito pela pré-validação; busca por `eyJ` no protocolo (P11) |
| Token administrativo vazado + túnel mal configurado para 5281 com reescrita | Baixa | Exigiria duas falhas e um cliente fora do navegador; a configuração é recusada pela pré-validação |
| Nova dependência de desenvolvimento (`yaml`) | Baixa | Versão exata, lockfile, `pnpm audit`; não entra no servidor em produção nem no bundle |

### 11.8 Critérios de ativação e de rollback

**Ativação (02B.6), todos obrigatórios:**
1. 02B.3B aprovado; `POC-02B CI` verde com este código.
2. Aprovação explícita do arquiteto para a janela de ativação, que inclui T1, T2 e T7, criação de DNS público.
3. Checklist do runbook §4 completo, com evidências.
4. `pnpm preflight:cloudflare` (modo `activation`) com saída 0 sobre os arquivos reais.
5. `cloudflared tunnel ingress validate` OK e `ingress rule` conferindo T5 e T6.
6. Banner do servidor: hostname correto e `Cloudflare Access (sinalização): OBRIGATÓRIO`.
7. Protocolo P1–P4 aprovado **antes** de enviar qualquer convite; P5–P12 em seguida.
8. Critérios de §9.8 e §10.10 continuam valendo; TURN fora até o 02B.4.

**Rollback:** gatilhos e passos R1–R6 do runbook §7. R1 (Ctrl+C no `cloudflared`) encerra a exposição
imediatamente.

### 11.9 Resultados das execuções repetidas e mutações

**Mutações na pré-validação (todas detectadas; código restaurado após cada uma):**

| Mutação | Testes que falharam |
|---|---|
| Porta administrativa não detectada | 4 |
| Catch-all não verificado | 4 |
| `httpHostHeader` permitido | 3 |
| `access` do `cloudflared` opcional | 2 |
| AUD do `cloudflared` não conferida | 2 |
| `loglevel` `debug`/`trace` permitido | 2 |
| Credenciais dentro do repositório aceitas | 1 (detectada após isolar o teste da regra de leitura) |
| Serviço não conferido | 5 |
| Hostname da regra não conferido com o ambiente | 1 |
| Valores de exemplo aceitos na ativação | 3 |
| Access desligado aceito | 2 |
| `path` na regra aceito | 1 |
| Métricas em qualquer interface | 1 |
| Token (túnel remoto) aceito | 1 |

**CI:** workflow inalterado; os novos testes rodam nos jobs existentes. **[Não executado]** a execução no GitHub
depende do commit e do push do usuário.

## 12. Incremento 02B.4 — integração STUN/TURN

**Pré-condições verificadas [Observado]:**
- branch `poc/webrtc-audio-wan`, working tree limpa;
- HEAD `44c82e4` igual a `origin`;
- `POC-02B CI` com sucesso (pull_request) em `44c82e4`;
- PR #4 aberto e em Draft.

Antes disso, o 02B.4 foi interrompido uma vez porque o working tree não estava limpo: o `.gitignore` do 02B.3B
tinha ficado fora de `4b765fe`. O usuário corrigiu isso em `44c82e4`.

**Escopo:** local e automatizado. **Nenhum** serviço real foi usado: sem conta TURN, sem chamada à API da
Cloudflare, sem túnel, sem teste WAN e sem porta exposta.

### 12.1 Arquitetura

```text
 Navegador (admitido)                         Servidor Node                            Provedor TURN
   │ ice-request {mode}  ── WSS (Access + convite / 5281 + pareamento) ──►  IceBroker ── Bearer <token> ──► API (somente servidor)
   │ ◄── ice-config {iceServers, expiresAt}  (credenciais TEMPORÁRIAS desta conexão)   ◄── iceServers ────┘
   │
   └─ RTCPeerConnection(config do modo) ══ mídia ══► direto (host/srflx/prflx)  ou  servidor TURN (relay: udp/tcp/tls)
```

| # | Decisão | Motivo |
|---|---|---|
| T1 | A configuração ICE trafega pela **sinalização**, só para conexões **admitidas** (convite no 5280 com Access; pareamento no 5281). Nada no bundle, nenhum endpoint HTTP novo | Reaproveita toda a cadeia de autenticação existente; nenhuma credencial embarcada |
| T2 | O **modo** é escolhido por participante (seletor na página) e validado pelo protocolo. O servidor só chama o provedor para os modos que usam TURN | `direct` não consome credenciais; cada lado testa seu caminho |
| T3 | O cliente monta a `RTCConfiguration` com filtros fechados. `relay` e `relay-tls` **falham fechados** antes de criar a `RTCPeerConnection` | Sem fallback silencioso para UDP ou candidatos diretos |
| T4 | `auto` sem TURN (provedor desligado ou indisponível) **prossegue de forma visível**: aviso no log e resumo "TURN indisponível" | Preserva o uso local e na LAN. **Decisão do arquiteto:** se `auto` deve falhar quando o provedor falhar |
| T5 | Credencial **por conexão**, com limites: intervalo mínimo de 10 s, 3 por conexão, uma emissão em andamento por conexão e 4 chamadas simultâneas ao provedor | Frequência e custo controlados; evita reuso entre sessões |
| T6 | **Revogação** na saída da sessão, na desconexão e no desligamento. Uma credencial emitida para uma conexão que saiu durante a chamada ao provedor **não é entregue** e é revogada | Credenciais não sobrevivem ao participante |
| T7 | Validade padrão de **2 h** (configurável de 600 s a 86 400 s). Renovação **antes de um novo par** quando faltam menos de 5 min | Ver §12.4 sobre a expiração durante a chamada |
| T8 | Adaptador Cloudflare implementado **pela documentação oficial**, sem exercício contra a API real (§12.5) | O requisito proíbe configurar serviços reais |
| T9 | O caminho de mídia é declarado **somente** a partir do par ICE **selecionado** (`succeeded`). "TURN configurado" aparece como configuração, com o aviso "não implica uso" | Não inferir relay pela configuração |
| T10 | Estatísticas por **listas fechadas**: tipos de candidato, transportes, `relayProtocol` e estado do par. Nada de endereço, porta, URL ou fundação | Sanitização por construção |

### 12.2 Modos ICE

| Modo | Servidores | `iceTransportPolicy` | Sem servidor adequado |
|---|---|---|---|
| `auto` | STUN + TURN (udp, tcp, tls) | `all` | Prossegue sem STUN/TURN, **visível** (T4) |
| `direct` | Somente STUN | `all` | Prossegue sem STUN (só candidatos host). **Não garante** conectividade direta entre quaisquer redes (NAT simétrico, CGNAT, firewall) |
| `relay` | Somente TURN (`turn:` e `turns:`), com credenciais | `relay` | **Falha fechada**, sem `RTCPeerConnection` |
| `relay-tls` | Somente `turns:` sobre TCP (`?transport=tcp` ou sem transporte); nunca `turn:` nem `turns:` com `transport=udp` | `relay` | **Falha fechada**, sem `RTCPeerConnection` |

**`relay-tls` ≠ UDP bloqueado.** Um par relay com `relayProtocol = tls` prova que a mídia passou pelo TURN sobre
TLS. Não prova que UDP esteja bloqueado na rede: isso exige um teste de rede próprio (§6, item 7).

URLs aceitas: `stun:`, `turn:` e `turns:`, com host DNS ou IPv4, porta opcional e `?transport=udp|tcp` só em TURN.
A **porta 53 é recusada** em todo lugar: [Informado pela documentação da Cloudflare] ela é bloqueada pelos
navegadores e só causaria espera.

### 12.3 Fluxo de emissão das credenciais

1. A conexão é **admitida**: convidado com convite de uso único pelo 5280 (Access obrigatório quando exposto) ou
   operador pareado no 5281.
2. O cliente envia `ice-request {mode}`.
3. O servidor confere a admissão. Conexão não admitida → `unauthorized`, contada como falha de autorização (3
   encerram a conexão), **sem chamar o provedor**.
4. `direct`, ou ausência de provedor: STUN local (se configurado), sem credencial. `relay`/`relay-tls` sem provedor
   → `turn-unavailable`.
5. Limites (T5) excedidos → `ice-limit`.
6. Chamada ao provedor com validade configurada. Falha, timeout ou resposta inválida → `turn-unavailable`.
   **Nunca** credenciais fictícias.
7. A conexão saiu enquanto o provedor respondia → a credencial é **revogada e não entregue**.
8. `ice-config {mode, iceServers, expiresAt}` só para esta conexão. O cliente guarda em **memória**; nada de
   `localStorage` ou arquivo, e nada no log (só o resumo "STUN n · TURN n (tipos)").
9. Saída da sessão, desconexão ou desligamento → revogação (melhor esforço; falha registrada sem identificadores).

**Segredos:**
- o token administrativo do provedor (`ORYN_TURN_API_TOKEN`) existe só no servidor, lido do arquivo de ambiente;
- nunca é impresso (banner, pré-validação), registrado ou enviado;
- a pré-validação confere o formato sem exibi-lo;
- argumentos com valores sensíveis continuam recusados.

### 12.4 Expiração durante a chamada

- A expiração **não** é tratada como encerramento imediato.
- [Inferido, RFC 8656] Uma alocação TURN existente continua até o seu tempo de vida. As renovações (Refresh) da
  alocação usam a credencial de longo prazo. Depois do vencimento da credencial, uma renovação pode ser recusada,
  e a mídia por relay pode cair quando a alocação expirar.
- [Não verificado] Se a revogação na Cloudflare encerra alocações ativas. Por isso a revogação só é feita depois
  que a conexão do participante termina.
- **Comportamento definido:**
  - a validade padrão (2 h) deve superar a duração do teste;
  - um **novo par** (reentrada, novo convidado) renova a configuração antes de criar a `RTCPeerConnection` se faltam
    menos de 5 min;
  - não há renovação no meio da chamada nem ICE restart (decisão pendente, §6 item 5);
  - se o relay cair por vencimento, a chamada termina como qualquer falha de conexão, com mensagem clara, e a
    reentrada emite credenciais novas.

### 12.5 Contrato do adaptador TURN

```ts
interface TurnProvider {
  readonly name: string;                           // para logs
  issue(ttlSec: number): Promise<TurnIssue>;       // rejeita em falha/timeout; nunca devolve credencial fictícia
  revoke(username: string): Promise<void>;         // melhor esforço
}
interface TurnIssue { iceServers: IceServerConfig[]; username: string; expiresAt: number }
```

**Implementações:**
- **`SimulatedTurnProvider`:** testes e E2E; nenhuma rede.
- **`CloudflareTurnProvider`:** [Informado pela documentação da Cloudflare Realtime TURN, consultada nesta etapa].
  - Emissão: `POST https://rtc.live.cloudflare.com/v1/turn/keys/<KEY_ID>/credentials/generate-ice-servers`, com
    `Authorization: Bearer <token>` e corpo `{"ttl": <s>}`; resposta `201` com `iceServers`.
  - Revogação: `POST …/credentials/<username>/revoke` → `204`.
  - Timeout de 5 s; resposta de até 32 KiB; sem redirecionamentos.
  - Hosts aceitos: `stun.cloudflare.com` e `turn.cloudflare.com`. Outro host → descartado, e falha fechada se não
    sobrar TURN.
  - URLs da porta 53 removidas.
  - **Não exercitado contra a API real.**

**Configuração (servidor):**
- `ORYN_TURN_PROVIDER=cloudflare|off` (padrão `off`), `ORYN_TURN_KEY_ID`, `ORYN_TURN_API_TOKEN` (segredo),
  `ORYN_TURN_TTL_S`, `ORYN_ICE_STUN_URLS`;
- configuração inválida ou ambígua impede a partida;
- o banner mostra o provedor e a validade, nunca o token.

### 12.6 Estatísticas e critérios de comprovação

Exibidas na página e registradas no log sem endereços: tipo dos candidatos local e remoto (host, srflx, prflx,
relay), transporte, `relayProtocol`, estado do par, RTT (RTCP ou ICE), pacotes enviados e recebidos, perda (local e
do outro lado), jitter, `iceConnectionState` e suas mudanças, além de cada **mudança do par selecionado**.

| Afirmação | Evidência exigida |
|---|---|
| "Usou relay" | Par **selecionado** (`succeeded`) com candidato local **ou** remoto `relay`, nos stats daquele lado |
| "Usou TURN sobre TLS" | No lado em `relay-tls`: candidato **local** `relay` com `relayProtocol = tls` no par selecionado |
| "Conectou direto" | Par selecionado sem `relay` dos dois lados |
| "TURN configurado" | **Não** é evidência de uso. Aparece como "TURN configurado (não implica uso)" |
| "UDP bloqueado" | **Fora do alcance** destes stats; exige método de bloqueio próprio |

Registro recomendado, sem IPs: print da tabela de métricas e linhas do log "Par ICE selecionado: … → caminho …".

### 12.7 Testes [Observado, 22/10/2026]

| Requisito | Onde | Casos |
|---|---|---|
| Seleção de cada modo | `ice.test.ts`, `call-ice.test.ts` | `RTCConfiguration` exata por modo, inclusive políticas |
| Falha fechada: relay sem TURN, relay-tls sem TURNS | `ice.test.ts` (7 variações), `call-ice.test.ts`, E2E | Nenhuma `RTCPeerConnection` criada; mensagem clara |
| Ausência de fallback | `ice.test.ts`, `call-ice.test.ts`, E2E | relay nunca recebe STUN; relay-tls nunca recebe `turn:`/UDP. **E2E:** TURN inalcançável em relay → nenhum candidato host/srflx, nenhum par, nenhuma conexão |
| Emissão só após admissão | `ice-server.test.ts`, `call-ice.test.ts` | Pedido só depois de `session`; não admitido → `unauthorized`, provedor não chamado, 3 tentativas encerram; convite inválido não abre caminho |
| Falhas, timeout e indisponibilidade do provedor | `turn.test.ts`, `call-ice.test.ts` | Rede, 401, 500, 302, JSON inválido, sem `iceServers`, sem credencial, resposta grande, timeout, host não documentado |
| Expiração e renovação | `call-ice.test.ts` | Credencial a menos de 5 min do fim → nova configuração antes do novo par |
| Concorrência e limites | `turn.test.ts`, `ice-server.test.ts` | Pedidos simultâneos da mesma conexão (1 emite); intervalo; máximo por conexão; limite global |
| Segredos fora dos logs | `turn.test.ts`, `ice-server.test.ts`, `call-ice.test.ts`, `cli-access.test.ts`, `cloudflare-preflight.test.ts`, E2E | username, credential, URLs TURN e token ausentes de logs, banner e relatório |
| Sanitização das estatísticas | `ice.test.ts`, `call-ice.test.ts` | Valores fora das listas → `null`; nenhum IP, porta ou URL; caminho indeterminado sem par `succeeded` |
| Limpeza | `turn.test.ts`, `ice-server.test.ts`, `call-ice.test.ts`, E2E | Revogação na saída, na desconexão e no desligamento; não entrega a quem saiu; timers zerados ao encerrar |
| Regressão Access + convite | `ice-server.test.ts`, suíte existente, E2E | Convidado autenticado (túnel simulado com JWT) recebe credenciais; sem JWT nem conecta |
| Protocolo | `ice.test.ts` | `ice-request` e `ice-config` estritos: porta 53, esquemas, credencial em STUN, chaves extras, limites |
| Configuração (CLI e pré-validação) | `cli-access.test.ts`, `cloudflare-preflight.test.ts` | Provedor desconhecido, credenciais com `off`, token/ID inválidos, validade, STUN inválido |

**Resultados:**

| Verificação | Resultado |
|---|---|
| `pnpm install --frozen-lockfile` | OK (nenhuma dependência nova) |
| `pnpm typecheck` | OK |
| `pnpm test` | **547/547**, 25 arquivos. Novos: `ice` 43, `turn` 24, `ice-server` 11, `call-ice` 15. Ampliados: `cli-access` (+8), `cloudflare-preflight` (+4), `stats` e `signaling-client` (campo `relayProtocol`) |
| Arquivos de ICE e fronteira repetidos 3 vezes | 92/92 nas três |
| `pnpm build` | OK (JS 44,79 kB, 15,81 kB gzip). O bundle não contém o endpoint da API TURN nem credenciais |
| `pnpm audit` | Nenhuma vulnerabilidade conhecida |
| `pnpm e2e` | **51/51** em três execuções finais, Chrome 155.0.8059.85 ↔ Edge 155.0.4283.62: as 41 verificações anteriores mais 10 de modos ICE |

**E2E dos modos ICE [Observado]:**
- relay-tls sem TURN no servidor → falha fechada, nenhuma `RTCPeerConnection`;
- auto (TURN simulado inalcançável) com direct → conectam com par `host ↔ host`, caminho "direto". A página mostra
  "TURN configurado (não implica uso)";
- relay com TURN inalcançável → `RTCPeerConnection` com política `relay`, nenhum candidato host/srflx, nenhum par
  selecionado e nenhuma conexão. O primeiro lado a vencer o prazo de 20 s falha e o outro volta a aguardar;
- credenciais simuladas ausentes de páginas, consoles e logs, e revogadas ao fim.

**Defeito de teste encontrado e corrigido no E2E:** trocar só o fragmento (`#i=`) não recarrega a página, e o
cenário seguinte herdava o log e o estado do anterior. O E2E agora abre uma página nova por cenário e espera o
convite **novo** do operador.

**Mutações (todas detectadas; código restaurado após cada uma):**

| Mutação | Falhas |
|---|---|
| relay sem TURN aceito | 5 |
| relay recebe STUN (fallback) | 2 |
| relay-tls aceita `turn:`/UDP | 5 |
| relay com política `all` | 2 |
| direct recebe TURN | 2 |
| Porta 53 aceita | 4 |
| Emissão sem admissão | 2 |
| Sem intervalo mínimo | 2 |
| Sem trava de emissão em andamento | 1 |
| Sem revogação no release | 5 |
| Entrega a quem já saiu | 1 |
| Sem release ao desconectar | 2 |
| Credencial fictícia em falha do provedor | 1 |
| Hosts não documentados aceitos | 1 |
| Sem renovação perto do vencimento | 1 |
| Caminho inferido pela configuração | 1 |
| Estatísticas sem lista fechada | 2 |
| Credencial aceita em servidor só STUN | 1 |

**CI:** workflow inalterado; os novos testes e o E2E ampliado rodam nos jobs existentes. **[Não executado]** a
execução no GitHub depende do commit e do push do usuário.

### 12.8 Limitações da validação local

- **Nenhum servidor TURN real**, então relay e relay-tls **não foram comprovados**. O E2E prova só a falha fechada,
  a ausência de fallback e que "TURN configurado" não vira "relay" quando o par selecionado é direto.
- O **cliente Cloudflare** foi testado contra respostas simuladas no formato documentado, nunca contra a API real.
  Códigos de status e campos podem divergir; nesse caso, ele falha fechado.
- **Safari/iPhone, CGNAT, 4G/5G e UDP bloqueado** não foram testados.
- O E2E Chrome ↔ Edge roda no mesmo PC (par host ↔ host).

### 12.9 Riscos residuais

| Risco | Severidade | Situação |
|---|---|---|
| Relay e TURN/TLS ainda não comprovados em rede real | Alta para o objetivo da POC | Plano de §12.10; critério da próxima etapa |
| Divergência entre a documentação e a API real da Cloudflare | Média | Falha fechada (`turn-unavailable`); teste real controlado antes de expor |
| Credencial TURN no navegador (inerente ao WebRTC): quem tiver acesso à página pode usar o relay até o fim da validade | Média | Só para admitidos; por conexão; validade limitada; revogação na saída; limites de emissão |
| Queda do relay quando a credencial vence numa chamada longa | Média | Validade de 2 h maior que o teste; sem renovação no meio da chamada (§12.4) |
| `auto` sem TURN prossegue (T4) | Baixa | Visível na página e no log; decisão do arquiteto |
| Custo/franquia do TURN | Baixa | Limites de emissão; revogação; [Informado no planejamento] 1.000 GB/mês grátis e depois US$ 0,05/GB |
| Revogação pode não encerrar alocações ativas | Baixa | [Não verificado]; revogação só após o fim da conexão |
| Token da API TURN no PC do operador | Média, se vazar | Só em arquivo de ambiente fora do repositório; nunca impresso; pré-validação |

### 12.10 Plano de testes reais (02B.8, depois da exposição aprovada)

**Pré-requisitos:**
- 02B.6 ativo, com Access comprovado no WebSocket (§10.10, §11.8);
- chave TURN criada pelo usuário: `ORYN_TURN_PROVIDER=cloudflare`, ID e token **só** no arquivo de ambiente fora do
  repositório; pré-validação OK; banner com "TURN: cloudflare".

| # | Cenário (matriz §5) | Modo | Evidência de aprovação |
|---|---|---|---|
| R1 | Windows Wi-Fi ↔ iPhone 4G/5G (teste 2) | `auto` nos dois | Áudio nos dois sentidos; par selecionado registrado nos dois lados (tipo e `relayProtocol`) |
| R2 | Tentativa direta (teste 3) | `direct` nos dois | Estado ICE final e pares; sucesso ou falha registrados (falha não reprova) |
| R3 | TURN forçado (teste 4) | `relay` no iPhone (e no PC) | Par selecionado **relay** nos stats do lado em `relay`; áudio nos dois sentidos |
| R4 | TURN/TLS (teste 5) | `relay-tls` no iPhone | Candidato local **relay** com `relayProtocol = tls` no par selecionado; **não** declarar UDP bloqueado sem método próprio |
| R5 | Encerramento (teste 7) | qualquer | Log do servidor: "credencial revogada"; nenhuma credencial em logs (buscar `username`/`credential`) |
| R6 | Falha fechada real | `relay` com `ORYN_TURN_PROVIDER=off` | Erro "TURN indisponível"; nenhuma conexão |

### 12.11 Critérios para a próxima etapa

1. 02B.4 aprovado e `POC-02B CI` verde com este código.
2. Decisão do arquiteto sobre T4 (`auto` sem TURN) e sobre a validade padrão das credenciais.
3. Exposição (02B.6) com os critérios de §9.8, §10.10 e §11.8, mais a configuração TURN real validada pela
   pré-validação.
4. Execução de R1–R6 com evidências do **par selecionado**. Só então declarar relay ou relay-tls comprovados.
