# POC-02C — Checklist de implantação (02C.2C.1)

**Estado: preparado, nada executado.** Cada item marcado com ⛔ exige autorização explícita do arquiteto,
dada **por etapa**. As consultas marcadas com 🔎 são somente leitura. O ref do projeto não fica neste
arquivo (repositório público): ele é digitado no terminal como `<PROJECT_REF>`.

Complementa `RUNBOOK-02C.1B.md` (fases 0–6) e `EVIDENCE-02C.1B.md` (matriz dos 18 testes).

## 0. Estado inicial confirmado (leitura, 2026-10-23, 02C.2C)

| Item | Valor |
|---|---|
| Git | `poc/webrtc-audio-supabase` @ `420b697` = `origin`; CI verde no Ubuntu e no Windows |
| Projeto | `oryn`, ACTIVE_HEALTHY, PostgreSQL 17.11 |
| Migrações, Edge Functions e branches | 0 / 0 / 0; `supabase_migrations` não existe |
| Dados | `auth.users` = 0; nenhum schema `oryn*`; `public` sem funções e sem tabelas |
| `realtime.messages` | dono `supabase_realtime_admin`, RLS ligado, **0 partições**, 0 políticas |
| Advisors de segurança | 0 avisos |

**Consequência do estado vazio:**
- não há dados de usuário a perder;
- reverter significa voltar exatamente a este estado, e o pré-voo P2/P3/P7 vazio prova isso.

## 1. Pré-condições globais (todas, antes da Etapa 1)

- [ ] Autorização ⛔ do arquiteto para a Etapa 1 (as Etapas 2 e 3 têm autorização própria).
- [ ] `HEAD` aprovado, igual ao `origin`, árvore limpa, CI verde nesse commit.
- [ ] 🔎 `list_migrations`, `list_edge_functions` e `list_branches` = 0/0/0 **no momento** da aplicação.
- [ ] 🔎 `integration/sql/00_preflight.sql` (SQL editor) igual ao esperado revisto no 02C.2B. P5: `rls_enabled = true`, `policy_grant = true`.
- [ ] Integração GitHub sem mudança: Working directory `.`, Deploy to production desligado.
- [ ] Registro do schema antes da aplicação (só leitura): `supabase db dump --project-ref $ref -s public,realtime -f integration/evidence/pre-schema.sql`. A pasta fica fora do Git.
- [ ] Workdirs temporários `step1`, `step2` e `step3` preparados (runbook, Fase 3), com as 1, 2 e 3 primeiras migrações.
- [ ] Mesmo método nas três etapas: `supabase db push --skip-vault`. Nunca `apply_migration` do MCP nem o SQL editor.

## 2. Etapas

Cada etapa é **independente**:
- tem autorização própria;
- aplica uma única migração;
- termina com verificação somente leitura;
- pode ser revertida sozinha, porque o `90_rollback.sql` é idempotente e funciona depois de qualquer etapa (testado nos 3 cenários).

**Verificação comum depois de cada etapa:**
- 🔎 `integration/sql/05_step_checks.sql`: aprova com nenhuma linha `FAIL` e nenhuma `PENDING` com `step ≤ N`.
- 🔎 Histórico: `select version from supabase_migrations.schema_migrations order by version;` deve ter exatamente as N versões aplicadas.
- 🔎 `get_advisors` (segurança e performance): nenhum aviso de nível ERROR.

### Etapa 1 — `20261023000100_oryn_schema.sql` ⛔

**O que faz:**
- cria o schema `oryn` e 8 tabelas, com RLS ligado e nenhuma política;
- revoga tudo de `PUBLIC`, `anon`, `authenticated` e `service_role`;
- privilégios padrão do schema `oryn` revogados.

