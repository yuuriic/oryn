# POC-02B — Validação: áudio WebRTC bidirecional entre redes distintas

| Campo | Valor |
|---|---|
| Branch | `poc/webrtc-audio-wan`, criada a partir de `main` em `f068509` (PR #3 da POC-02A) |
| Código | `poc/webrtc-audio-wan/` |
| Relação com o ARCHITECTURE.md | P02 (§14): travessia de NAT, CGNAT, TURN e UDP bloqueado; credenciais TURN temporárias (§9.1) |
| Incremento atual | **02B.2C — hardening da sinalização WAN** (§9) |
| Status | **02B.1 e 02B.2A aprovados. 02B.2B e 02B.2C aguardando revisão do arquiteto.** Exposição pública **proibida** até a aprovação e o cumprimento dos critérios de §9.8 |

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
| **02B.2C** | Listener administrativo separado, pareamento do operador por código de uso único, análise do Cloudflare Access | **Concluído; em revisão** (§9) |
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
