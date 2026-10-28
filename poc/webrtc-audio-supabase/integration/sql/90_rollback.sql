-- POC-02C.1B — REVERSÃO das migrações 0100–0400. DESTRUTIVO: apaga o schema da Oryn e seus dados.
-- Rodar SOMENTE com autorização explícita do arquiteto, no ambiente onde as migrações falharam ou precisam
-- ser refeitas. Tudo numa transação: ou volta inteiro, ou nada muda. Não toca em auth.users.
-- Ordem inversa das migrações: 0400 (RPCs de salas) → 0300 (políticas do Realtime) → 0200 (funções) →
-- 0100 (schema). Para desfazer SÓ a 0400, preservando dados, use o 91_rollback_0400.sql.

begin;

-- 0400 (MVP 01): RPCs de gerenciamento de salas.
drop function if exists public.close_room(uuid);
drop function if exists public.list_my_rooms();

-- 0300: políticas da Oryn em realtime.messages (o RLS da tabela continua ligado, como o Supabase entrega).
drop policy if exists oryn_topics_no_client_write on realtime.messages;
drop policy if exists oryn_topics_read_guard_anon on realtime.messages;
drop policy if exists oryn_topics_read_guard on realtime.messages;
drop policy if exists oryn_receive_own_session_topic on realtime.messages;

-- 0200: RPCs do schema public.
drop function if exists public.ack_signals(uuid, uuid[]);
drop function if exists public.set_signal_state(uuid, text);
drop function if exists public.authorize_signal(uuid, uuid, uuid, text, integer, integer);
drop function if exists public.get_roster(uuid);
drop function if exists public.leave_room(uuid);
drop function if exists public.touch_session(uuid);
drop function if exists public.join_room(uuid);
drop function if exists public.redeem_room_invite(text, text);
drop function if exists public.revoke_room_invite(uuid);
drop function if exists public.create_room_invite(uuid, integer);
drop function if exists public.create_room(text, text, integer);
drop function if exists public.redeem_creator_invite(text);

-- 0200/0100: schemas privados (funções internas, tabelas, índices).
drop schema if exists oryn_realtime cascade;
drop schema if exists oryn cascade;

-- Histórico do CLI/integração: sem isto, a próxima aplicação acharia as versões já aplicadas.
-- (Só existe se as migrações foram aplicadas por `supabase db push`, MCP apply_migration ou integração.)
do $$
begin
  if pg_catalog.to_regclass('supabase_migrations.schema_migrations') is not null then
    delete from supabase_migrations.schema_migrations
     where version in ('20261023000100', '20261023000200', '20261023000300', '20261028000400');
  end if;
end $$;

-- Conferência antes de confirmar: esperado 0 linhas em cada consulta.
select nspname from pg_catalog.pg_namespace where nspname in ('oryn', 'oryn_realtime');
select policyname from pg_catalog.pg_policies where schemaname = 'realtime' and policyname like 'oryn_%';

commit;
