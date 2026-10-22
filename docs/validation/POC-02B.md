# POC-02B — Validação: áudio WebRTC bidirecional entre redes distintas

| Campo | Valor |
|---|---|
| Branch | `poc/webrtc-audio-wan`, criada a partir de `main` em `f068509` (PR #3 da POC-02A) |
| Código | `poc/webrtc-audio-wan/` |
| Relação com o ARCHITECTURE.md | P02 (§14): travessia de NAT, CGNAT, TURN e UDP bloqueado; credenciais TURN temporárias (§9.1) |
| Incremento atual | **02B.1 — preparação e isolamento** (baseline copiado da POC-02A, sem funcionalidade nova) |
| Status | **02B.1 aguardando revisão do arquiteto.** Nenhum incremento funcional iniciado |

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

**Decisão arquitetural aprovada (provisória):**
- Node.js para a sinalização, exposto por **Cloudflare Tunnel** com certificado publicamente confiável;
- **Cloudflare TURN gerenciado**, sujeito à validação de disponibilidade e custos;
- **sem Supabase nesta POC**.

**Fora do escopo:** Supabase, autenticação definitiva, SFU, Android, produção, e reuso da CA local da POC-02A na
internet.

### Incrementos

| Incremento | Conteúdo | Situação |
|---|---|---|
| **02B.1** | Cópia isolada da POC-02A, baseline de testes, este documento | **Concluído; em revisão** |
| 02B.2 | Configuração por ambiente (falha fechada) e `Host`/`Origin` para o hostname público | Não iniciado |
| 02B.3 | Admissão e controle de abuso: criação só pelo operador, convite de uso único, tetos, expiração (A2, A8) | Não iniciado |
| 02B.4 | Credenciais TURN emitidas no servidor (TTL, revogação, provedor simulado nos testes) | Não iniciado |
| 02B.5 | Cliente: `iceServers`, modos `auto`/`direto`/`relay`/`relay-tls`, estados `disconnected`/`failed` (A6), métricas de relay | Não iniciado |
| 02B.6 | Exposição via Cloudflare Tunnel (runbook) | Não iniciado |
| 02B.7 | CI da POC-02B sem segredos; E2E opcional com TURN real em ambiente local | Não iniciado |
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
- **O modo HTTPS da LAN com CA local continua no código herdado** (`server/certs*.ts`, `server/share-ca.ts`, opção
  `https` do servidor). Não deve ser usado na internet; sua remoção ou substituição é decisão pendente (§6).
- **Achados da auditoria mantidos como dívida técnica** (POC-02A §13.5): A2 (sem limite de conexões por cliente),
  A4 (ID de sessão como única credencial), A5 a A8, A9 e A10. Os incrementos 02B.3 e 02B.5 tratam A2, A6 e A8, por
  serem pré-requisitos para exposição pública.
- **Sem CI:** o workflow `poc-02a-ci.yml` só cobre `poc/webrtc-audio-lan/**`. A POC-02B ainda não tem CI (02B.7).

## 4. Riscos

| Risco | Severidade | Situação |
|---|---|---|
| Expor o servidor herdado na internet antes de 02B.2/02B.3 (sem admissão nem tetos; A2 confirmado na auditoria) | **Alta, se ocorrer** | Mitigação: não expor nada até concluir 02B.3; registrar como pré-condição do 02B.6 |
| Código duplicado entre 02A e 02B (correções futuras não se propagam) | Baixa | Aceito: POCs são descartáveis e isoladas, com atribuição de origem |
| Uso indevido da CA local herdada | Média | README avisa; remoção é decisão pendente |
| Mudanças sem CI na branch | Baixa | Validação local registrada; CI no 02B.7 ou antes, se decidido |
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
4. **Destino do modo HTTPS/CA local herdado:** remover no 02B.2 ou manter desativado.
5. **ICE restart:** nesta POC ou na seguinte.
6. **Comportamento na queda da sinalização (teste 8):** encerrar de forma limpa (comportamento atual) ou manter o
   áudio por uma janela tentando reconectar.
7. **Método do teste de UDP bloqueado:**
   - modo `relay-tls` no navegador;
   - flag de política de IP do Chromium (a verificar);
   - regra no Firewall do Windows, que é alteração de sistema e exige autorização do usuário.
8. **CI da POC-02B:** criar `poc-02b-ci.yml` já no 02B.2 ou só no 02B.7.
9. **Uso de dados móveis:** estimativa de cerca de 22 MB/h de áudio **[Inferido]**.
