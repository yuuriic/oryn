# POC-02C — Sinalização WebRTC por Supabase Realtime

Prova de conceito **descartável** do Oryn. Substitui o servidor Node de sinalização da POC-02B por Supabase:
- Auth anônimo;
- Postgres com RLS;
- canais privados do Realtime;
- Edge Function `signal`.

A mídia continua WebRTC P2P, e o Cloudflare TURN entra só como relay. Contrato e decisões: relatórios
POC-02C.0 e 02C.0A (D1 a D4).

## Estado: incrementos 02C.1A e 02C.1A.1 — fundação local revisada

- **Feito:** contratos TypeScript, migrações SQL, políticas RLS restritivas, RPCs de domínio, esqueleto da Edge
  Function `signal` e testes automatizados.
- **Não feito (por decisão):** nenhum projeto Supabase, Vercel ou Cloudflare foi criado; nenhum deploy;
  nenhuma credencial.
- **Testes de autorização:** rodam em **Postgres real em memória (PGlite 0.5.11, Postgres 18)** com um **shim**
  das peças do Supabase (`tests/helpers/supabase-shim.sql`). As migrações rodam como **dono não
  superusuário** (`migration_owner`, como o `postgres` do Supabase), para que as funções `SECURITY DEFINER`
  executem com privilégios realistas.
- **CI:** `.github/workflows/poc-02c-ci.yml` (02C.1A.1). Roda instalação congelada, typecheck, testes e audit,
  sem segredos e sem deploy.
- **Comportamento do Supabase real:** **NOT VERIFIED** (`tests/integration.pending.test.ts`, 17 itens `todo`: os 15
  do 02C.1A mais 2 da revisão).
- **02C.1B.0A (correções locais):**
  - Edge Function com credenciais separadas (B1);
  - secrets sem nomes reservados (B2);
  - `supabase/config.toml` com a função travada (`enabled = false`; B3);
  - auditoria das RPCs `SECURITY DEFINER`;
  - harness remoto desligado por padrão.

## Comandos

```powershell
cd "C:\Dev\Projeto - Oryn\poc\webrtc-audio-supabase"
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test        # unitários + autorização SQL (PGlite); itens do Supabase real aparecem como "todo"
pnpm test:remote # Supabase REAL: tudo pulado sem ORYN_REMOTE=1 (ver integration/RUNBOOK-02C.1B.md, §9)
```

Requisitos: Node 24+ e pnpm 12+. Não há serviço a instalar: o PGlite é uma biblioteca (dependência de
desenvolvimento).

## Estrutura

| Caminho | Conteúdo |
|---|---|
| `supabase/migrations/…0100_oryn_schema.sql` | Schema privado `oryn`: salas, membros, convites, sessões, contadores e registro de sinais **sem payload**. RLS ligado, nenhuma política, nenhum privilégio |
| `supabase/migrations/…0200_oryn_functions.sql` | RPCs `SECURITY DEFINER` (`search_path = ''`) e `EXECUTE` explícito |
| `supabase/migrations/…0300_oryn_realtime.sql` | Políticas de `realtime.messages`: receber só no próprio tópico; **nenhum envio de cliente** em `oryn:*` |
| `supabase/functions/_shared/` | Contrato da sinalização e núcleo da Edge Function (puros e testados) |
| `supabase/functions/_shared/edge-config.ts`, `supabase-http.ts`, `signal-http.ts` | Credenciais, chamadas HTTP com headers separados por operação e camada HTTP/CORS (puros e testados) |
| `supabase/functions/signal/index.ts` | Só a ligação Deno dos módulos de `_shared`. **Não executado**; fora do typecheck |
| `supabase/config.toml` | CLI 2.122.0: Data API só `public`, sem seed, JWT de 600 s, função `signal` travada (`enabled = false`) |
| `tests/remote/` | Harness do Supabase real (`pnpm test:remote`), desligado por padrão |
| `integration/` | Runbook, matriz de evidências e scripts SQL do 02C.1B |
| `src/` | Cliente: contratos de domínio, recepção (duplicatas e ordem) e envio com retentativas |
| `tests/` | Testes; `helpers/` com o shim, o banco PGlite e os cenários |

