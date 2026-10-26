# POC-02C.1B — Runbook da integração com o Supabase real

Estado: **preparado, não executado**. Checklist por etapa (0100, 0200, 0300), auditoria `SECURITY DEFINER` e configurações do painel: `DEPLOY-CHECKLIST-02C.md` (02C.2C.1). Correções locais B1–B3 feitas no 02C.1B.0A (seção 3). Nada remoto foi alterado. Toda fase abaixo marcada com ⛔ exige
aprovação explícita do arquiteto antes de começar.

## 1. Alvo

| Item | Valor (lido em 2026-10-23, sem segredos) |
|---|---|
| Projeto | `oryn`, ref `<PROJECT_REF>` (fora do repositório, que é público: ver o painel ou `supabase projects list`), `us-east-1`, `ACTIVE_HEALTHY` |
| Postgres | 17.11 (engine 17, GA). Os testes locais usam PGlite com **Postgres 18**: a diferença de versão é o risco R1 |
| Migrações aplicadas | nenhuma (`list_migrations` vazio) |
| Branches Supabase | nenhuma (`list_branches` vazio) |
| Edge Functions | nenhuma |
| Integração GitHub | Confirmado pelo usuário no 02C.1B.0C: Working directory `.`, Production branch `main`, Deploy to production **desligado**, Automatic branching **indisponível** (plano Free). Com `.`, a integração procura `supabase/` na **raiz** do repositório, que não existe: a pasta `poc/webrtc-audio-supabase/supabase/` **não é lida** |

## 2. Compatibilidade das migrações com o Supabase

| Migração | Ponto | Avaliação |
|---|---|---|
| todas | Nomes `20261023000100_*.sql` (14 dígitos) | Formato aceito pelo CLI e pela integração |
| todas | `CREATE FUNCTION`/`CREATE POLICY` sem `OR REPLACE`/`IF NOT EXISTS` | Correto para a primeira aplicação; reaplicar sem reverter falha (pré-voo P2/P3) |
| 0100 | FKs para `auth.users` | Exige `REFERENCES` em `auth.users` para `postgres` (pré-voo P6) |
| 0100/0200 | `gen_random_uuid`, `sha256`, `make_interval`, `cardinality` | Funções nativas do PG 13+; nenhuma extensão necessária |
| 0100 | `alter default privileges ... in schema oryn` | Vale só para objetos criados **pelo papel que roda a migração** (`postgres`). Objetos criados por outro papel não são cobertos (aceitável: só `postgres` cria em `oryn`) |
| 0200 | `revoke ... from anon, authenticated, service_role` depois de cada `create` | Neutraliza os privilégios padrão de `public` **se existirem**. Projetos novos podem já não concedê-los: as migrações funcionam nos dois casos, porque os `GRANT` são explícitos |
| 0200 | `realtime.send(jsonb,text,text,boolean)` dentro de `SECURITY DEFINER` | Exige `EXECUTE` para `postgres` (P6). Assinatura confere com a documentação |
| 0300 | Asserção de RLS (sem `ALTER TABLE`) e `create policy` | **02C.2B:** o `postgres` não é dono de `realtime.messages` (dono `supabase_realtime_admin`, lido na 02C.2A). A 0300 não altera a tabela: só exige RLS ligado e para inteira se não estiver. As políticas são autorizadas pelo `supautils.policy_grants`, que lista `postgres → realtime.messages` (P5 `policy_grant = true`, lido no real) |
| 0300 | Política de `select` exige `extension = 'broadcast'` | Compatível com a checagem do Realtime (consulta em `realtime.messages` seguida de rollback) |
| 0200 | `pg_graphql` | Se ativo, as RPCs de `public` também aparecem por GraphQL. A autorização é a mesma (`EXECUTE`); anotar no teste #3 |

Validação local feita agora: `00_preflight.sql` e `01_postflight.sql` rodam no PGlite. O pós-voo dá
**301/301 PASS** (02C.1B.0A), detecta todas as regressões injetadas (5 + 3), e `90_rollback.sql` reverte tudo, com reaplicação limpa.

