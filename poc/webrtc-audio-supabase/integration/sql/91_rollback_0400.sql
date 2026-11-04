-- MVP 01 — REVERSÃO SÓ DA MIGRAÇÃO 0400 (list_my_rooms e close_room). NÃO apaga dados nem toca nas
-- migrações 0100–0300. Rodar SOMENTE com autorização explícita do arquiteto. Tudo numa transação.
--
-- Limite: não desfaz dados. Salas já encerradas por close_room continuam com closed_at, sessões revogadas
-- continuam revogadas e convites revogados continuam revogados.
-- Idempotente: pode rodar de novo, ou num banco sem a 0400, sem efeito.
-- Sucesso: o 07_initial_state.sql (e o 08_scope_entries.sql) voltam EXATAMENTE ao registro de antes da
-- Etapa 4, com oryn_scope de 58 objetos e o histórico só com as 3 versões da 02C.

begin;

drop function if exists public.close_room(uuid);
drop function if exists public.list_my_rooms();

do $$
begin
  if pg_catalog.to_regclass('supabase_migrations.schema_migrations') is not null then
    delete from supabase_migrations.schema_migrations where version = '20261028000400';
  end if;
  -- Falha fechada: depois da reversão, public tem de ter exatamente as 12 RPCs da 0200. Qualquer outra
  -- coisa (0200 ausente, função estranha) desfaz esta transação para investigação.
  if (select pg_catalog.count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public') <> 12 then
    raise exception 'oryn-91: public não ficou com as 12 RPCs da 0200; nada foi revertido' using errcode = 'P0001';
  end if;
end $$;

-- Conferência antes de confirmar: esperado 0 linhas.
select p.oid::regprocedure as restante from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname in ('list_my_rooms', 'close_room');

commit;
