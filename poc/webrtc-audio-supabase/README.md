# POC-02C — Sinalização WebRTC por Supabase Realtime

Prova de conceito **descartável** do Oryn. Substitui o servidor Node de sinalização da POC-02B por Supabase:
- Auth anônimo;
- Postgres com RLS;
- canais privados do Realtime;
- Edge Function `signal`.

A mídia continua WebRTC P2P, e o Cloudflare TURN entra só como relay. Contrato e decisões: relatórios
POC-02C.0 e 02C.0A (D1 a D4).

## Estado (último registro documentado: 2026-11-06)

**Trabalho local em 2026-11-09:** identidade por conta, cadastro com nome e edição
de perfil na branch `feat/profile-display-name`, sem publicação ou migração remota.
Nome global no Supabase Auth, com fallback dos nomes existentes por sala.
Implementação, compatibilidade, migração preparada e validação local:
[`PROFILE-DISPLAY-NAME.md`](../../docs/validation/PROFILE-DISPLAY-NAME.md).

**Produção em 2026-11-07:** cliente do PR #20 (`4c49bf9`), com salas de grupo e Soundboard. A interface Midnight ainda não foi integrada (seção "Interface Midnight").

**Validação real (2026-11-06), com o cliente de então, no commit `f7bae53`:** chamada entre redes diferentes,
Chrome no Windows e Safari no iPhone, com voz, mudo, saída e reentrada relatados como funcionando. **NET-01 e NET-02: validação
funcional manual positiva; homologação técnica integral pendente.** A duração de 15 minutos e a troca de rede são relatos manuais; a
duração contínua de mídia e a migração do caminho WebRTC não estão comprovadas.
Detalhes em [`docs/validation/NET-01-NET-02.md`](../../docs/validation/NET-01-NET-02.md). Comportamentos a preservar: runbook §14.11.

Fontes do restante desta seção: `integration/RUNBOOK-02C.1B.md` (§1, §12 e §13). Salvo indicação, descreve o último estado
registrado em 2026-10-28, sem nova leitura no projeto remoto.

1. **Implementado neste repositório:**
   - contratos TypeScript e migrações `0100`–`0300` (schema `oryn`, RLS, RPCs, políticas do Realtime);
   - Edge Function `signal` e cliente web de voz 1:1 (`src/web/`);
   - testes locais, harness remoto (desligado por padrão) e scripts de integração (`integration/`).
2. **Implantado no projeto Supabase real** (ref fora do repositório, runbook §1), cada passo com autorização
   própria:
   - migrações `0100`–`0300` aplicadas (leitura `07` do runbook §13: 58 objetos no escopo `oryn`);
   - migração `0400` (MVP 01) aplicada em 2026-10-28 pela CLI (checklist, Etapa 4: 60 objetos no escopo `oryn` e
     14 RPCs em `public`);
   - Edge Function `signal` publicada pela CLI, com `verify_jwt = true` e um único secret próprio,
     `ORYN_ALLOWED_ORIGINS` (runbook §13);
   - 3 contas de teste de e-mail e senha, criadas pelo operador no painel (runbook §12.3).
   - A integração GitHub do Supabase não aplica esta pasta (Working directory `.`, Deploy to production
     desligado; confirmado em 2026-10-23, runbook §1). Toda publicação foi feita pela CLI.
3. **Testado no Supabase real** (operador ou executor, com autorização):
   - C0-R (2026-10-27): leituras e recusas de permissão (runbook §12.1);
   - C0-W, 1ª execução (2026-10-27): Z8 PASS, Z6 INCONCLUSIVO e **Z7 FAIL** (o Realtime avaliou
     `private_only = false`; runbook §12.2);
   - C2 com contas preexistentes: criou a sala `it-02c4b-*` usada nas chamadas. O resultado detalhado não está
     registrado no runbook;
   - chamadas 1:1 reais (2026-10-28): mesma rede 6/6 PASS, WAN só com STUN PASS e D5 PASS (nenhum SDP ou
     candidato em `realtime.messages`). Detalhes em "Cliente web de voz 1:1" e no runbook §13.