## 3. Bloqueios encontrados na preparação

| # | Bloqueio | Efeito | Proposta (precisa de aprovação) |
|---|---|---|---|
| **B1** | A Edge Function envia a chave secreta em `Authorization: Bearer` (`rpc()` para `set_signal_state` e `publish()`). As chaves novas `sb_secret_…` **não são JWT**. Pela documentação, nesse caso a requisição é rejeitada ("Invalid JWT") ou chega ao banco e é recusada | `set_signal_state` e o Broadcast REST falham → todo sinal termina em `503 publish-failed`/`database-unavailable` | Para chamadas com a chave secreta: enviar **só** `apikey`, sem `Authorization`. Ler a chave de `SUPABASE_SECRET_KEYS` (JSON, chave `default`), com fallback para `SUPABASE_SERVICE_ROLE_KEY` só se a legada existir. Testar com mocks antes |
| **B2** | O README lista `SUPABASE_URL`, `SUPABASE_ANON_KEY` e `SUPABASE_SERVICE_ROLE_KEY` como secrets a configurar | Nomes com prefixo `SUPABASE_` são **reservados**: o CLI recusa e o runtime já os injeta. Só `ORYN_ALLOWED_ORIGINS` é secret próprio | Corrigir o README e a lista de secrets |
| **B3** | Não existe `supabase/config.toml` | "Deploy to production" publica **só as Edge Functions declaradas em `config.toml`**. Sem o arquivo, o comportamento da integração (branch de preview, `verify_jwt`) não é previsível | Criar `config.toml` mínimo (`project_id`, `[api] schemas = ["public","graphql_public"]`, `[functions.signal] verify_jwt = true`) **só** depois de decidida a configuração da integração |
| **B4** | A branch `poc/webrtc-audio-supabase` tem 10 commits da POC-02B que não estão em `main` (PR #4 em Draft) | Um PR desta branch para `main` arrastaria a POC-02B junto | Antes do PR: fazer rebase sobre `main` depois do merge do #4, **ou** recriar a branch a partir de `main` só com os arquivos da 02C |
| **B5** | Turnstile obrigatório × testes automatizados | Com CAPTCHA ligado, `signInAnonymously()` sem token é recusado, inclusive no harness | No ambiente de teste, usar as chaves de **teste** do Turnstile (sempre passam/sempre falham) ou desligar o CAPTCHA só no ambiente isolado, e testar o #5 à parte |

### Situação depois do 02C.1B.0A

| # | Situação | Evidência local |
|---|---|---|
| B1 | **Corrigido localmente.** Chamadas do usuário (`/auth/v1/user`, `authorize_signal`) levam `apikey` publicável + `Bearer <JWT do usuário>`. Chamadas do servidor (`set_signal_state`, Broadcast REST) levam **só** `apikey` secreta, sem `Authorization` (`_shared/supabase-http.ts`). O 401 do gateway vira `jwt-invalid` (401), não "banco indisponível" | `tests/edge-auth.test.ts`: headers por operação com chaves novas e legadas; negativos; mutação reintroduzindo o bug detectada |
| B2 | **Corrigido.** As chaves vêm de `SUPABASE_SECRET_KEYS`/`SUPABASE_PUBLISHABLE_KEYS` (JSON, chave `default`), injetadas pela plataforma, com alternativa legada validada pelo papel. O único secret próprio é `ORYN_ALLOWED_ORIGINS`. README corrigido | `tests/edge-auth.test.ts` (configuração; mensagens sem valores) |
| B3 | **Preparado.** `supabase/config.toml` (CLI 2.122.0) com `[functions.signal] enabled = false`, `verify_jwt = true` e seed desligado | Carregado pela CLI 2.122.0 sem erro (o `status` só para por falta de Docker). Tipo errado é recusado; **chave desconhecida é ignorada em silêncio** |
| B4 | Pendente (decisão de Git) | — |
| B5 | Pendente (decisão do Turnstile) | — |

## 4. Decisões pendentes do arquiteto

1. **Ambiente de execução das migrações:**
   - **(A) recomendado:** aplicar no próprio projeto `oryn` (vazio, dedicado à POC) por `supabase db push`
     (registra o histórico);
   - **(B):** branch de preview pela integração (exige plano com Branching e `config.toml`; tem custo).
2. ~~**Método de aplicação**~~ **decidido no 02C.3B.1:**
   - **só** `supabase db push` com a CLI **2.122.0**, pelo `oryn-push-step.ps1`;
   - o MCP serve **só** para inspeção e auditoria (consultas 🔎 `READ ONLY`, listas e advisors);
   - `apply_migration` **não** é usado para 0100–0300, porque a Management API não aceita `version` e o histórico divergiria do repositório;
   - o wrapper via `execute_sql` não foi implementado.

   Detalhes: `DEPLOY-CHECKLIST-02C.md`, "Decisão arquitetural". **Nunca pelo SQL editor:** ele não grava
   `supabase_migrations.schema_migrations`, e a integração tentaria reaplicar tudo no primeiro merge em
   `main`, falhando com "already exists".
3. ~~Correção B1/B2~~ feita localmente (02C.1B.0A); falta a revisão.
4. ~~Dependência `@supabase/supabase-js`~~ adicionada (2.118.0, fixa, só de desenvolvimento).
5. **Turnstile** no ambiente de teste (B5).
6. **Quando liberar a função:** trocar `enabled = false` por `true` no `config.toml` só no passo de
   publicação autorizado.

## 5. Procedimento controlado

### Fase 0 — Leitura do painel (usuário, sem alterar nada)

Registrar captura de tela de cada item em `integration/evidence/` (pasta fora do Git, ver §8):

- [ ] **Settings › Integrations › GitHub:**
  - repositório;
  - **Working directory**: precisa ser `poc/webrtc-audio-supabase` para esta pasta ser lida. Se for `.`,
    não há `supabase/` na raiz e nada é aplicado;
  - **Production branch**;
  - **Deploy to production** (on/off);
  - **Automatic branching** (on/off) e **Supabase changes only**.
- [ ] **Settings › API Keys:** existem chaves `sb_publishable_`/`sb_secret_`? As legadas `anon`/`service_role` estão ativas? (Não copiar valores.)
- [ ] **Settings › Data API:** schemas expostos (esperado: só `public`, `graphql_public`).
- [ ] **Realtime › Settings:** "Allow public access" (esperado: **desligado** antes do teste #7).
- [ ] **Authentication › Providers:** anonymous sign-ins; **Attack Protection**: CAPTCHA; **Rate limits**: anônimo (padrão 30/h por IP).
- [ ] **Authentication › Sessions/JWT:** expiração do JWT e tipo de chave de assinatura.

**Pare se:** Deploy to production estiver ligado com a branch de produção = `poc/webrtc-audio-supabase`,
ou se o Automatic branching estiver ligado sem decisão (B3). Nesses casos, um push aplica migrações sem
controle.

### Fase 1 — Pré-voo local (pode rodar já)

```powershell
cd "C:\Dev\Projeto - Oryn\poc\webrtc-audio-supabase"
pnpm install --frozen-lockfile; pnpm typecheck; pnpm test; pnpm test:pg; pnpm audit
# esperado (02C.3B.1, 2026-10-26): test 248 passed / 18 todo (inclui 12 do script com CLI falsa, 3 deles de versão, e 5 do 06/07); test:pg 17 passed; audit limpo
```

### Fase 2 — Pré-voo remoto, somente leitura ⛔

Rodar `integration/sql/00_preflight.sql` no SQL editor do alvo. A transação é `READ ONLY` com `ROLLBACK`.
Salvar a saída. **GO para a Fase 3 só se:**
- P1–P6 baterem com o esperado revisto no 02C.2B (P5: `rls_enabled = true` e `policy_grant = true`);
- P2, P3 e P7 vierem vazios;
- P9 for registrado como NOT VERIFIED, com a captura do painel.

### Fase 3 — Aplicação, uma migração por vez ⛔

A CLI 2.122.0 não aplica "até a versão N". Por isso cada passo usa um `--workdir` temporário, fora do
repositório, com só as N primeiras migrações; o histórico remoto faz o passo aplicar só a migração nova.
Sempre o mesmo método: **não** misturar com `apply_migration` do MCP nem com o SQL editor (decisão
arquitetural do 02C.3B.1).

**02C.3B.1:**
- O script confere a versão exata da CLI (2.122.0) antes de montar o workdir, pedir credenciais ou
  conectar. CLI ausente, outra versão ou versão não identificável = recusa sem chamar o `db push`.
- O `07` foi revisto. O `platform_fingerprint` não inclui mais `supabase_migrations` (criado pela
  primeira aplicação) nem as partições do Realtime, e tem de ficar **constante** em todo o procedimento.
  Essas mudanças esperadas aparecem em campos próprios. Tabela completa em `DEPLOY-CHECKLIST-02C.md`,
  seção 1c.

**02C.3A.1 — autenticação explícita, sem papel temporário.**
- Sem a senha do banco, a CLI cria o papel `cli_login_postgres` no projeto (documentação oficial), mesmo
  num `--dry-run`. É uma escrita persistente, que só sai pela Management API.
- Por isso todos os passos rodam pelo script `integration/scripts/oryn-push-step.ps1`, que:
  - pede a senha como `SecureString`;
  - a coloca em `SUPABASE_DB_PASSWORD` só durante a chamada;
  - remove a senha e o workdir num `finally`, inclusive em erro;
  - recusa senha vazia, porque senha vazia também cria o papel.
- O `supabase db dump` (que exige Docker) foi substituído pelo registro somente leitura
  `integration/sql/07_initial_state.sql`. **Não é backup.**
- Lido na CLI 2.122.0 (ajuda e binário):
  - no `db push --project-ref`, a `SUPABASE_DB_PASSWORD` vale (ela só é ignorada no `gen types` com ref avulso);
  - a variável **não** aparece no `--help`;
  - o dry-run não cria `supabase_migrations`;
  - o prompt da CLI tem padrão **Sim**, então não é trava: a trava é o `APLICAR <versão>` do script.

  Detalhes e o que continua NOT VERIFIED: `DEPLOY-CHECKLIST-02C.md`, seção 1a.

```powershell
cd "C:\Dev\Projeto - Oryn\poc\webrtc-audio-supabase"
supabase --version                                                          # tem de ser 2.122.0; senão, parar (o script também confere)
supabase login                                                              # token pessoal só no terminal
# 🔎 antes: 07_initial_state.sql (salvar o JSON) e 06_cli_side_effects.sql ({} / false / {})
pwsh -NoProfile -File integration/scripts/oryn-push-step.ps1 -Step 1         # dry-run: SÓ a 0100
# 🔎 06 de novo: tem de continuar {} / false / {}; 07: tudo igual (checklist, seção 1c)
pwsh -NoProfile -File integration/scripts/oryn-push-step.ps1 -Step 1 -Apply  # ⛔ só com a autorização da Etapa 1; no prompt [Y/n] da CLI, conferir a lista e digitar y (Enter vazio = aplica)
# 🔎 05_step_checks.sql (passo 1) + 06 (history = {20261023000100}) + 07 (seção 1c) + advisors
# Repetir com -Step 2 e -Step 3, cada um com a sua autorização.
```

Critérios de aprovação e de interrupção de cada passo: `DEPLOY-CHECKLIST-02C.md` (seções 1a e 2).

As pastas `supabase/.temp/` dos workdirs temporários ficam fora do repositório; a do projeto já está no `.gitignore`.

### Fase 4 — Pós-voo, somente leitura ⛔

Rodar `integration/sql/01_postflight.sql`. **Critério (02C.2B):**
- **zero linhas `FAIL`**;
- cada `NOT VERIFIED` (Data API, "Allow public access") resolvido pela captura do painel e pelos testes #3 e #7;
- linhas `INFO` copiadas para a evidência.

`NOT VERIFIED` nunca conta como PASS.
Rodar também os advisors de segurança e de performance do painel e anotar cada item.

### Fase 5 — Testes de integração ⛔

Executar os itens de `EVIDENCE-02C.1B.md` na ordem de prioridade. Cada item tem método, resultado
esperado e evidência. Usuários de teste: só anônimos, com rótulos `it-*`. Nenhum dado real.

### Fase 6 — Recuperação de falhas

| Falha | Ação |
|---|---|
| Pré-voo diverge | Não aplicar. Registrar e levar ao arquiteto |
| `db push` falha numa migração | O CLI aplica cada arquivo numa transação (**NOT VERIFIED**). Conferir com P2/P7 o que ficou. Se ficou parcial: `90_rollback.sql` ⛔, corrigir a migração **localmente** (testes PGlite verdes) e reaplicar |
| Pós-voo com `pass = false` | Tratar como falha de segurança: não seguir para a Fase 5. Se o item expõe dados (ex.: `EXECUTE anon`), reverter com `90_rollback.sql` ⛔ |
| A integração aplicou algo sem querer | Desligar "Deploy to production"/"Automatic branching" (decisão do usuário), conferir `supabase migration list`, e reverter se preciso |
| Segredo exposto em log ou print | Rotacionar a chave no painel na hora (nova `sb_secret_`, apagar a antiga) |

## 6. Configurações necessárias no Supabase (a aplicar só com autorização)

| Área | Configuração | Motivo / teste |
|---|---|---|
| Data API | Expor só `public` (e `graphql_public`). Nunca `oryn`, `oryn_realtime`, `realtime` | #3 |
| Realtime | "Allow public access" **desligado**; clientes com `private: true` | #6, #7 |
| Realtime | Renovar o JWT com a mensagem `access_token`. Tokens `sb_*` são ignorados nessa mensagem | #12 |
| Auth | Anonymous sign-ins **ligado** | D1 |
| Auth | CAPTCHA (Turnstile) **ligado** em produção; no ambiente de teste, chaves de teste do Turnstile | #5, B5 |
| Auth | JWT com expiração curta (proposta: 600 s). O cache de autorização do Realtime só é recalculado na entrada no canal ou em `access_token`; com o JWT vencido, o cliente é desconectado | #12 |
| Auth | Rate limit de anônimos: manter 30/h por IP; o harness precisa de ≤ 10 usuários por execução | #5 |
| API Keys | Usar `sb_publishable_` (frontend) e `sb_secret_` (só Edge Function). Desativar as legadas quando nada depender delas | B1 |
| Edge Function `signal` | `verify_jwt = true` no `config.toml`, o mesmo que a CLI 2.122.0 gera para `functions new --auth user`. A função valida o usuário de novo no código (`/auth/v1/user`). **NOT VERIFIED:** se a pré-requisição CORS (`OPTIONS`, sem `Authorization`) for barrada pela plataforma, usar `verify_jwt = false`; a validação no código continua | #13 |
| Edge Function | Secret próprio: só `ORYN_ALLOWED_ORIGINS`. `SUPABASE_URL`, `SUPABASE_SECRET_KEYS` e `SUPABASE_PUBLISHABLE_KEYS` são injetados pela plataforma | B2, #14 |
| Banco | Rodar os advisors depois das migrações | Fase 4 |

## 7. Integração GitHub: como verificar branching e deploy de produção

Segundo a documentação oficial:
- com **Automatic branching** ligado, cada branch do GitHub ganha uma branch do Supabase. Cada commit roda
  Clone → Pull → Health → Configure → Migrate → Seed → Deploy;
- com **Deploy to production** ligado, um push ou merge na branch de produção aplica as migrações novas e
  publica as Edge Functions **declaradas em `config.toml`**. Auth, API e seed são ignorados.

Verificação, sem alterar nada:
1. Fase 0 (painel), com captura de tela.
2. No GitHub, depois do primeiro push autorizado: o check **"Supabase Preview"** aparece no commit/PR
   (só com branching). O comentário do bot no PR mostra o status.
3. `list_branches` (MCP) ou `supabase branches list`: aparece branch nova? Com que status?
4. `list_migrations` no projeto de produção: deve continuar **vazio** depois de um push que não seja na
   branch de produção.
5. No GitHub › Settings › Branches, a proteção de `main` com os checks obrigatórios
   "POC-02C CI (resultado)" e, se houver branching, "Supabase Preview".

## 8. Evidências

- Saídas SQL, capturas e logs vão para `integration/evidence/` **local, fora do Git** (já no
  `.gitignore` desde o 02C.1B.0A), ou anexadas ao relatório.
- Nunca registrar:
  - JWT, chaves, tokens de convite ou a string de conexão;
  - IDs completos em logs públicos (usar os 8 primeiros caracteres).

## 9. Harness remoto (implementado no 02C.1B.0A; **nunca executado**)

- **Arquivos:** `tests/remote/integration.remote.test.ts` e `tests/remote/remote-env.ts` (portão), com
  `vitest.remote.config.ts` próprio. Ficam **fora** do `pnpm test` e do CI (`exclude` no `vitest.config.ts`).
- **Portão** (testado em `tests/remote-guard.test.ts`):
  - sem `ORYN_REMOTE=1`, tudo é pulado;
  - com `ORYN_REMOTE=1`, exige `ORYN_REMOTE_REF` igual ao ref da `ORYN_SUPABASE_URL` e uma chave publicável;
  - **aborta** se qualquer variável do ambiente tiver cara de credencial administrativa (`sb_secret_` ou JWT
    `service_role`), citando só o nome da variável.
- **Dependência:** `@supabase/supabase-js` 2.118.0 (fixa; +9 pacotes no lockfile; `pnpm audit` limpo).
- **Coberto pelo harness:** #3, #4, #6, #7, #8 (WebSocket e REST), #11, #15 (HTTP, N=5) e #18. **02C.4B**
  acrescentou (matriz da 02C.4A):
  - S6 (`anon`), S7 (variações do tópico), S8/P5 (Presence);
  - A1 (revogação), A2/A3 (expiração e nova sessão), A4 (segunda aba);
  - P3 (REST só com a chave publicável), D2 (`bye`), D3 (sessão revogada com canal aberto não recebe).

  Os outros itens ficam como `todo` com o motivo (SQL privilegiado, operador ou Edge Function).
- **Correções do 02C.4B no harness:**
  - `httpSend` rejeita a promessa em status ≠ 202, e o #8 REST quebrava com exceção quando o servidor
    recusava corretamente. Agora o critério é a não entrega, e o status fica anotado.
  - O `realtime-js` devolve o canal já existente do mesmo tópico, e um segundo `subscribe()` nunca responde.
    Por isso o #8 dava `NO_REPLY`. Agora o canal anterior é removido antes de assinar, e canais recusados
    são removidos na hora.
  - Batimento automático das sessões fixas da sala: a execução passa de 90 s.
- **Sala de teste:** só com `ORYN_IT_CREATOR_INVITE`, um convite de criador de **uso único** emitido no SQL editor
  (`select oryn.admin_issue_creator_invite(10, 1);`). Sem ele, os testes de sala ficam pulados. O nome da
  sala leva um identificador por execução (`it-02c4b-<8 hex>`), para auditoria e limpeza.
- **Duas fases e D0 (02C.4B.1):**
  - **C1:** sem convite. Só o bloco "sem sala", com 1 cadastro. É a 1ª conexão WebSocket e cria as partições. Não depende de D0.
  - **D0:** o operador confere, por leitura, a partição de hoje em `realtime.messages`.
  - **C2:** com o convite. O portão **exige** `ORYN_IT_PARTITIONS_CONFIRMED=1` e aborta antes da rede sem
    ela, o que também evita gastar o convite de uso único. Só `1` é aceito.
- **Confiabilidade (02C.4B.1):**
  - Um negativo de entrada no canal só passa com **recusa do servidor**. Timeout, falta de resposta ou queda
    de transporte reprovam, e uma recusa por JWT/token só é aceita no S6 (`anon`).
  - Todo negativo de entrega (P1, P2/P3, D3) roda **depois** de D1/D2 e termina com um **controle positivo**
    no mesmo canal (um `hello` legítimo chega), ou com a prova de que o canal segue conectado (D3).
  - Teste encerrado por timeout não inicia mais operação remota (`AsyncLocalStorage` + `signal` do Vitest).
  - Os canais abertos são fechados no `afterEach`, mesmo em falha.
  - O batimento das sessões fixas é encerrado no `afterAll` (também quando o `beforeAll` falha), espera a
    chamada em voo e é conferido pelo A2.
  - As peças puras ficam em `tests/remote/harness-utils.ts`, testadas sem rede em `tests/remote-harness-utils.test.ts`.
- **Custo:** 9 cadastros anônimos por execução completa (1 no bloco sem sala, 3 na sala e 5 no #15); só 1 sem
  convite. Limite padrão: 30/h por IP. Duração: ~3 min (o A2 espera 100 s).
- **Execução (⛔ só depois da Fase 4):**

```powershell
$ref = Read-Host 'ref do projeto (<PROJECT_REF>)'               # digitado, não salvo
$env:ORYN_REMOTE = '1'; $env:ORYN_REMOTE_REF = $ref
$env:ORYN_SUPABASE_URL = "https://$ref.supabase.co"
$env:ORYN_PUBLISHABLE_KEY = Read-Host 'chave publicável'      # digitada, não salva
# C1: SEM convite → pnpm test:remote; depois, D0 (leitura da partição de hoje)
# C2: com convite E a confirmação (o portão recusa um sem o outro)
$env:ORYN_IT_CREATOR_INVITE = Read-Host 'convite de criador'  # uso único
$env:ORYN_IT_PARTITIONS_CONFIRMED = '1'                        # só depois do D0
pnpm test:remote
Remove-Item Env:ORYN_*                                         # limpar ao terminar
```

## 10. Fidelidade dos ambientes de teste (02C.2B)

| Aspecto | PGlite + shim (`pnpm test`) | PostgreSQL 17 embutido (`pnpm test:pg`) | Supabase real |
|---|---|---|---|
| Versão | Postgres 18 | **17.10** | 17.11 |
| Conexões simultâneas | não (uma só) | **sim** | sim |
| `realtime.messages` | particionada, RLS ligado, dono `supabase_realtime_admin`, privilégios de cliente | igual | observado na 02C.2A |
| `realtime.send` | cópia do código real (INVOKER, `id`, WARNING) | igual | observado |
| Permissão de criar políticas | aproximada por pertença ao dono (também permitiria `ALTER TABLE`); compensada por um teste estático que proíbe `ALTER TABLE` em `realtime.*` | igual | `supautils.policy_grants` (só políticas) |
| Dono das migrações | `migration_owner`: não superusuário, BYPASSRLS | igual | `postgres`: não superusuário, BYPASSRLS |
| Partições do Realtime | uma partição larga | igual | diárias, criadas pelo serviço Realtime (**NOT VERIFIED**: hoje 0) |
| Codificação | UTF8 | UTF8 (`--encoding=UTF8 --locale=C`) | UTF8 |
| PostgREST, Data API, gateway, Realtime, Auth | **não existem** | **não existem** | só pelo harness remoto e pelo painel |

O que **só** o Supabase real prova:
- schemas expostos;
- canais privados, entrega e não persistência do Broadcast;
- cache de autorização;
- Turnstile;
- criação de partições;
- o comportamento do `supautils`.
