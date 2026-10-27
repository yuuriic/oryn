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
- **CAPTCHA, fases e orçamento (02C.4E):**
  - `ORYN_CAPTCHA_MODE=turnstile-test` é **obrigatório**. O projeto fica, só durante a janela, com o Turnstile
    e o **secret de teste oficial** da Cloudflare. O harness envia sempre o token fictício oficial
    (`XXXX.DUMMY.TOKEN.XXXX`). Um `ORYN_CAPTCHA_TOKEN` diferente dele é recusado, e tokens reais nunca passam.
  - `ORYN_IT_PHASE=C1|C2` é **obrigatório**. Cada processo roda uma fase. A C1 recusa o convite no ambiente;
    a C2 exige o convite e `ORYN_IT_PARTITIONS_CONFIRMED=1`.
  - #5 na C1: o cadastro **sem** token tem de ser recusado (erro, sem sessão e sem usuário, sem depender do
    texto do erro), e o cadastro **com** o token fictício cria um usuário com `is_anonymous = true`.
  - **Orçamento:** no máximo **10 tentativas de cadastro por janela** (C1 = 2: o #5 positivo e o negativo;
    C2 = 8: 3 + 5 no #15). `ORYN_IT_IDENTITY_BUDGET` (1..10, **obrigatório**) é o **saldo** da janela,
    declarado pelo operador. O portão recusa um saldo menor que o da fase, e o processo para antes da rede
    na tentativa que passar do saldo.
  - **Limitação:** a contagem é **por processo**. O controle entre processos e reexecuções é operacional
    (§10, "Orçamento entre processos").
- **Execução:** só pela janela controlada do §10 (C1/C2 com cadastro anônimo) ou pelo §12 (C0 sem identidade;
  C2 com contas preexistentes por e-mail/senha, sem tocar no Auth).

## 10. Janela controlada de testes remotos (02C.4E; ⛔ cada passo marcado exige autorização própria)

Princípios:
- Uma janela tem **início (`T0`) e fim (`T1`) registrados em UTC**, **um** responsável e **no máximo 10**
  tentativas de cadastro anônimo.
- **Duração (02C.4F.1):**
  - alvo de **15 min** entre `T0` (CAPTCHA de teste ativo) e `T1` (restauração concluída);
  - **limite absoluto de 30 min**: em `T0 + 30 min`, a restauração (passo 8) começa **imediatamente**, em
    qualquer estado, mesmo com um teste rodando (interromper com Ctrl+C);
  - o responsável registra `T0 + 15` e `T0 + 30` antes de começar.
- Nada é alterado no painel sem a captura de **antes**, e tudo é restaurado com a captura de **depois**.
- Tokens, chaves, convites e JWTs **nunca** vão para arquivo, log ou evidência: só nomes de variáveis.
- Evidências em `integration/evidence/janela-<AAAAMMDD-HHMM>/` (pasta fora do Git).

**Regras de ordem (02C.4F.1; obrigatórias):**
1. **Ligar:** CAPTCHA (secret de teste) **antes** do anônimo. Nunca existe instante com anônimo ligado e
   CAPTCHA desligado.
2. **Desligar:** anônimo **antes** do CAPTCHA, pelo mesmo motivo.
3. **Fases:** C1 → conferência dos resultados da C1 (7 PASS e 1 identidade na janela) → D0 → **só então**
   emitir o convite → C2. O convite nunca é emitido antes de a C1 estar conferida.

**Falha leva à restauração (02C.4F.1):** qualquer falha, critério de interrupção (ver "Critérios de
interrupção"), saída ≠ 0 de um `pnpm test:remote`, erro no painel, perda do terminal ou encerramento antecipado
por qualquer motivo leva **direto ao passo 8**. Não se tenta "consertar e repetir" dentro da janela. A limpeza
(passo 9) nunca é pré-requisito da restauração.

**Rotina das variáveis temporárias (02C.4F.1).** Definir uma vez por sessão do PowerShell, antes do passo 3.
Remove só `ORYN_*` e as variáveis locais de apoio, imprime **apenas nomes**, nunca valores, e falha se
sobrar alguma:

```powershell
function Clear-OrynEnv {
  $names = @(Get-ChildItem Env: | Where-Object { $_.Name -like 'ORYN_*' } | ForEach-Object { $_.Name } | Sort-Object)
  foreach ($n in $names) { Remove-Item -LiteralPath "Env:$n" -ErrorAction Stop }
  foreach ($v in 'ref', 'pat', 'cfg') { Remove-Variable -Name $v -Scope Global -ErrorAction SilentlyContinue }
  $left = @(Get-ChildItem Env: | Where-Object { $_.Name -like 'ORYN_*' }).Count
  Write-Host ("ORYN_* removidas: {0} [{1}]; restantes: {2}" -f $names.Count, ($names -join ', '), $left)
  if ($left -ne 0) { throw 'ainda há variáveis ORYN_* no ambiente: não prossiga' }
}
Clear-OrynEnv   # antes de começar: o ambiente tem de estar limpo
```

### 0. Captura do estado inicial (leitura; sem autorização nova)

| Item | Como | Esperado |
|---|---|---|
| Auth › Providers › Anonymous | captura | desligado |
| Auth › Attack Protection › CAPTCHA | captura | desligado |
| Auth › Rate limits (anônimos) e Sessions/JWT | captura | 30/h por IP; JWT 3600 s |
| Realtime › Settings | captura | "Allow public access" desligado |
| Data API › Exposed schemas | captura | só `public`, `graphql_public` |
| Histórico de migrações | `list_migrations` / `06` | `{0100, 0200, 0300}`; `cli_login_*` = `{}` |
| Estado | `07` | `oryn_scope` `1a5a563d…f5a7` / 58; `platform` `4ce64373…1359` |
| Políticas Realtime | `pg_policies` em `realtime.messages` | as 4 `oryn_*`, idênticas à 0300 |
| Dados | contagens (`auth.users`, `is_anonymous`, `oryn.rooms`, `oryn.creator_invites`, `realtime.messages`, partições) | registrar (hoje: tudo 0) |
| Advisors | segurança e performance | registrar |

### 0b. Verificação prévia da restauração do secret (leitura; **nenhuma** alteração remota) — portão de GO

Risco: ao desligar o CAPTCHA, o painel pode **manter o secret de teste gravado**, e um religamento futuro o
usaria sem ninguém perceber. Antes de autorizar a janela, demonstrar **sem salvar nada**:

| # | Verificação | Como | Passa se |
|---|---|---|---|
| V1 | O estado do secret é **observável** | (a) Painel › Auth › Attack Protection: com o CAPTCHA desligado, ver se o formulário mostra o campo do secret e se ele está vazio (**não** clicar em salvar); **ou** (b) leitura da configuração de Auth pela Management API (bloco abaixo), que informa só **booleanos** | É possível afirmar, por captura ou booleano, "secret vazio" × "secret presente" × "é o secret de teste" |
| V2 | Existe um caminho **documentado** para **esvaziar ou substituir** o secret com o CAPTCHA desligado | Painel (campo editável com o CAPTCHA desligado) e/ou documentação da Management API (campo do secret do CAPTCHA na atualização da configuração de Auth) | Há um caminho identificado, com a referência registrada |
| V3 | O estado atual é o esperado | V1 | CAPTCHA desligado e secret vazio (o projeto nunca teve CAPTCHA) |

**Se V1 ou V2 não puderem ser demonstrados: NO-GO para a janela.** Registrar na pasta da janela e levar ao
arquiteto. A janela não começa sem prova de que a restauração do secret é verificável.

Leitura opcional pela Management API. Roda num terminal **separado** do harness; o token pessoal de acesso é
digitado e nunca salvo, e é uma credencial administrativa: **nunca** pode estar no ambiente do `pnpm test:remote`.
A estrutura exata da resposta é NOT VERIFIED: se os campos abaixo não existirem, V1(b) falha e vale só o V1(a).

```powershell
$ref = Read-Host 'ref do projeto'
$pat = Read-Host 'token pessoal de acesso (Management API)' -AsSecureString
$cfg = Invoke-RestMethod -Uri "https://api.supabase.com/v1/projects/$ref/config/auth" `
  -Headers @{ Authorization = 'Bearer ' + [Net.NetworkCredential]::new('', $pat).Password }
# Só booleanos e o nome do provedor; o valor do secret NUNCA é impresso.
[pscustomobject]@{
  campo_enabled_existe = $null -ne $cfg.PSObject.Properties['security_captcha_enabled']
  captcha_ligado       = [bool]$cfg.security_captcha_enabled
  provedor             = [string]$cfg.security_captcha_provider
  campo_secret_existe  = $null -ne $cfg.PSObject.Properties['security_captcha_secret']
  secret_vazio         = [string]::IsNullOrEmpty([string]$cfg.security_captcha_secret)
  secret_eh_de_teste   = ([string]$cfg.security_captcha_secret) -match '^[123]x0{30,}AA$'
  anonimo_ligado       = [bool]$cfg.external_anonymous_users_enabled
}
Remove-Variable cfg, pat, ref
```

### 1. Autorização da janela ⛔

Registrar:
- responsável e quem restaura;
- `T0` previsto, alvo de **15 min**, limite absoluto de **30 min** (`T0 + 30` anotado);
- teto de 10 cadastros;
- resultado do 0b (V1–V3 PASS).

### 2. Alteração manual das configurações (operador, no painel) ⛔

Ordem obrigatória (regra 1): **CAPTCHA primeiro, anônimo depois**.

1. Auth › Attack Protection: CAPTCHA **ligado**, provedor **Turnstile**, secret = **secret de teste oficial que
   sempre aceita** (Cloudflare, "Turnstile › Testing"). É público e não é credencial, mas também não vai para
   arquivo do repositório. Salvar e capturar. **Anotar `T0` (UTC)**: o relógio dos 15/30 min começa aqui.
2. **Só depois** do item 1 salvo: Auth › Providers: **Anonymous sign-ins ligado**. Salvar e capturar.
3. Qualquer erro do painel nos itens 1 ou 2 → **passo 8**.

### 3. C1 ⛔

```powershell
$dir = 'integration/evidence/janela-<AAAAMMDD-HHMM>'             # pasta da janela (fora do Git)
try {
  $ref = Read-Host 'ref do projeto'                              # digitado, não salvo
  $env:ORYN_REMOTE = '1'; $env:ORYN_REMOTE_REF = $ref
  $env:ORYN_SUPABASE_URL = "https://$ref.supabase.co"
  $env:ORYN_PUBLISHABLE_KEY = Read-Host 'chave publicável'      # digitada, não salva
  $env:ORYN_CAPTCHA_MODE = 'turnstile-test'
  $env:ORYN_IT_PHASE = 'C1'
  $env:ORYN_IT_IDENTITY_BUDGET = '10'                            # 1ª e única C1 da janela
  pnpm test:remote --reporter=verbose 2>&1 | Tee-Object -FilePath "$dir/c1.txt"
  $c1Exit = $LASTEXITCODE
} finally {
  Clear-OrynEnv                                                  # sempre, inclusive em erro ou Ctrl+C
}
"C1 exit = $c1Exit"                                              # ≠ 0 → passo 8
```

Esperado: **7 PASS** (#5 ×2, #4 ×3, #3, S4) e exit 0. Senão: **passo 8**.

**Conferência da C1 (antes de qualquer passo seguinte):**
- relatório com 7 PASS e nenhum FAIL ou skip inesperado;
- `Select-String -Path "$dir/c1.txt" -Pattern 'eyJ|sb_(publishable|secret)_'` vazio;
- leitura: anônimos com `created_at ≥ T0` = **exatamente 1**.

Qualquer divergência → passo 8.

### 4. Confirmação das partições (D0; leitura)

Consulta de `02C.4A`, seção 3. A partição de **hoje** tem de existir. Se não existir: **passo 8** (a C2 não começa).

**Limite do D0 (02C.4F.1):** a partição prova só que **algum** cliente se conectou por WebSocket. Ela não
prova que a **C1 desta janela** rodou nem que passou. `ORYN_IT_PARTITIONS_CONFIRMED=1` é uma **declaração do
operador**, não uma verificação automática: o harness da C2 não tem como saber se a C1 aconteceu. A garantia
da ordem é a **conferência da C1** (passo 3) feita antes do D0, mais o saldo (uma C1 depois da C2 não tem
saldo). Só declarar `=1` depois de as duas coisas estarem registradas na pasta da janela.

### 5. Autorização do convite do criador ⛔

Pré-condição (regra 3): conferência da C1 **e** D0 registradas. Antes disso, o convite **não** é emitido.

SQL editor (escrita): `select oryn.admin_issue_creator_invite(10, 1);`. O token aparece **uma vez**: digitar
direto no `Read-Host` do passo 6, **sem** colar em arquivo ou chat, e **sem** salvar a consulta como snippet.
Validade de 10 min. Expirado ou consumido sem uma C2 válida: **passo 8** (não emitir outro sem nova autorização).

### 6. C2 ⛔

```powershell
try {
  $ref = Read-Host 'ref do projeto'
  $env:ORYN_REMOTE = '1'; $env:ORYN_REMOTE_REF = $ref
  $env:ORYN_SUPABASE_URL = "https://$ref.supabase.co"
  $env:ORYN_PUBLISHABLE_KEY = Read-Host 'chave publicável'
  $env:ORYN_CAPTCHA_MODE = 'turnstile-test'
  $env:ORYN_IT_PHASE = 'C2'
  $env:ORYN_IT_IDENTITY_BUDGET = '8'                             # 10 − 1 criada − 1 negativo da C1
  $env:ORYN_IT_PARTITIONS_CONFIRMED = '1'                        # declaração do operador (ver o limite do D0)
  $env:ORYN_IT_CREATOR_INVITE = Read-Host 'convite de criador'  # uso único
  pnpm test:remote --reporter=verbose 2>&1 | Tee-Object -FilePath "$dir/c2.txt"
  $c2Exit = $LASTEXITCODE
} finally {
  Clear-OrynEnv
}
"C2 exit = $c2Exit"                                              # ≠ 0 → passo 8
```

Esperado: **17 PASS** e exit 0. Salvar o relatório com as anotações (motivos de recusa, `track()`, ack,
`httpSend`). Conferir que `Select-String -Path "$dir/c2.txt" -Pattern 'eyJ|sb_(publishable|secret)_'` vem vazio
e que os anônimos com `created_at ≥ T0` são **exatamente 9**. Qualquer divergência: passo 8 (a auditoria do
passo 7 roda **depois** da restauração).

### 7. Auditoria dos dados e da estrutura (leitura; **depois** do passo 8)

É só leitura e não precisa da janela aberta: roda **depois** da restauração, para não prolongar o tempo com o
CAPTCHA de teste. Ordem real de execução: 6 → 8 → 7 → (9, com autorização separada).

- `06` e `07`: estrutura igual ao passo 0 (só `auth_users` e `realtime_messages.particoes` mudam).
- N3/N4: `realtime.messages` em `oryn:*` só com `hello`/`bye`, payload só com `id`, `session_id` e `label`;
  **nenhum** `signal`.
- Contagens: anônimos na janela ≤ 10; 1 sala `it-02c4b-*`; o convite de criador usado.
- Advisors: sem lint novo.

### 8. Restauração das configurações ⛔ (sempre: fim normal, falha, interrupção ou `T0 + 30 min`)

A autorização da janela (passo 1) **já inclui** a restauração: ela nunca espera nova autorização. Não depende
do harness, do terminal nem da limpeza. Ordem obrigatória (regra 2): **anônimo primeiro, CAPTCHA depois**.

1. Se houver teste rodando: **Ctrl+C**. O `finally` dos passos 3 e 6 executa `Clear-OrynEnv`. Conferir
   rodando `Clear-OrynEnv` de novo; tem de dizer `restantes: 0`.
2. Auth › Providers: Anonymous sign-ins **desligado**. Salvar e capturar.
3. **Só depois** do item 2 salvo, em Auth › Attack Protection:
   - **esvaziar** o campo do secret pelo caminho identificado no 0b (V2), ou trocar pelo secret **real**, se o
     widget de produção existir e o arquiteto tiver decidido;
   - CAPTCHA **desligado** (estado do passo 0);
   - salvar e capturar.
4. Confirmar o estado do secret pelo mesmo método do 0b (V1): captura e/ou booleanos (`captcha_ligado = False`,
   `secret_vazio = True` ou o secret real autorizado, `secret_eh_de_teste = False`, `anonimo_ligado = False`).
5. **Anotar `T1` (UTC)**. Registrar a duração (`T1 − T0`; alvo ≤ 15 min, limite 30 min).

Erro no painel em qualquer item: tentar de novo imediatamente. Enquanto R1 e R2 não estiverem confirmados, a
janela continua **aberta** no registro e o arquiteto é avisado na hora.

**Evidências de restauração** (comparar com o passo 0; qualquer divergência é registrada e levada ao arquiteto):

| # | Item | Evidência |
|---|---|---|
| R1 | Anonymous sign-ins | captura: desligado |
| R2 | CAPTCHA | captura + verificação V1 do 0b: desligado **e** secret vazio (ou o secret real autorizado); **nunca** o secret de teste gravado |
| R3 | Rate limits e JWT | captura: iguais ao passo 0 |
| R4 | Realtime "Allow public access" | captura: desligado |
| R5 | Data API | captura: só `public`, `graphql_public` |
| R6 | Políticas Realtime | as 4 `oryn_*`, idênticas (nome, modalidade, papéis, comando, USING e WITH CHECK) |
| R7 | Histórico de migrações | `{0100, 0200, 0300}`; `cli_login_*` = `{}` |
| R8 | Fingerprints (`07`) | `oryn_scope` `1a5a563d…f5a7` / 58; `platform` `4ce64373…1359` |
| R9 | Advisors | iguais ao passo 0 |
| R10 | Variáveis locais | `Clear-OrynEnv` com `restantes: 0`; `Select-String -Path "$dir/*" -Pattern 'eyJ\|sb_(publishable\|secret)_\|sbp_'` vazio |
| R11 | Duração | `T1 − T0` registrado; acima de 30 min = desvio a reportar |

**Verificação funcional opcional (leitura do comportamento, sem cadastro):** nenhuma. Não fazer cadastro
"para ver se desligou": isso gastaria orçamento e criaria usuário. A captura R1 basta.

### 9. Limpeza dos dados ⛔ (autorização SEPARADA, depois da auditoria)

Estratégia da `02C.4B.1`, seção 5:
1. Listar por leitura os anônimos criados entre o início e o fim da janela.
2. Apagar esses usuários pelo painel de Auth ou pela Admin API (cascade da 0100).
3. Apagar o `creator_invite` usado.
4. Conferir as contagens em 0 e o `07`.

### Orçamento entre processos (controle operacional; preservado do 02C.4E)

O contador do harness é **por processo**. O saldo passado em `ORYN_IT_IDENTITY_BUDGET` é calculado e
registrado na pasta da janela antes de **cada** `pnpm test:remote`:
1. Ler `auth.users` com `is_anonymous` e `created_at` ≥ `T0` (identidades **criadas**).
2. Somar as tentativas **sem criação** já feitas: 1 por C1 executada (o #5 negativo).
3. `saldo = 10 − (1) − (2)`. Na sequência normal: C1 = **10** (0 − 0), C2 = **8** (10 − 1 − 1).

O portão recusa um saldo menor que o da fase (C1 = 2, C2 = 8).

**Reexecução dentro da mesma janela: não permitida (02C.4F.1).** Falha vai para o passo 8. Uma nova
tentativa exige **nova janela** (passos 0–8 de novo), com a limpeza da anterior autorizada e concluída antes,
e o saldo recalculado do zero. Ampliar o teto de 10 é decisão do arquiteto.

### Critérios de interrupção (02C.4F; todos levam **direto ao passo 8**)

| # | Condição |
|---|---|
| I1 | Qualquer item do passo 0 diferente do esperado, ou 0b com V1/V2/V3 sem PASS (aqui: NO-GO, a janela nem abre) |
| I2 | O portão do harness abortar por motivo inesperado, ou `IdentityBudgetExceeded` |
| I3 | #5 negativo **aceito** (CAPTCHA não exigido) ou #5 positivo **recusado** (secret errado). A C2 não começa. |
| I4 | Anônimos com `created_at ≥ T0` diferentes do esperado (≠ 1 depois da C1; ≠ 9 depois da C2): a mais indica cadastro de terceiros com o CAPTCHA nominal; a menos indica falha não detectada |
| I5 | D0 sem a partição de hoje |
| I6 | `SUBSCRIBED` indevido (S2, S3, S5, S6, S7, A1, A2) ou entrega a cliente não autorizado (P1–P3, D3) |
| I7 | Evento `signal` ou chave de payload fora de `{id, session_id, label}` em `realtime.messages` (auditoria) |
| I8 | Mudança em `oryn_scope`, `platform`, políticas ou histórico, ou surgimento de `cli_login_*` |
| I9 | Token, JWT ou chave aparecendo em saída, arquivo ou chat |
| I10 | `T0 + 30 min` atingido; convite expirado ou consumido sem C2 válida; exit ≠ 0 em qualquer fase |

I7 e I8 aparecem na auditoria, que já roda depois da restauração: registrar e levar ao arquiteto antes de
qualquer limpeza.

## 11. Fidelidade dos ambientes de teste (02C.2B)

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

## 12. C0 (sem identidade) e C2 com contas preexistentes (02C.5B; ⛔ cada execução exige autorização própria)

Caminho **sem alterar Auth nem CAPTCHA** e sem infraestrutura paga. Usa `Clear-OrynEnv` (§10) e o mesmo cuidado
com credenciais: digitadas, nunca salvas, nunca em log.

| Fase | O que roda | Efeito remoto | Cadastros / logins |
|---|---|---|---|
| **C0-R** | Z1 (Auth: anônimo desligado, só leitura), Z2 (12 RPCs recusadas por permissão, `42501`), Z3 e Z4 (Data API: `PGRST106`) | só leituras e recusas | 0 / 0 |
| **C0-W** | só Z6–Z8 (02C.6A: filtro `-t C0-W`); recusa de canal para `anon`: oryn privado e qualquer privado (`Unauthorized`), qualquer público (`PrivateOnly`) | **cria as partições** de `realtime.messages` (1ª conexão) | 0 / 0 |
| **C2 password** | todo o bloco de sala, menos o #15 (precisa de 5 identidades novas) | sala, sessões, eventos `hello`/`bye`, convite consumido | 0 / 3 |

Z5 (Broadcast REST com a chave publicável) está **desabilitado**: não há controle positivo sem identidade.

### Executor da C0 (02C.6A)

C0-R e C0-W rodam pelo executor versionado `integration/scripts/oryn-c0.ps1`, num processo próprio do
PowerShell 7. Ele substitui o bloco colado à mão, que falhou na 1ª C0-R por causa do console (02C.5C).

| Garantia | Como |
|---|---|
| Só o commit aprovado | `-ApprovedCommit <sha>` obrigatório. Branch, HEAD e árvore limpa conferidos antes de qualquer pergunta |
| Ambiente limpo | Nenhuma `ORYN_*`, `*CAPTCHA*` ou credencial administrativa antes; o conjunto exato de `ORYN_*` da fase depois de preencher; `Clear-OrynEnv` no `finally` |
| Só o bloco do modo | `-t C0-R` ou `-t C0-W` (Vitest). Validado offline com a rede bloqueada: `-t C0-W` executa só Z6–Z8 |
| Pasta de evidências | `integration/evidence/c0-r-…` ou `c0-w-…` (UTC; `-2`, `-3`, nunca sobrescreve), criada **antes** do relatório. Precisa ser ignorada pelo Git |
| Exit code | Lido logo depois do pipeline, com `PSNativeCommandUseErrorActionPreference = $false`; gravado em `horario.txt` (`ausente` se não houver) |
| Relatório legível | Console em UTF-8 e `NO_COLOR=1` durante a execução, com restauração depois. O validador ainda remove ANSI e repara a cp850 |
| Validação | Exatamente os Z do modo com `✓`, 0 falhas, nada aprovado fora do bloco. Exit 0 **sozinho** nunca basta. C0-W: motivo exato por Z; resultado PASS, INCONCLUSIVO ou FALHOU (02C.6E) |
| Sigilo | Só contagens de padrões sensíveis; quarentena do bruto se houver; compartilhar só `*.resumo.txt` e `horario.txt` |

Autoteste offline (sem rede, sem Supabase), a rodar antes de cada autorização:
`pwsh -NoProfile -File integration/scripts/oryn-c0.selftest.ps1`

### 12.1 C0-R ⛔ (autorização simples: só leituras e recusas)

Antes: contagens de dados e `07` (§10, passo 0, linhas de estrutura e dados).

```powershell
pwsh -NoProfile -File integration/scripts/oryn-c0.ps1 -Mode R -ApprovedCommit <sha aprovado>
```

Esperado: **4 PASS** (Z1–Z4); o resto pulado ou `todo`. Z1 falhando por "campo ausente" é **inconclusivo**:
conferir o anônimo no painel. Depois, a leitura tem de mostrar 0 usuários, 0 mensagens, 0 partições e o
`07` igual. Executada em 2026-10-27 (02C.5C) e auditada (02C.5D).

### 12.2 C0-W ⛔ (autorização **explícita**: abre WebSocket e cria as partições)

**1ª execução (2026-10-27, `2e195b2`; evidência 02C.6D):**

| Teste | Observado | Reclassificado (02C.6E) |
|---|---|---|
| Z6 | `CHANNEL_ERROR (MissingPartition: …)`, 4,98 s | **INCONCLUSIVO**: o critério antigo aprovou indevidamente |
| Z7 | `SUBSCRIBED`, 146 ms | **FAIL**: o Realtime avaliou `private_only = false` |
| Z8 | `CHANNEL_ERROR (Unauthorized: …)`, 4,23 s | **PASS** |

- A Z9 passou: 5 partições de 26 a 30/10, banco íntegro.
- Nos logs do Realtime, o tenant inicializou às 02:36:30.552 ("Creating partitions") e o `MissingPartition` do Z6
  veio 178 ms depois.
- A chave publicável foi **aceita** como credencial. Nenhuma recusa foi por credencial.

**Pré-condições** (todas; senão, não executar). Uma nova C0-W exige **autorização separada**:
1. C0-R aprovada e auditada.
2. Autorização explícita da C0-W. O executor pede que o operador digite `C0-W`.
3. **Configuração efetiva `private_only = true`**, lida (não só declarada) no terminal do operador. O token
   pessoal nunca vai para o ambiente do harness:
   ```powershell
   $pat = [Net.NetworkCredential]::new('', (Read-Host 'PAT do Supabase' -AsSecureString)).Password
   try { (Invoke-RestMethod -Headers @{ Authorization = "Bearer $pat" } `
          -Uri 'https://api.supabase.com/v1/projects/<ref>/config/realtime').private_only }
   finally { Remove-Variable pat }
   ```
   - Mais a captura do painel (Realtime › Settings, "Allow public access" **desligado**) depois de recarregar a página.
   - Se vier `false`: alterar é escrita (autorização própria). Depois, ler de novo.
   - Se vier `true` e o Z7 da 1ª execução tiver entrado: suspeita de cache do tenant no Realtime. Esperar e
     registrar o horário da leitura.
4. Leitura de **antes**: `integration/sql/11_c0w_postflight.sql`.
   - Antes da 1ª C0-W: tudo PASS, menos o item 1, que dá **FAIL com 0**, como esperado.
   - Depois dela: tudo PASS enquanto houver partição de hoje.
   - Mais o `07`.
5. Autoteste do executor: 0 FAIL. Commit aprovado com as correções do 02C.6E.

```powershell
pwsh -NoProfile -File integration/scripts/oryn-c0.ps1 -Mode W -ApprovedCommit <sha aprovado>
```

O que cada teste faz (cada um com um cliente novo, só a chave publicável, papel `anon`):

| Teste | Tópico | Canal | Operação |
|---|---|---|---|
| Z6 | `oryn:s:<uuid aleatório>` | privado | `subscribe` (entrada no canal) |
| Z7 | `it-c0-<execução>` | **público** (`private: false`) | `subscribe` |
| Z8 | `it-c0-<execução>-p` | privado | `subscribe` |

- Nenhum teste publica (`send`, `httpSend`, Presence), cria identidade, faz login ou usa papel
  administrativo. Isso é garantido por teste estático: `tests/remote-harness-c0.test.ts`.
- Canal recusado é removido na hora, sem novas tentativas. O socket fecha quando o cliente fica sem canais, e o
  `afterAll` remove todos.

**Critérios (02C.6E).** As regras de classificação estão em `tests/remote/realtime-refusals.json` (fonte única
do harness e do executor). A resposta do servidor tem o formato `<Código>: <mensagem>`. Código **e** mensagem
precisam bater:

| Teste | O que prova | PASS **somente** com |
|---|---|---|
| Z6 | RLS: `anon` não lê `oryn:s:*` | `CHANNEL_ERROR` do servidor com `Unauthorized: You do not have permissions to read from this Channel topic…` |
| Z7 | **Configuração** do projeto: canal público desligado (não passa pelo RLS) | `CHANNEL_ERROR` do servidor com `PrivateOnly: This project only allows private channels` |
| Z8 | RLS: `anon` não lê tópico privado qualquer | igual ao Z6 (`Unauthorized`) |

| Resultado | Veredito do Z |
|---|---|
| Motivo esperado | **PASS** |
| `SUBSCRIBED`, ou o outro motivo de acesso (`PrivateOnly` onde se espera `Unauthorized`, e vice-versa) | **FAIL**: o servidor decidiu errado |
| Credencial (`InvalidJWTToken`, `MalformedJWT`, `JwtSignatureError`, `JwtSignerError`) | **INCONCLUSIVO** |
| Infraestrutura (`MissingPartition`, `InitializingProjectConnection`, `RealtimeRestarting`, limites de taxa…) | **INCONCLUSIVO** |
| Código ou mensagem desconhecidos; `TIMED_OUT` (10 s), `NO_REPLY` (12 s), `CLOSED`, transporte | **INCONCLUSIVO** |

- O harness anota `[motivo=…; esperado=…; veredito=…]`. O executor reclassifica pelo texto e exige coerência
  entre o marcador do Vitest, a anotação e o motivo.
- **Resultado da execução:**
  - `PASS` (saída 0) com os 3 Z PASS;
  - `FALHOU` (saída 1) com algum FAIL, que prevalece;
  - `INCONCLUSIVO` (saída 2) quando não há FAIL, mas algum Z ficou sem decisão.
- **Nada é repetido automaticamente.** INCONCLUSIVO pede análise e nova autorização.
- O mesmo rigor vale na C2:
  - #6/S4, S2/S3, S6 (anon), S7, A1, A2/A3 exigem `Unauthorized`;
  - #7/S5 exige `PrivateOnly`;
  - S8/P5, se recusado, exige `Unauthorized`.

**Risco: `MissingPartition` na inicialização do tenant.**
- O Realtime cria as partições de forma **assíncrona** quando o tenant inicializa (1ª conexão, ou depois de
  ficar ocioso).
- Uma entrada em canal privado nesse intervalo pode receber `MissingPartition`, que não é decisão de acesso.
- No teste, isso conta como INCONCLUSIVO. No produto, o cliente precisa repetir a entrada com espera progressiva.
- O risco diminui com as partições já criadas (até 30/10 na 1ª execução), mas reaparece se o tenant reinicializar
  sem a partição do dia.

Esperado: **3 PASS** (Z6–Z8), nada mais aprovado.

**Efeitos no Supabase:**
- **Esperados** (operacionais do Realtime): as partições diárias `realtime.messages_AAAA_MM_DD` e seus
  índices, criados na 1ª conexão. Ficam **fora** dos dois fingerprints por construção.
- **Indevidos:** qualquer linha em `realtime.messages`; qualquer usuário, sessão, sala ou convite; fingerprint
  diferente; migração nova; `cli_login_*`. Qualquer um deles = **FAIL** e investigação antes da C2.

**Z9 (leitura de depois)**, com a autorização de leitura: `integration/sql/11_c0w_postflight.sql` e `07`.
- Itens 1–11 PASS. O item 1 é a partição cobrindo **agora** (UTC) = D0.
- Partições só no padrão `messages_AAAA_MM_DD`.
- `07` igual ao baseline.
- Se a C0-W passar **sem** criar partição (item 1 FAIL depois), a segurança está provada, mas a premissa D0
  não: a C2 fica bloqueada até um novo diagnóstico.

**As partições criadas aqui atendem ao D0 da C2 no mesmo dia (UTC).** O Realtime remove as antigas, então no dia
seguinte é preciso refazer o D0.

### 12.3 C2 com contas preexistentes ⛔

Pré-requisitos, nesta ordem:
1. C0-R e C0-W com PASS, e Z9 registrado. A partição de hoje existe; no dia seguinte, refazer o D0.
2. Z1 anotou `external.email = true`: o login por e-mail está habilitado. Senão: **parar** (habilitar é mudança no Auth, fora deste caminho).
3. ⛔ O operador cria **3 contas confirmadas** no painel (Auth › Users › Add user › e-mail e senha, com
   confirmação automática): dono, membro e estranho. Endereços de teste controlados pela equipe; senhas
   longas e aleatórias; **nada** registrado fora do gerenciador de senhas do operador.
4. ⛔ Convite de criador (§10, passo 5), logo antes da execução.

```powershell
$dir = 'integration/evidence/c2pw-<AAAAMMDD-HHMM>'
New-Item -ItemType Directory -Path $dir -ErrorAction Stop | Out-Null   # 02C.6A: o Tee-Object não cria a pasta
function Read-Secret([string]$prompt) { [Net.NetworkCredential]::new('', (Read-Host $prompt -AsSecureString)).Password }
$env:NO_COLOR = '1'; [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)   # relatório sem ANSI nem cp850
try {
  $ref = Read-Host 'ref do projeto'
  $env:ORYN_REMOTE = '1'; $env:ORYN_REMOTE_REF = $ref
  $env:ORYN_SUPABASE_URL = "https://$ref.supabase.co"
  $env:ORYN_PUBLISHABLE_KEY = Read-Host 'chave publicável'
  $env:ORYN_IT_PHASE = 'C2'
  $env:ORYN_IT_IDENTITY = 'password'                             # sem cadastro e sem CAPTCHA; 3 logins
  foreach ($role in 'OWNER', 'MEMBER', 'STRANGER') {
    Set-Item -Path "Env:ORYN_IT_USER_${role}_EMAIL" -Value (Read-Host "e-mail $role")
    Set-Item -Path "Env:ORYN_IT_USER_${role}_PASSWORD" -Value (Read-Secret "senha $role")
  }
  $env:ORYN_IT_PARTITIONS_CONFIRMED = '1'                        # declaração do operador (Z9/D0)
  $env:ORYN_IT_CREATOR_INVITE = Read-Secret 'convite de criador'
  pnpm test:remote --reporter=verbose 2>&1 | Tee-Object -FilePath "$dir/c2pw.txt"
  $c2Exit = $LASTEXITCODE
} finally {
  Clear-OrynEnv                                                  # remove também ORYN_IT_USER_*
}
"C2 password exit = $c2Exit"
```

O harness encerra só a sessão local de cada conta no fim (`signOut` com escopo local).

Esperado: **16 PASS** e o #15 pulado (`modo password`). O **subconjunto mínimo** que precisa passar para valer
como primeira prova autenticada:

| Verificação | Testes |
|---|---|
| Entrada autorizada em canal privado | S1, A4 |
| Recusa para usuário não autorizado | S2/S3 (membro e estranho), S5, S6, S7 |
| Criação e encerramento de sessão | A1 (join → assinável → leave → recusado + `session-invalid`) |
| `hello` e `bye` | D1, D2 |
| Bloqueio de publicação pelo cliente | P1 (WebSocket), P2/P3 (REST), com controle positivo |

Nada disso está comprovado até a execução. Depois, a auditoria do §10, passo 7: N3/N4, `06`, `07` e advisors.
Conferir que `Select-String -Path "$dir/*" -Pattern 'eyJ|sb_(publishable|secret)_'` vem vazio. As senhas não
aparecem no relatório: o harness não as imprime, e as mensagens de erro citam só o papel.

### 12.4 Riscos e limpeza

- **Contas preexistentes:** são credenciais de longa duração. Depois da campanha, **trocar as senhas** ou apagar
  as contas (painel; escrita autorizada). Apagar as contas remove, pelo cascade da 0100, a sala, os membros,
  as sessões, o `signal_log` e o `pair_counters`; o `creator_invite` usado sai à parte (§10, passo 9).
- **D1:** as políticas tratam `authenticated` igual com ou sem `is_anonymous`; está testado localmente e é a
  premissa deste caminho. O fluxo anônimo com CAPTCHA (#5) continua dependendo da janela do §10.
- **Reexecução: não é automática.** Sem orçamento de cadastro em jogo, a C2 password pode ser repetida, mas:
  - cada execução consome um **convite de criador novo** (autorização) e deixa outra sala `it-02c4b-*` **aberta**,
    porque não há RPC de fechar sala (F5 da 0200);
  - o convite `admin_issue_creator_invite(10, 1)` concede **1 sala aberta**. Com a mesma conta de dono, a 2ª
    execução **falha** no `beforeAll` (`create_room` → `limit-reached`).

  Para repetir, escolher uma (decisão do arquiteto):
  - (a) emitir o novo convite com o limite acumulado (`admin_issue_creator_invite(10, <n.º de execuções>)`; a
    concessão usa o maior valor, até 5);
  - (b) apagar a sala anterior (escrita autorizada);
  - (c) recriar a conta do dono.