4. **Pendente ou `todo`:**
   - os 18 itens de `tests/integration.pending.test.ts` continuam `todo` no `pnpm test` (evidência manual não
     converte teste automático em PASS);
   - os 12 itens do harness remoto (`pnpm test:remote`) não rodam no CI;
   - a matriz `integration/EVIDENCE-02C.1B.md` está na situação de 2026-10-23 e **não** inclui as execuções acima;
   - fluxo anônimo com Turnstile (#5, janela C1) suspenso;
   - TURN, NAT restritivo (simétrico, CGNAT), redes corporativas e grupo: não testados;
   - chat por sala em produção desde 2026-11-06 (migração `0500` e `fa95dd5`), com homologação manual positiva e cenários ainda sem evidência em aparelho (runbook §14.12).
5. **Recursos remotos ainda ativos** (último estado documentado, 2026-10-28; nenhum desligamento registrado):
   - Edge Function `signal` `ACTIVE`, `verify_jwt: true`. `ORYN_ALLOWED_ORIGINS` passou a incluir, além de
     `http://127.0.0.1:5173`, a origem publicada, em 2026-11-05;
   - a sala da C2 (`93468ee8…`) aberta, com 2 membros (D2 "FAIL esperado");
   - as 3 contas de teste, com senhas de longa duração (trocar ou apagar no fim da campanha, runbook §12.4);
   - na última leitura: 0 sessões de Auth e 0 sessões de sala vivas;
   - "Allow public access" do Realtime: a 1ª C0-W observou `private_only = false` e o runbook não registra uma
     leitura posterior com `true`. **NOT VERIFIED.**

### Histórico dos incrementos

- **02C.1A e 02C.1A.1 (fundação local):** contratos TypeScript, migrações SQL, políticas RLS restritivas, RPCs de
  domínio, esqueleto da Edge Function `signal` e testes automatizados. Nessa etapa não houve deploy nem
  credencial; o que veio depois está em "Estado".
- **Testes de autorização:** rodam em **Postgres real em memória (PGlite 0.5.11, Postgres 18)** com um **shim**
  das peças do Supabase (`tests/helpers/supabase-shim.sql`). As migrações rodam como **dono não
  superusuário** (`migration_owner`, como o `postgres` do Supabase), para que as funções `SECURITY DEFINER`
  executem com privilégios realistas.
- **CI:** `.github/workflows/poc-02c-ci.yml` (02C.1A.1). Roda instalação congelada, typecheck, testes e audit,
  sem segredos e sem deploy.
- **Testes automáticos do Supabase real:** `tests/integration.pending.test.ts`, 18 itens `todo` (15 do 02C.1A,
  2 da revisão e o #18 do 02C.2B). A evidência manual colhida depois está em "Estado".
- **02C.1B.0A (correções locais):**
  - Edge Function com credenciais separadas (B1);
  - secrets sem nomes reservados (B2);
  - `supabase/config.toml` com a função travada (`enabled = false`; B3). A trava foi retirada no deploy
    autorizado: o valor atual é `enabled = true`;
  - auditoria das RPCs `SECURITY DEFINER`;
  - harness remoto desligado por padrão.
- **02C.2B (compatibilidade com o Supabase real observado na 02C.2A):**
  - `0300` não altera mais `realtime.messages`: só exige RLS ligado e para inteira se não estiver (A1);
  - o cliente aceita o `id` que o `realtime.send` real injeta nos eventos de controle (A2);
  - pré-voo e pós-voo com as expectativas reais, mais as classificações `NOT VERIFIED` e `INFO` (A3);
  - travas por linha em `join_room` e `authorize_signal`: limite de sessões, idempotência e limite de taxa
    exatos sob concorrência, sem impasse (M5);
  - shim refeito a partir do catálogo real;
  - concorrência provada em **PostgreSQL 17 real embutido** (`pnpm test:pg`).

## Comandos

```powershell
cd "C:\Dev\Projeto - Oryn\poc\webrtc-audio-supabase"
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test        # unitários + autorização SQL (PGlite); itens do Supabase real aparecem como "todo"
pnpm test:pg     # concorrência e compatibilidade em PostgreSQL 17 real embutido (local, ~20 s)
pnpm test:remote # Supabase REAL: tudo pulado sem ORYN_REMOTE=1 (ver integration/RUNBOOK-02C.1B.md, §9)
pnpm build       # typecheck + bundle do cliente web de voz (dist/, ignorado pelo Git)
pnpm dev         # cliente web em http://127.0.0.1:5173 (exige .env.local; ver "Cliente web de voz 1:1")
```

Requisitos: Node 24+ e pnpm 12+. Não há serviço a instalar: o PGlite e o PostgreSQL 17 embutido
(`embedded-postgres`, só em 127.0.0.1 e com senha gerada por execução) são dependências de desenvolvimento.
`pnpm-workspace.yaml` libera o script de instalação **só** dos binários do PostgreSQL embutido (Windows e Linux x64).

## Estrutura

| Caminho | Conteúdo |
|---|---|
| `supabase/migrations/…0100_oryn_schema.sql` | Schema privado `oryn`: salas, membros, convites, sessões, contadores e registro de sinais **sem payload**. RLS ligado, nenhuma política, nenhum privilégio |
| `supabase/migrations/…0200_oryn_functions.sql` | RPCs `SECURITY DEFINER` (`search_path = ''`) e `EXECUTE` explícito |
| `supabase/migrations/…0300_oryn_realtime.sql` | Políticas de `realtime.messages`: receber só no próprio tópico; **nenhum envio de cliente** em `oryn:*` |
| `supabase/migrations/…0400_oryn_room_management.sql` | MVP 01: `list_my_rooms` e `close_room` (aditiva; aplicada no remoto em 2026-10-28) |
| `supabase/migrations/…0600_oryn_room_membership.sql` | Salas de grupo: capacidade de até 4 contas, lista de membros, saída, remoção e identidade de participante (aditiva; aplicada no remoto em 2026-11-06) |
| `supabase/migrations/…0500_oryn_room_messages.sql` | Chat por sala: `oryn.room_messages`, `oryn.room_message_counters`, `send_room_message` e `list_room_messages` (aditiva; aplicada no remoto em 2026-11-06) |
| `supabase/migrations/…0700_oryn_soundboard.sql` | Soundboard: `oryn.sound_assets`, `oryn.sound_trigger_state`, 9 RPCs, 2 predicados, bucket privado `oryn-sounds` e 2 políticas em `storage.objects` (aditiva; aplicada no remoto em 2026-11-07) |
| `supabase/functions/sound-media/`, `_shared/sound-media-core.ts`, `_shared/sound-validate.ts` | Validação do conteúdo dos sons e limpeza de objetos (publicada no remoto, versão 2) |
| `supabase/functions/_shared/` | Contrato da sinalização e núcleo da Edge Function (puros e testados) |
| `supabase/functions/_shared/edge-config.ts`, `supabase-http.ts`, `signal-http.ts` | Credenciais, chamadas HTTP com headers separados por operação e camada HTTP/CORS (puros e testados) |
| `supabase/functions/signal/index.ts` | Só a ligação Deno dos módulos de `_shared`. Publicado no projeto real (runbook §13); fora do typecheck do Node |
| `supabase/config.toml` | CLI 2.122.0: Data API só `public`, sem seed, JWT de 600 s, função `signal` habilitada e publicada (`enabled = true`, `verify_jwt = true`) |
| `tests/remote/` | Harness do Supabase real (`pnpm test:remote`), desligado por padrão |
| `tests/pg/` | Concorrência e compatibilidade em PostgreSQL 17 real embutido (`pnpm test:pg`; roda no CI) |
| `integration/` | Runbook, matriz de evidências e scripts SQL do 02C.1B |
| `src/` | Cliente: contratos de domínio, recepção (duplicatas e ordem) e envio com retentativas |
| `src/web/` | Cliente web de voz 1:1: página (`main.ts`), lobby de salas (`rooms.ts`, `rooms-view.ts`), `SupabaseSignaling`, backend supabase-js, configuração e os módulos WebRTC copiados da POC-02B (`call.ts`, `ice.ts`, `stats.ts`…) |
| `index.html`, `vite.config.ts`, `.env.example` | Página, build e modelo de configuração local do cliente web |
| `tests/` | Testes; `helpers/` com o shim, o banco PGlite, os cenários e os fakes do cliente web (`web-fakes.ts`) |

## Cliente web de voz 1:1 (integração Supabase + WebRTC)

Chamada de voz entre OWNER e MEMBER, nas contas de e-mail e senha já existentes (as da C2), na sala da C2.

- **Retorno depois de recarregar:** a aba guarda só o ID da sala em `sessionStorage` (`src/web/call-return.ts`). O
  servidor confirma a sala e a participação, e "Voltar para a chamada" pede um clique; o microfone não liga antes disso
  (runbook §14.5).
- **Login:** `signInWithPassword`. A sessão é persistida pelo mecanismo oficial do Auth, em `localStorage`, e sobrevive
  a F5 e à reabertura do navegador (`src/web/auth-session.ts`; riscos no runbook §14.6). Sem anônimo,
  sem cadastro.
- **Sala:** `join_room` → canal privado `oryn:s:{sessão}` → `get_roster`. `hello`/`bye` (publicados pelo banco)
  mostram quem entra e sai. Batimento `touch_session` a cada 30 s; `leave_room` ao sair.
- **Sinalização:** offer, answer e candidatos ICE, um a um, só pela Edge Function `signal`. Nenhum Broadcast do
  cliente. Regras de envio e recepção:
  - fila serial, com limite de 30 envios em 10 s (o banco recusa a partir de 40);
  - retentativas do `sendSignal` com o mesmo `client_msg_id`;
  - recepção pelo `SignalReceiver` (duplicatas, ordem por `seq`) e confirmação por `ack_signals`.
- **Iniciador e `pair_epoch`:** determinísticos, calculados só dos dois `session_id`:
  - cria a offer a sessão de menor id;
  - o epoch é um hash simétrico do par.

  Os dois lados chegam ao mesmo valor sem contador local.
- **Áudio:** `PeerCall` da POC-02B, com Opus, mute por `track.enabled` e métricas. Três mudanças pontuais, marcadas
  `02C` em `src/web/call.ts`.
- **ICE:** só STUN (padrão `stun:stun.l.google.com:19302`); sem TURN.
- **1:1:** uma terceira conta é ignorada enquanto houver par; outra aba da própria conta nunca vira par.
- **Segurança da configuração:** o frontend recebe só a chave publicável. A página se recusa a iniciar se qualquer
  `VITE_*` parecer chave secreta, PAT ou `service_role`.

Iniciar (cada participante na própria máquina, em `localhost`, que é contexto seguro para o microfone):

```powershell
cd "C:\Dev\Projeto - Oryn\poc\webrtc-audio-supabase"
pnpm install --frozen-lockfile
Copy-Item .env.example .env.local   # preencher URL do projeto, chave publicável e (opcional) o UUID da sala
pnpm dev                            # http://127.0.0.1:5173
```

A Edge Function `signal` está publicada (`verify_jwt = true`) e o secret `ORYN_ALLOWED_ORIGINS` aceita só
`http://127.0.0.1:5173`. Qualquer outra origem exige autorização própria (runbook §13).

**Validado (2026-10-28, runbook §13)**, chamadas reais 1:1 entre Windows (Chrome/Edge) e iPhone (Safari), por
um túnel HTTPS temporário:

- **Mesma rede, 6/6 PASS:**
  - HTTPS no Safari;
  - as duas contas na mesma sala;
  - WebRTC conectado;
  - áudio nos dois sentidos;
  - mute independente;
  - saída detectada pelo outro lado.
- **WAN (Windows no Wi-Fi ↔ iPhone só em 5G), PASS:**
  - ICE conectado, com caminho direto `srflx ↔ srflx` em UDP, sem TURN;
  - Opus a 48 kHz, RTT de cerca de 23 ms e perda de cerca de 0,1%;
  - áudio nos dois sentidos confirmado pelo operador.

**Não validado:**
- **NAT e operadoras:** o WAN cobre um único cenário (uma rede Wi-Fi e uma operadora móvel). NAT restritivo
  (simétrico, CGNAT) e redes corporativas não foram testados.
- **TURN:** não existe; sem ele, redes restritivas podem não conectar.
- **Grupo:** até 4 contas por sala, em mesh, na seção "Salas de grupo".

## MVP 01 — gerenciamento de salas pela interface

**Estado: implementado, testado localmente e com a migração 0400 aplicada no remoto em 2026-10-28.** Implantação: checklist
de deploy, Etapa 4 ⛔. Operação, validação manual e riscos: runbook §14.

- **`list_my_rooms()`:** as salas em que a conta é membro ativo, abertas e encerradas (abertas primeiro, até 50),
  com nome, papel, contagem de membros, capacidade e estado. Dos outros membros, só a contagem.
- **`close_room(p_room_id)`:** só o dono; idempotente; preserva o histórico (`closed_at`). Revoga as sessões e os
  convites pendentes e avisa quem está na chamada com o `bye` já existente (sem evento novo).
- **Lobby** (depois do login):
  - lista, com estados de carregamento, vazio e erro; encerradas num bloco recolhido, sem ações;
  - criação com nome (até 40 caracteres) e nome de exibição (até 32), sempre com **2 lugares**;
  - "Entrar na chamada" usa o fluxo 1:1 existente; uma chamada por vez;
  - "Encerrar sala" só para o dono, com confirmação; irreversível no MVP 01;
  - o campo de UUID ficou em "Diagnóstico".
- **Encerramento visto por quem está na chamada:** `bye` → roster `not-member` → desconexão `4403`, e o motivo
  ("sala encerrada", "não participa mais" ou "sessão expirou") vem de uma consulta ao `list_my_rooms`. Se o `bye`
  se perder, o batimento encerra em até 30 s.
- **Queda do par e falha de ICE** não encerram mais a chamada de quem ficou: a sessão continua, aguardando reconexão, com
  no máximo 2 recuperações por par a cada 60 s (runbook §14.4).
- **Fora do escopo:** convites pela interface, remover membro, grupo, TURN.

## Chat por sala

**Estado: em produção desde 2026-11-06, com homologação manual em Chrome no Windows e Safari no iPhone (6 de 6 PASS).** Registro,
cenários sem evidência em aparelho e riscos: runbook §14.12. Implantação: checklist de deploy, Etapa 5 ⛔.

- **Dentro ou fora da chamada:** "Abrir chat" na lista de salas, para quem é membro ativo. Não pede microfone e não usa sessão de chamada,
  sinalização, Realtime ou WebRTC.
- **`send_room_message(p_room_id, p_client_nonce, p_body)`:** o autor vem do JWT. Texto de 1 a 4.000 caracteres. Repetir o mesmo
  identificador na mesma sala e pelo mesmo autor devolve a mensagem original, sem duplicar. Até 30 mensagens por minuto, por autor, em cada sala.
- **`list_room_messages(p_room_id, p_before_seq, p_after_seq, p_limit)`:** membro ativo, com a sala aberta ou encerrada. Sem cursor,
  as mais recentes; `p_before_seq` pagina para trás; `p_after_seq` traz as novas. Devolve nome de exibição e `is_mine`, sem conta de ninguém.
- **Ordem:** `seq` por sala, atribuído sob a trava da sala e nunca reutilizado. Um cursor por `seq` não perde mensagem. A exclusão de uma conta pode deixar lacunas no histórico.
- **Atualização:** consulta a cada 3 s com o painel aberto e a página visível; depois de falhas, espaça até 30 s.
- **Sala encerrada:** somente leitura, em "Ver mensagens". Enviar devolve `room-closed`.
- **Texto puro:** só `textContent`, sem HTML. O texto não vai para registro nenhum nem para `realtime.messages`.
- **Fora do escopo:** edição e exclusão de mensagens, anexos, indicador de digitação, entrega instantânea, espaços e canais.

## Salas de grupo e voz multiponto

**Estado: a migração 0600 foi aplicada no remoto em 2026-11-06, com pós-voo aprovado, e o cliente de grupo está em produção desde o merge do PR #19.**
Implantação: checklist de deploy, Etapa 6 ⛔. Operação, homologação e riscos: runbook §14.13.

- **Capacidade:** 2, 3 ou 4 contas por sala, com o dono. O backend recusa sala nova acima de 4 e o resgate que ultrapassaria a capacidade.
- **Membros:** `list_room_members`, `leave_room_membership` e `remove_room_member`. A referência de um membro é opaca, por sala, e não revela a conta.
- **Voz:** uma `RTCPeerConnection` por participante remoto: até 3 por cliente e 6 no total. Uma única captura de microfone. Cada áudio remoto fica separado.
- **Identidade:** `get_voice_participants` distingue contas de sessões. De cada conta, só a sessão mais antiga entra no mesh; a outra fica em espera e assume quando a primeira sair, ou quando um par a chamar por ter perdido a primeira (navegador que caiu sem avisar).
- **Isolamento:** a falha de um par não derruba os demais. Sem SFU e sem servidor de mídia.
- **Fora do escopo:** espaços, canais, TURN, deafen, volume individual e transferência de propriedade.

## Soundboard

**Estado: migração 0700 aplicada, função `sound-media` publicada, Storage testado e cliente em produção desde o merge do PR #20. Etapa Macro 5 encerrada por decisão de produto, com riscos residuais aceitos: nem todas as métricas da P05 foram verificadas.**
Implantação: checklist de deploy, Etapa 7 ⛔. Operação e riscos: runbook §14.14. Evidências e roteiro em aparelhos: `docs/validation/P05-SOUNDBOARD.md`.

- **Modelo:** o clique vira um evento curto, e cada cliente toca a própria cópia. O arquivo nunca passa pelo Realtime nem pelo WebRTC, e o som não entra no microfone.
- **Catálogo:** por sala, até 20 sons. Só o dono publica e remove; membro ativo consulta e dispara.
- **Arquivos:** MP3 e WAV, até 2 MiB e 10 s, sem transcodificação. Bucket privado; ler exige membro ativo e som disponível no catálogo, e a pasta não prova nada.
- **Quarentena:** o envio só é aprovado pela função `sound-media`, que lê o arquivo inteiro e mede formato, duração, tamanho e hash reais. MIME e extensão não contam.
- **Disparo:** `trigger_sound`, com cooldown de 2 s por conta aplicado no servidor. O evento leva só metadados e vence em 2 s.
- **Prazo:** o cliente compara na hora do servidor, estimada por `sound_clock`, então um relógio errado no aparelho não descarta som válido nem toca som velho. Sem estimativa, descarta.
- **Reprodução:** barramento Web Audio próprio, com volume e limitador; até 2 sons simultâneos; deduplicação por `event_id`. A sessão em espera não toca.
- **Cache:** IndexedDB, LRU até 100 MiB, por conta, sala, som, versão e hash. Só bytes e metadados. Sai ao remover o som, sair da sala, ser removido ou sair da conta.
- **Limpeza:** sem agendador; roda quando o dono entra na chamada ou remove um som. Reconciliação em `integration/sql/15_sound_orphans.sql`.
- **Remoção:** vale na hora no banco: sai do catálogo e novos disparos são recusados. Uma leitura já autorizada pode persistir por uma janela no CDN do Storage, e bytes já entregues não são revogados. Contrato na P05, seção 3.

## Interface Midnight

**Estado em 2026-11-07: implementada e validada localmente na branch `feat/midnight-ui`; não integrada e não publicada.** Produção segue com a interface anterior. Checklist, limites da prévia e reversão: `docs/validation/MIDNIGHT-INTEGRACAO.md`.

- **O que muda:** só apresentação e navegação, em TypeScript puro e Vite. Sem mudança de banco, funções, contratos ou WebRTC.
- **Estilos:** `src/web/styles/`, com os tokens em `tokens.css`. Fonte do sistema e logotipo em texto, sem ativos externos.
- **Navegação:** `src/web/shell.ts` guarda o estado visual só em memória. Selecionar uma sala não entra na chamada.
- **Áudio remoto:** `#audio-container` é filho direto de `<main>`, fora de todo painel recolhível. Não mover para dentro de um.

**Piloto Windows/web (Etapa Macro 6), pendente:** P06 (desktop), P07 (carga e custo) e P08 (recuperação), sem evidência; instalador assinado, atualizações, métricas, runbooks do piloto e limitações comunicadas; WebView2 sem evidência. Baselines S2, S3 e S4 seguem com os valores pós-0600, e não há C0 nem C2 até o commit próprio deles.

## Modelo de segurança

- **Identidade:**
  - **desenho (D1):** Supabase Auth anônimo. As políticas tratam `authenticated` igual, com ou sem
    `is_anonymous` (`tests/sql-anon-roles.test.ts`);
  - **em uso hoje:** contas de e-mail e senha criadas pelo operador (C2 e cliente web, `signInWithPassword`). O
    caminho C0/C2 confere o cadastro anônimo **desligado** no projeto real (runbook §12, Z1), e o fluxo anônimo
    com Turnstile (C1) está suspenso;
  - em qualquer caso, uma conta **sozinha não alcança nada**: toda RPC exige convite resgatado ou sessão própria.
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
- **Encerramento (MVP 01, `close_room`):**
  - só o dono; sala alheia ou inexistente recebe a mesma resposta (`unauthorized`);
  - travas em ordem fixa (sala → membros → sessões) e convites **sem espera** (`SKIP LOCKED`), sem ciclo com
    `join_room`, `create_room_invite`, `redeem_room_invite` ou `revoke_room_invite` (provado em PostgreSQL 17
    real, com controles que reproduzem os ciclos das versões rejeitadas);
  - depois do encerramento, toda RPC de uso da sala recusa; um convite só é utilizável se estiver pendente **e** a
    sala estiver aberta.
- **Nomes no cliente:** sempre renderizados como texto (`textContent`), nunca como HTML; comprimento contado em
  pontos de código, como no banco.
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
    (Broadcast REST, opção S2). A não persistência do REST está **comprovada pelo D5 PASS** (runbook §13). Na
    leitura do `12_c2_preflight.sql` feita depois da chamada real, havia 26 sinais em `signal_log` e nenhum
    evento `signal` em `realtime.messages`; só as 44 mensagens `hello`/`bye`. O escopo é essa chamada nesse
    projeto: só a ausência de SDP/ICE em `realtime.messages`, não os logs internos da plataforma.

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

## Configuração do projeto Supabase (referência das configurações exigidas)

O projeto Supabase já existe, e o repositório GitHub está conectado pela integração do painel (informado pelo
usuário). As alterações feitas desde então (migrações, Edge Function, secret, contas e janelas de teste) estão
registradas no runbook (§10, §12 e §13), cada uma com autorização própria. Nenhum valor real vai para o
repositório.

**Antes do primeiro push destas migrações (bloqueante), conferir no painel, só lendo:**
- **Diretório de trabalho** da integração GitHub. Se apontar para `poc/webrtc-audio-supabase`, as migrações
  e a Edge Function desta pasta passam a ser aplicadas automaticamente.
- **Branching automático.** Ligado, *cada push em qualquer branch* aplica `supabase/migrations` e publica as
  Edge Functions numa branch de preview (documentação oficial).
- **Deploy to production** e **branch de produção.** No push ou merge na branch de produção, as migrações
  novas são aplicadas.
- A integração não deve aplicar nada desta pasta. Último estado confirmado: Working directory `.` e Deploy to
  production desligado (2026-10-23, runbook §1).

- **Data API:** expor **apenas** `public`; nunca `oryn` nem `realtime`.
- **Realtime:** "Allow public access" **desligado**; clientes com `private: true`.
- **Auth, para o fluxo anônimo (D1; hoje suspenso, com o cadastro anônimo desligado):**
  - anonymous sign-ins ligado;
  - **Cloudflare Turnstile** (ou CAPTCHA invisível) obrigatório;
  - JWT com expiração curta (proposta: 10 min).
- **Auth, para o caminho em uso (contas de e-mail e senha, runbook §12.3):** login por e-mail habilitado; contas
  criadas só pelo operador no painel, sem cadastro pelo cliente.
- **Variáveis da Edge Function:**
  - **injetadas pela plataforma**, nunca criadas como secret, porque nomes `SUPABASE_*` são reservados:
    `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEYS`, `SUPABASE_SECRET_KEYS` (e as legadas `SUPABASE_ANON_KEY` e
    `SUPABASE_SERVICE_ROLE_KEY`, usadas só se as novas não existirem);
  - **único secret próprio:** `ORYN_ALLOWED_ORIGINS` (origens HTTPS, separadas por vírgula; `http://localhost` e
    `http://127.0.0.1` só para desenvolvimento, que é o valor atual), definido no painel ou por
    `supabase secrets set` digitado no terminal, nunca em arquivo versionado.
- **Uso das credenciais pela Edge Function** (`_shared/supabase-http.ts`):
  - chamadas do **usuário** levam `apikey` publicável + `Authorization: Bearer <JWT do usuário>`, então
    `auth.uid()` é o usuário;
  - chamadas do **servidor** levam **só** `apikey` secreta, **sem** `Authorization`, porque `sb_secret_` não é JWT.
- **Frontend e harness:** só a URL do projeto e a chave **publicável**. Nunca `sb_secret_` nem `service_role` no
  cliente: o harness remoto aborta se encontrar qualquer uma delas no ambiente.
- **Logs e evidências:** nunca chaves, JWT, tokens de convite ou string de conexão; IDs só com 8 caracteres.

## Sem teste automático no Supabase real (`todo`)

Lista completa e executável em `tests/integration.pending.test.ts` (18 itens `todo`). Parte dos itens já tem
evidência **manual** (seção "Estado", item 3, por exemplo a não persistência do Broadcast REST pelo D5), mas
continua `todo` como teste automático. Procedimento, scripts SQL (pré-voo e
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
