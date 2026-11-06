-- REVERSÃO SÓ DA MIGRAÇÃO 0600 (salas de grupo e membros). NÃO toca nas migrações 0100–0500, em salas, mensagens ou chamadas.
-- Rodar SOMENTE com autorização explícita. Tudo numa transação.
--
-- Limite: não desfaz dados. Quem saiu ou foi removido continua com removed_at; sessões e convites revogados continuam
-- revogados; salas com 3 ou 4 lugares continuam existindo. Sem a 0600, o cliente publicado perde a voz e o painel de membros:
-- publicar o cliente anterior ANTES de rodar este script.
-- Idempotente: pode rodar de novo, ou num banco sem a 0600, sem efeito.
-- Sucesso: 07 e 08 voltam EXATAMENTE ao registro de antes da 0600, e public volta a ter as 16 RPCs.

begin;

drop function if exists public.remove_room_member(uuid, text);
drop function if exists public.leave_room_membership(uuid);
drop function if exists public.get_voice_participants(uuid);
drop function if exists public.list_room_members(uuid);
drop function if exists oryn.end_membership(uuid, uuid, text);
drop trigger if exists oryn_member_reactivation on oryn.room_members;
drop trigger if exists oryn_room_capacity on oryn.rooms;
drop function if exists oryn.guard_member_reactivation();
drop function if exists oryn.enforce_room_capacity();
drop function if exists oryn.member_ref(uuid, uuid);

do $$
begin
  if pg_catalog.to_regclass('supabase_migrations.schema_migrations') is not null then
    delete from supabase_migrations.schema_migrations where version = '20261107000600';
  end if;
  -- Falha fechada: depois da reversão, public tem de ter exatamente as 16 RPCs de antes.
  if (select pg_catalog.count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public') <> 16 then
    raise exception 'oryn-93: public não ficou com as 16 RPCs; nada foi revertido' using errcode = 'P0001';
  end if;
end $$;

-- Conferência antes de confirmar: esperado 0 linhas.
select p.oid::regprocedure as restante from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
 where (n.nspname = 'public' and p.proname in ('list_room_members', 'get_voice_participants', 'leave_room_membership', 'remove_room_member'))
    or (n.nspname = 'oryn' and p.proname in ('member_ref', 'enforce_room_capacity', 'guard_member_reactivation', 'end_membership'));

commit;