## Modelo de segurança

- **Identidade:** Supabase Auth anônimo (D1). Uma conta anônima **sozinha não alcança nada**: toda RPC exige
  convite resgatado ou sessão própria.
- **Primeira sala:** só quem resgatou um **convite de criador**. O convite é emitido **somente pelo
  administrador do projeto** no SQL editor:
  `select oryn.admin_issue_creator_invite(60, 2);`. O token aparece uma vez e só o hash fica guardado. Cada
  criador pode ter até 2 salas abertas.
- **Convites (de criador e de sala):**
  - 256 bits nominais (244 aleatórios, de dois UUID v4) em base64url;
  - só o SHA-256 é guardado;
  - uso único, com consumo atômico (linha travada);
  - expiração (sala: 1–60 min; criador: 5 min–24 h);
  - revogáveis;
  - erro genérico `invite-invalid`.
- **Sessões:**
  - pertencem ao usuário do JWT;
  - no máximo 2 vivas por usuário por sala;
  - expiram sem batimento em 90 s;
  - o tópico privado é `oryn:s:{sessão}`.
- **Tabelas de domínio:** nenhum acesso direto. O schema `oryn` **não deve** ser exposto na Data API; RLS ligado
  sem políticas; nenhum privilégio para `anon`, `authenticated` ou `service_role`, **nem `USAGE` no schema**.
- **Predicado do Realtime:** `oryn_realtime.can_receive_topic` fica num schema mínimo. `authenticated` tem
  `USAGE` só nesse schema e `EXECUTE` só nesse predicado. Também não deve ser exposto na Data API.
- **RPCs encaminhadoras:** as funções do schema exposto `public` são a única porta. Elas checam
  `auth.uid()`, sessão e sala e acessam `oryn` com o privilégio do dono.
- **RPCs:**
  - `EXECUTE` revogado de `PUBLIC`/`anon` e concedido a `authenticated`;
  - `set_signal_state` concedido **só** a `service_role` (Edge Function);
  - a emissão de convite de criador fica só com o dono do banco.
- **Remetente:** sempre derivado de `auth.uid()` e da sessão no banco. O pedido **não tem** campo de remetente;
  chaves extras são recusadas. A Edge Function ainda confere se o usuário do JWT é o mesmo que o banco usou.
- **Destinatário:** sessão viva da **mesma sala**.
- **Realtime:**
  - receber: só o dono da sessão ativa;
  - enviar: **nenhum** cliente envia em `oryn:*` (sem `insert` permissivo, mais uma política restritiva que nega);
  - presence: não usado.
  - As barreiras restritivas não distinguem maiúsculas e cobrem `anon`. Os testes provam que continuam
    fechando os tópicos `oryn:*` mesmo se uma política permissiva genérica for criada no futuro.
- **Persistência:**
  - eventos de **controle** (`hello`/`bye`: UUID e rótulo) saem por `realtime.send`, que **fica gravado de 72 h
    a 4 dias** (documentação oficial);
  - **SDP e candidatos ICE nunca** passam por `realtime.send` nem por tabelas: vão pela Edge Function `signal`
    (Broadcast REST, opção S2). A não persistência do REST é **NOT VERIFIED** e é o portão do 02C.1B.

## Estados da sinalização e entrega

`accepted` → `publishing` → `published` | `failed`; `failed`/`publishing` → `publishing` (retentativa, até 5);
`published` → `acknowledged` (só o destinatário, `ack_signals`).