| | |
|---|---|
| Comando | `supabase --workdir "$base\step1" db push --project-ref $ref --skip-vault --dry-run`; depois o mesmo **sem** `--dry-run` |
| `--dry-run` aprova se | lista **só** `20261023000100` |
| 🔎 Verificação específica | `select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public';` = **0**; `select count(*) from pg_policies where schemaname = 'realtime' and policyname like 'oryn_%';` = **0** |
| **Aprova** | 05: passo 1 todo PASS (8 tabelas, RLS ligado, dono `postgres`, nenhum privilégio nem USAGE de cliente); histórico = 1 versão; nada fora do esperado |
| **Interrompe** | qualquer erro da CLI; FAIL no passo 1; histórico ≠ 1; qualquer privilégio de `anon` ou `authenticated` em `oryn` |
| Reversão ⛔ | `90_rollback.sql` (apaga `oryn`, linha 0100 do histórico) |

### Etapa 2 — `20261023000200_oryn_functions.sql` ⛔

**O que faz:**
- cria as 12 RPCs `SECURITY DEFINER` em `public` e as funções internas em `oryn`;
- cria `oryn_realtime.can_receive_topic`;
- revoga e concede EXECUTE conforme o contrato.

| | |
|---|---|
| Comando | `--workdir "$base\step2"`, mesmos flags; `--dry-run` deve listar **só** `20261023000200` |
| 🔎 Verificação específica | `select has_function_privilege('anon', 'public.join_room(uuid)', 'EXECUTE');` = **false**; `select has_function_privilege('authenticated', 'public.set_signal_state(uuid,text)', 'EXECUTE');` = **false**; políticas `oryn_*` em `realtime.messages` continuam **0** |
| **Aprova** | 05: passos 1 e 2 todo PASS (exatamente 12 funções em `public`, todas DEFINER com `search_path` vazio; `anon` sem EXECUTE; `set_signal_state` só para `service_role`); histórico = 2 |
| **Interrompe** | erro; FAIL; qualquer função extra em `public`; EXECUTE de `anon` ou de `PUBLIC` em qualquer função da Oryn |
| Reversão ⛔ | `90_rollback.sql` (apaga RPCs, `oryn_realtime`, `oryn` e as linhas 0100/0200) |

### Etapa 3 — `20261023000300_oryn_realtime.sql` ⛔

**O que faz:**
- **confere** que `realtime.messages` tem RLS. Se não tiver, para inteira, com `oryn-0300: RLS desligado…`;
- cria 4 políticas (3 restritivas);
- não altera a tabela.

| | |
|---|---|
| Comando | `--workdir "$base\step3"`; `--dry-run` deve listar **só** `20261023000300` |
| 🔎 Verificação específica | `select relrowsecurity, pg_get_userbyid(relowner) from pg_class where oid = 'realtime.messages'::regclass;` = `true`, `supabase_realtime_admin` (**inalterado**) |
| **Aprova** | 05: passos 1–3 todo PASS; histórico = 3; depois, **`01_postflight.sql` com zero FAIL** (seção 3) |
| **Interrompe** | erro (inclusive `oryn-0300: …`); dono ou RLS de `realtime.messages` diferente; número de políticas ≠ 4 |
| Reversão ⛔ | `90_rollback.sql` (também apaga as 4 políticas; RLS e dono ficam como o Supabase entregou) |

## 3. Pós-voo final (depois da Etapa 3)

- 🔎 `integration/sql/01_postflight.sql`: **zero FAIL**.
- Resolver cada `NOT VERIFIED`:
  - Data API: repetir o #3 por HTTP;
  - "Allow public access": painel e teste #7.
- Copiar as linhas `INFO` para a evidência.
- 🔎 Advisors de novo.
- Os testes reais (passo 5 do plano da 02C.2C) ficam **bloqueados** até a seção 6 ser resolvida.

## 4. Auditoria das funções `SECURITY DEFINER` em `public`

Origem dos dados: catálogo do PGlite e do PostgreSQL 17.10 depois das migrações, mais leitura do código da `0200`.
- **Em todas as 12:** `SECURITY DEFINER` e `search_path = ''`, nomes qualificados, nenhum SQL dinâmico.
- **EXECUTE:** só o papel indicado. Nem `anon` nem `PUBLIC`, inclusive por herança: `tests/sql-definer-audit.test.ts`.

