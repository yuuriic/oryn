# POC-02C.1B — Matriz de evidências (17 testes de `tests/integration.pending.test.ts`)

**Status:**
- **PASS:** comprovado no Supabase real, com evidência anexada.
- **FAIL:** comprovado que não atende.
- **NOT VERIFIED:** pronto para executar, ainda não executado.
- **BLOCKED:** não dá para executar até resolver o bloqueio indicado (B1–B5 do runbook).

Situação em 2026-10-23: **0 PASS · 0 FAIL · 14 NOT VERIFIED · 3 BLOCKED** (atualizado no 02C.1B.0C: #17 desbloqueado). Nada foi executado no remoto.
A única evidência remota já colhida é de leitura: versão do Postgres e projeto vazio.

**02C.1B.0A:** nenhum status mudou, porque mocks e PGlite não convertem NOT VERIFIED em PASS. Mudou a
**prontidão**:
- B1/B2/B3 corrigidos localmente;
- harness pronto para #3, #4, #6, #7, #8, #11 e #15;
- pós-voo ampliado com a auditoria de `SECURITY DEFINER`.

Os itens #13 e #14 continuam BLOCKED, agora só por falta de autorização de publicação, mais a trava
`enabled = false`.

## Ordem de execução (prioridade)

1. **Privilégios efetivos** (#1, #16, #2).
2. **Exposição de schemas** (#3, #4).
3. **Isolamento de usuários e salas** (#6, #7).
4. **Broadcast direto negado** (#8, #9).
5. **Persistência** (#10, #11).
6. **Revogação e cache** (#12).
7. **Concorrência** (#15).
8. Depois: #5, #13, #14, #17.

| # | Teste | Método | Esperado (critério objetivo) | Evidência | Status | Prontidão (02C.1B.0A) |
|---|---|---|---|---|---|---|
| 1 | Migrações aplicam no Postgres do Supabase (17.11, não 18) | Fases 2–4: `00_preflight.sql` → `supabase db push` → `supabase migration list` | O push termina sem erro; 3 versões em Local e Remote | Saída do pré-voo, do push e do `migration list` | NOT VERIFIED (versão 17.11 confirmada por leitura) | Scripts SQL validados no PGlite |
| 2 | Privilégios padrão reais × shim, neutralizados | P8 do pré-voo + `01_postflight.sql` | P8 anotado; pós-voo com **todas** as linhas `pass = true` (301 no PGlite) | Saída do P8 e do pós-voo | NOT VERIFIED | Pós-voo com 301 itens |
| 3 | Data API não expõe `oryn`/`realtime` | (a) P9/pós-voo; (b) HTTP com JWT de usuário: `GET /rest/v1/rooms` com `Accept-Profile: oryn`; `POST /rest/v1/rpc/send` com `Content-Profile: realtime`; (c) GraphQL: introspecção não lista nada de `oryn` | (a) `pass`; (b) 406/`PGRST106` (schema não exposto); (c) só as RPCs de `public` | Status HTTP + corpo do erro (sem JWT) | NOT VERIFIED | Harness: `schema('oryn')`/`schema('realtime')` → PGRST106 |
| 4 | RPC por PostgREST: anon recusado; erro curto | `POST /rest/v1/rpc/join_room` só com a chave publicável (sem JWT de usuário) e depois com JWT de usuário sem convite | Sem JWT: 401/403 `permission denied`. Com JWT sem convite: `message = "not-member"` (código curto, sem detalhes internos) | Status + `message` | NOT VERIFIED | Harness: sem JWT, estranho, `set_signal_state` |
| 5 | Anônimo + Turnstile; limite 30/h por IP | Com CAPTCHA ligado: `signInAnonymously()` sem token; com a chave de teste "sempre falha"; com "sempre passa" | Sem token e com "falha" → recusado; com "passa" → usuário criado. **Não** rodar o estouro de 30/h (apenas ler a configuração) | Respostas + captura de Auth › Rate limits | **BLOCKED** (B5) | Aguarda B5 |
| 6 | Canal privado: próprio tópico ok; outro recusado | Harness: A e B em salas diferentes. A assina `oryn:s:{sessão de A}` (`private: true`) → `SUBSCRIBED`; A assina `oryn:s:{sessão de B}` → erro; membro da mesma sala assina a sessão de outro → erro | Exatamente como descrito. Erro de entrada = `phx_reply status=error` (`Unauthorized`) | Status de cada `subscribe` | NOT VERIFIED | Harness: próprio, alheio, estranho, inexistente |
| 7 | "Allow public access" desligado: canal sem `private: true` recusado | Harness: assinar `oryn:s:{própria}` com `private: false` | Entrada recusada | Status + captura do painel | NOT VERIFIED | Harness: `private: false` |
| 8 | Cliente não envia Broadcast em `oryn:*` (WS e REST) | (a) WS: A, inscrito no próprio tópico com `ack: true`, envia `broadcast`. B, inscrito no mesmo tópico (segunda aba de A), não recebe nada; (b) REST: `POST /realtime/v1/api/broadcast` com o **JWT de A** para `oryn:s:{sessão de B}`, `private: true`; (c) variante com `ORYN:S:` maiúsculo | (a) `send()` = `error`, e nada chega; (b) não chega ao destinatário (status anotado); (c) idem | Logs do harness com o contador de mensagens recebidas = 0 | NOT VERIFIED | Harness: WS com `ack` + REST `httpSend` (minúsculo e maiúsculo) |
| 9 | Broadcast REST com a chave secreta entrega só a quem tem SELECT | Edge Function (ou `curl` do operador com `apikey: sb_secret_…`, **sem** `Authorization`) publica em `oryn:s:{sessão de B}`. B e A estão inscritos | Só B recebe | Contadores de recepção | NOT VERIFIED | B1 corrigido: só `apikey` secreta |
| 10 | Broadcast REST **não** persiste nem aparece no Replay (portão S2) | Depois do #9: `select count(*) from realtime.messages where topic = 'oryn:s:<B>' and event = 'signal'` (SQL editor) + cliente B com `broadcast.replay.since` | Contagem = 0 e nada reproduzido. **Se > 0: FAIL**, e a opção S2 cai | Saída SQL + log do Replay | NOT VERIFIED | Depende do #9 + SQL |
| 11 | `realtime.send` (controle) chega e fica retido | `join_room` por A2 com B inscrito → B recebe `hello`; consulta em `realtime.messages` pelo tópico de B | B recebe `hello` com só `session_id`/`label`; linha presente (retenção documentada: 3 dias) | Log + saída SQL | NOT VERIFIED | Harness: `hello` com chaves exatas |
| 12 | Sessão revogada com assinatura em cache | B inscrito; B chama `leave_room` (ou o dono o remove). Publicar de novo no tópico de B; depois B envia `access_token` com um JWT novo | Documentação: a autorização fica em cache até a nova entrada no canal ou o `access_token`. **Registrar** se B ainda recebe antes da renovação (risco aceito ou não, decisão do arquiteto); depois da renovação, o canal cai (`system` error + `phx_close`) | Linha do tempo com contadores | NOT VERIFIED | Exige publicação do servidor |
| 13 | Edge Function `signal` ponta a ponta; p95 ≤ 500 ms | Harness: 200 envios válidos + casos 400/401/403/409/413/429 | Códigos conforme o contrato; p95 ≤ 500 ms medido no cliente | Tabela de códigos + histograma | **BLOCKED** (publicação não autorizada; `enabled = false` no config.toml) | B1–B3 corrigidos localmente; publicação não autorizada |
| 14 | Chave secreta só como secret; logs sem payload/JWT/IDs completos | Painel › Edge Functions › Logs depois do #13; `grep` por `eyJ`, `sb_secret_`, `v=0` (SDP) e UUIDs completos | Nenhuma ocorrência; só prefixos de 8 caracteres | Export dos logs filtrado | **BLOCKED** (depende do #13) | Logs sanitizados testados com mocks |
| 15 | Resgate SIMULTÂNEO do convite: exatamente 1 sucesso | `integration/sql/10_concurrency_redeem.sql` (2 sessões psql) + variante HTTP com N=10 | SQL: B bloqueia e recebe `invite-invalid`. HTTP: 1×200 e 9×`invite-invalid`; 1 membro novo | Saídas das duas sessões + contagem | NOT VERIFIED | Harness HTTP (N=5) + roteiro SQL |
| 16 | Dono real das migrações: não superusuário; tem `EXECUTE` em `realtime.send`; cria políticas | P1, P5, P6 do pré-voo + sucesso da 0300 | `rolsuper = false`; `owner_send = true`; `can_manage = true`; 0300 aplicada | Saída do pré-voo | NOT VERIFIED | Pré-voo P1/P5/P6 |
| 17 | Integração GitHub conferida ANTES do primeiro push | Fase 0 do runbook (painel, só leitura) + push canário | Working directory, branch de produção, Deploy to production e Automatic branching registrados e aprovados pelo arquiteto | Capturas de tela + leitura pós-canário | NOT VERIFIED: confirmação do usuário registrada (Working directory `.`, produção `main`, Deploy to production desligado, branching indisponível no Free); **faltam as capturas**. O canário `c9e1546` não teve efeito: 0 runs, 0 checks, 0 migrações, 0 funções, 0 branches em 15 min | Fase 0 do runbook |

## Evidência complementar já disponível (local)

| Item | Resultado |
|---|---|
| `pnpm typecheck` + `pnpm test` (Node 24.19.0, pnpm 12.6.0) | 190 passed · 17 todo (02C.1B.0A; eram 133) |
| `01_postflight.sql` no PGlite depois das migrações | 301/301 `pass` (pós-voo ampliado com a auditoria) |
| `01_postflight.sql` com 5 regressões injetadas | 5/5 detectadas |
| `90_rollback.sql` → reaplicação → pós-voo | Reversão limpa; 301/301 `pass` depois |
| `tests/edge-auth.test.ts` (B1/B2: headers por operação, negativos, logs) | 37 passed; mutação "secreta em Bearer" → 2 falhas; "authorize com chave secreta" → 4 falhas |
| `tests/sql-definer-audit.test.ts` (catálogo + 32 chamadas indevidas, com RLS ligado e desligado) | 8 passed; mutação (EXECUTE para PUBLIC + checagem de dono removida) → 3 falhas |
| `tests/remote-guard.test.ts` + `pnpm test:remote` sem configuração | 12 passed; harness: 12 skipped · 7 todo; com `ORYN_REMOTE=1` incompleto ou chave secreta no ambiente → aborta antes da rede |
| `supabase/config.toml` na CLI 2.122.0 | Configuração carregada; tipo inválido recusado; chave desconhecida ignorada (risco) |
| Leitura remota (MCP, sem segredos) | `oryn` ACTIVE_HEALTHY, PG 17.11; 0 migrações; 0 branches; 0 Edge Functions |