- **Pelo menos uma vez, nunca "exatamente uma vez":**
  - o cliente repete o **mesmo** `client_msg_id` em falhas transitórias (429/5xx/rede);
  - o banco devolve o mesmo `msg_id`/`seq`;
  - uma mensagem já publicada não é republicada;
  - uma mensagem `accepted`/`failed`/`publishing` (falha entre registro e publicação) é republicada com o mesmo
    `msg_id`.
- **O destinatário:**
  - descarta duplicatas por `msg_id` e por `seq` já processado;
  - ordena por `seq` (por remetente), com buffer limitado;
  - em lacuna acima de 2 s, pede `restart-request` e segue;
  - descarta epoch antigo e mensagens com mais de 60 s;
  - confirma em lotes de até 64.

## Configuração do projeto Supabase (para o 02C.1B, só com autorização; nada disto foi feito)

O projeto Supabase já existe e o repositório GitHub foi conectado pela integração do painel (informado pelo
usuário). Nenhuma configuração foi alterada nesta etapa. Nenhum valor real vai para o repositório.

**Antes do primeiro push destas migrações (bloqueante), conferir no painel, só lendo:**
- **Diretório de trabalho** da integração GitHub. Se apontar para `poc/webrtc-audio-supabase`, as migrações
  e a Edge Function desta pasta passam a ser aplicadas automaticamente.
- **Branching automático.** Ligado, *cada push em qualquer branch* aplica `supabase/migrations` e publica as
  Edge Functions numa branch de preview (documentação oficial).
- **Deploy to production** e **branch de produção.** No push ou merge na branch de produção, as migrações
  novas são aplicadas.
- Até o 02C.1B ser autorizado, a integração não deve aplicar nada desta pasta.

- **Data API:** expor **apenas** `public`; nunca `oryn` nem `realtime`.
- **Realtime:** "Allow public access" **desligado**; clientes com `private: true`.
- **Auth:**
  - anonymous sign-ins ligado;
  - **Cloudflare Turnstile** (ou CAPTCHA invisível) obrigatório;
  - JWT com expiração curta (proposta: 10 min).
- **Variáveis da Edge Function:**
  - **injetadas pela plataforma**, nunca criadas como secret, porque nomes `SUPABASE_*` são reservados:
    `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEYS`, `SUPABASE_SECRET_KEYS` (e as legadas `SUPABASE_ANON_KEY` e
    `SUPABASE_SERVICE_ROLE_KEY`, usadas só se as novas não existirem);
  - **único secret próprio:** `ORYN_ALLOWED_ORIGINS` (origens HTTPS, separadas por vírgula), definido no painel ou
    por `supabase secrets set` digitado no terminal, nunca em arquivo versionado.
- **Uso das credenciais pela Edge Function** (`_shared/supabase-http.ts`):
  - chamadas do **usuário** levam `apikey` publicável + `Authorization: Bearer <JWT do usuário>`, então
    `auth.uid()` é o usuário;
  - chamadas do **servidor** levam **só** `apikey` secreta, **sem** `Authorization`, porque `sb_secret_` não é JWT.
- **Frontend e harness:** só a URL do projeto e a chave **publicável**. Nunca `sb_secret_` nem `service_role` no
  cliente: o harness remoto aborta se encontrar qualquer uma delas no ambiente.
- **Logs e evidências:** nunca chaves, JWT, tokens de convite ou string de conexão; IDs só com 8 caracteres.

## NOT VERIFIED (exige Supabase real)

Lista completa e executável em `tests/integration.pending.test.ts`. Procedimento, scripts SQL (pré-voo e
pós-voo somente leitura, concorrência, reversão) e matriz de evidências do 02C.1B: `integration/`. Inclui:
- versão do Postgres do projeto;
- privilégios padrão reais;
- exposição de schemas;
- canais privados e envio direto negado (WebSocket e REST);
- não persistência do Broadcast REST;
- revogação com autorização em cache;
- Turnstile;
- latência da Edge Function;
- concorrência real no resgate de convites (o PGlite tem uma conexão só).
