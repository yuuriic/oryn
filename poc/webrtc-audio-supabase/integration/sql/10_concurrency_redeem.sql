-- POC-02C.1B — teste #15: resgate SIMULTÂNEO do mesmo convite de sala por duas conexões.
--
-- ESCREVE DADOS. Rodar SOMENTE no ambiente de integração autorizado (branch de preview ou projeto da POC
-- autorizado pelo arquiteto), NUNCA contra dados reais. Exige DUAS sessões psql abertas ao mesmo tempo
-- (o SQL editor do painel usa uma conexão só e não serve para este teste).
-- Conexão: string "Session pooler" ou direta do painel, digitada no terminal (nunca gravada em arquivo).
--
-- Pré-requisitos (via cliente, não SQL): três usuários anônimos reais criados por signInAnonymously()
--   OWNER, A e B. Anotar só os UUIDs (não são segredos). Nada de JWT ou chave neste arquivo.
-- Substituir :owner, :ua, :ub pelos UUIDs com \set no psql:
--   \set owner '00000000-0000-0000-0000-000000000000'
--   \set ua    '...'
--   \set ub    '...'

-- ============================== PREPARO (sessão A, como dono do banco) ==============================
-- 1. Convite de criador emitido pelo administrador (token aparece UMA vez; não registrar na evidência).
select oryn.admin_issue_creator_invite(10, 1) as creator_token \gset

-- 2. OWNER resgata, cria sala e emite convite de sala — tudo impersonado como `authenticated`.
begin;
set local role authenticated;
select pg_catalog.set_config('request.jwt.claims', pg_catalog.json_build_object('sub', :'owner', 'role', 'authenticated')::text, true);
select public.redeem_creator_invite(:'creator_token');
select public.create_room('it-concorrencia', 'owner', 3) as room_id \gset
select token as room_token from public.create_room_invite(:'room_id', 5) \gset
commit;

-- ============================== CORRIDA ==============================
-- Sessão A:
begin;
set local role authenticated;
select pg_catalog.set_config('request.jwt.claims', pg_catalog.json_build_object('sub', :'ua', 'role', 'authenticated')::text, true);
select public.redeem_room_invite(:'room_token', 'A');   -- deve retornar o room_id e SEGURAR a trava da linha
-- NÃO dar commit ainda. Ir para a sessão B.

-- Sessão B (em outro terminal; copiar :room_token com \set, sem registrá-lo na evidência):
--   begin;
--   set local role authenticated;
--   select pg_catalog.set_config('request.jwt.claims', pg_catalog.json_build_object('sub', :'ub', 'role', 'authenticated')::text, true);
--   select public.redeem_room_invite(:'room_token', 'B');   -- deve FICAR BLOQUEADA (aguardando a trava)

-- Sessão A:
commit;
-- Sessão B: deve desbloquear com ERRO "invite-invalid" (o convite já foi usado). Depois: rollback;

-- ============================== VERIFICAÇÃO (dono do banco, leitura) ==============================
-- Esperado: exatamente 1 membro 'member' (A) e o convite com used_by = A.
select m.user_id = :'ua'::uuid as is_a, m.role from oryn.room_members m where m.room_id = :'room_id' order by m.role;
select used_by = :'ua'::uuid as used_by_a, used_at is not null as used from oryn.room_invites where room_id = :'room_id';

-- Variante HTTP (concorrência real pela Data API): N=10 chamadas paralelas a /rest/v1/rpc/redeem_room_invite
-- com JWTs de 10 usuários distintos e o mesmo token. Esperado: exatamente 1 resposta 200 e 9 com
-- "invite-invalid". Ver integration/RUNBOOK-02C.1B.md (harness proposto, pendente de aprovação).

-- ============================== LIMPEZA ==============================
-- Fechar a sala (cascata nas sessões/convites só se a sala for apagada; aqui basta fechar):
--   update oryn.rooms set closed_at = now() where id = :'room_id';
-- Usuários anônimos de teste: apagar pelo painel (Authentication > Users) ao fim do 02C.1B.