| Função | EXECUTE | Identidade do chamador | Autorização por sala/sessão | Risco entre usuários |
|---|---|---|---|---|
| `redeem_creator_invite` | authenticated | `require_uid()` | convite de criador de uso único (hash), consumo atômico | nenhum (token de 244 bits; erro genérico) |
| `create_room` | authenticated | `require_uid()` | concessão de criador **travada**; limite de salas abertas | nenhum |
| `create_room_invite` | authenticated | `require_uid()` | **dono** da sala, membro ativo, sala aberta, vaga, ≤ 3 pendentes; sala travada | nenhum |
| `revoke_room_invite` | authenticated | `require_uid()` | **dono** da sala | nenhum |
| `redeem_room_invite` | authenticated | `require_uid()` | convite e sala travados; capacidade; já-membro não consome | baixo: `already-member` só confirma a validade de um token para quem **já é membro** daquela sala |
| `join_room` | authenticated | `require_uid()` | membro ativo, conferido de novo **com a linha de membro travada** (M5); limite de 2 sessões | nenhum; só expira as próprias sessões |
| `touch_session` | authenticated | `require_uid()` | **própria** sessão, travada, de membro ativo | nenhum |
| `leave_room` | authenticated | `require_uid()` | **própria** sessão, travada | nenhum |
| `get_roster` | authenticated | `require_uid()` | membro ativo da sala | por desenho, revela `session_id` e rótulo dos participantes **da mesma sala** (necessário para sinalizar) |
| `authorize_signal` | authenticated | `require_uid()` | sessão **própria**, travada, viva, de membro ativo; destino vivo da **mesma** sala | baixo: chamável direto (a Edge Function usa o JWT do usuário); só cria registros sem payload nos **próprios** pares e gasta o próprio limite |
| `ack_signals` | authenticated | `require_uid()` | **própria** sessão não revogada; só mensagens destinadas a ela e `published` | baixo: não exige batimento; dois `ack` simultâneos da mesma sessão com listas sobrepostas em ordem diferente poderiam se travar (sem efeito entre usuários) |
| `set_signal_state` | **service_role** | não usa `auth.uid()` (servidor confiável) | só transições válidas, até 5 tentativas | nenhum para clientes (sem EXECUTE) |

Fora de `public`:
- `oryn_realtime.can_receive_topic` (DEFINER, `search_path` vazio, EXECUTE só para `authenticated`) só responde se **o próprio** `auth.uid()` é dono de uma sessão viva de membro ativo em sala aberta;
- as funções internas de `oryn` não têm EXECUTE de cliente.

Comprovado por testes:
- 32 chamadas indevidas recusadas sem efeito colateral, com RLS ligado e **desligado** (`sql-definer-audit`);
- corridas em PostgreSQL 17 real (`tests/pg`).

## 5. Usuário anônimo autenticado × papel SQL `anon`

- **Usuário anônimo** (`signInAnonymously`): o JWT tem `role = authenticated` e `is_anonymous = true`. Para o Postgres, é `authenticated`. É a identidade normal da Oryn (D1).
- **Papel `anon`**: só a chave publicável, **sem** JWT de usuário.

| Regra | `authenticated` (inclui anônimos) | `anon` |
|---|---|---|
| RPCs | as 11 de usuário, autorizadas por convite e sessão | **nenhuma** (sem EXECUTE) |
| Ler `oryn:s:{sessão}` | só a própria sessão viva (`oryn_receive_own_session_topic` + `oryn_topics_read_guard`) | **nunca** (`oryn_topics_read_guard_anon`, sem depender de função) |
| Escrever em `oryn:*` | **nunca** (`oryn_topics_no_client_write`, sem diferenciar maiúsculas) | **nunca** (mesma política) |
| `is_anonymous` | **não é critério**: as políticas não leem essa claim | — |

Testes (`tests/sql-anon-roles.test.ts`):
- as políticas usam só esses papéis e não leem `is_anonymous`;
- o usuário anônimo com convite funciona;
- o mesmo usuário com `is_anonymous = false` tem a mesma autorização;
- `anon` com o **`sub` de um membro forjado** nas claims não executa RPC, não lê o tópico e não escreve, nem em maiúsculas.

## 6. Configurações de Auth, CAPTCHA, Realtime e JWT

### 6a. Inspeção (somente leitura; pode ser feita já)

| Item | Como inspecionar | Valor conhecido (02C.2C) | Esperado |
|---|---|---|---|
| Provedores de Auth | 🔎 `GET /auth/v1/settings` com a chave publicável | **só `email` ligado; anônimo desligado**; `disable_signup = false`; `mailer_autoconfirm = false` | anônimo ligado; e-mail desligado |
| CAPTCHA | painel: Authentication › Attack Protection | não legível por API pública | Turnstile ligado (B5) |
| Rate limit de anônimos | painel: Authentication › Rate Limits | não legível | 30/h por IP (ou menor) |
| Expiração do JWT | painel: JWT Keys / Sessions | não legível | 600 s |
| Chave de assinatura | 🔎 `GET /auth/v1/.well-known/jwks.json` | **ES256 (assimétrica)** | ES256: ok para `verify_jwt` (documentação) |
| Chaves de API | 🔎 MCP `get_publishable_keys` (só tipo e estado); painel › API Keys para `sb_secret_` | `anon` legada **ativa** + `sb_publishable_` ativa; `sb_secret_` não verificada | `sb_publishable_` + `sb_secret_`; legadas desativadas antes de produção |
| Data API | 🔎 HTTP com `Accept-Profile` (teste #3) | só `public`, `graphql_public` (**PASS**) | igual; repetir depois das migrações |
| Realtime "Allow public access" | painel: Realtime › Settings | não legível | **desligado** |
| Partições de `realtime.messages` | 🔎 `select count(*) from pg_inherits where inhparent = 'realtime.messages'::regclass` | **0** | > 0 antes do teste #11 (criadas pelo serviço Realtime; NOT VERIFIED) |
| Integração GitHub | painel: Integrations | Working directory `.`, Deploy to production desligado (usuário) | igual |

### 6b. Alterações futuras ⛔ (não autorizadas; cada uma com captura antes e depois)

1. **Ligar o login anônimo** (Authentication › Providers › Anonymous). Pré-requisito de todos os testes reais com cliente.
2. **Desligar o cadastro por e-mail** (Providers › Email). O D1 não prevê identidade por e-mail. O `config.toml` **não** aplica isso em produção.
3. **CAPTCHA Turnstile** (B5). No ambiente de teste, decidir entre a chave de teste do Turnstile e o desligamento temporário. **Nunca** deixar o login anônimo aberto sem CAPTCHA em produção.
4. **Expiração do JWT = 600 s**: limita a janela da autorização em cache do Realtime (teste #12).
5. **Realtime: desligar "Allow public access"**, antes do teste #7.
6. **Rate limit de anônimos**: confirmar 30/h ou reduzir.
7. **Antes de produção:** desativar as chaves legadas (`anon` e `service_role`) depois de confirmar que nada depende delas.

Ordem sugerida para o dia dos testes:
- itens 1, 2, 3 e 5, antes do harness;
- item 4, antes do #12;
- item 7 só no fechamento.

## 7. Limitações de recuperação

- **Plano Free:** sem backup baixável e sem PITR. A recuperação é **lógica**, pelo `90_rollback.sql`.
- **O que o `90_rollback.sql` reverte** (testado depois de cada etapa, com reaplicação limpa):
  - schemas `oryn` e `oryn_realtime`, com tudo dentro;
  - as 12 RPCs;
  - as 4 políticas;
  - as linhas de histórico 0100–0300.
  - RLS e dono de `realtime.messages` ficam como o Supabase entregou.
- **O que NÃO reverte:**
  - usuários de teste em `auth.users` e seus tokens (apagar pelo painel);
  - mensagens `hello`/`bye` retidas em `realtime.messages` por 3 a 4 dias;
  - logs da plataforma, da API e do Postgres;
  - contadores de rate limit do Auth;
  - configurações do painel e secrets alterados;
  - versões já publicadas de Edge Functions.
- **Estado inicial vazio:** com 0 usuários e 0 objetos da Oryn, o impacto de uma falha nas Etapas 1–3 é só o schema da própria POC. O alvo da recuperação é o estado da seção 0.
- **Fora do escopo lógico** (por exemplo, corrupção de objetos do Supabase): o SQL não resolve, e a decisão é do arquiteto. Recriar o projeto não está autorizado.
