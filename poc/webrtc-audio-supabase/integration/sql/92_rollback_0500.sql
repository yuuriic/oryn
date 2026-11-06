-- REVERSÃO SÓ DA MIGRAÇÃO 0500 (chat por sala). NÃO toca nas migrações 0100–0400, nas salas nem nas chamadas.
-- Rodar SOMENTE com autorização explícita. Tudo numa transação.
--
-- DESTRUTIVO SE HOUVER MENSAGENS: apagar a tabela apaga o texto, e nenhuma reversão o recupera. Por isso, com
-- mensagens gravadas, o script para e nada muda. Para confirmar a perda, exportar antes o que precisar ser guardado e
-- rodar, na mesma sessão, ANTES deste script:
--   set oryn.rollback_0500_apagar_mensagens = 'sim';
--
-- Idempotente: pode rodar de novo, ou num banco sem a 0500, sem efeito.
-- Sucesso: o 07_initial_state.sql e o 08_scope_entries.sql voltam EXATAMENTE ao registro de antes da 0500, e public
-- volta a ter as 14 RPCs. Depois, o cliente publicado mostra erro só no painel de chat; a chamada não depende dele.

begin;

do $$
declare v_count bigint := 0;
begin
  if pg_catalog.to_regclass('oryn.room_messages') is not null then
    execute 'select pg_catalog.count(*) from oryn.room_messages' into v_count;
  end if;
  if v_count > 0 and coalesce(pg_catalog.current_setting('oryn.rollback_0500_apagar_mensagens', true), '') <> 'sim' then
    raise exception 'oryn-92: há % mensagem(ns); nada foi revertido (ver o cabeçalho do script)', v_count using errcode = 'P0001';
  end if;
end $$;

drop function if exists public.list_room_messages(uuid, bigint, bigint, integer);
drop function if exists public.send_room_message(uuid, uuid, text);
drop table if exists oryn.room_message_counters;
drop table if exists oryn.room_messages;

do $$
begin
  if pg_catalog.to_regclass('supabase_migrations.schema_migrations') is not null then
    delete from supabase_migrations.schema_migrations where version = '20261106000500';
  end if;
  -- Falha fechada: depois da reversão, public tem de ter exatamente as 14 RPCs de antes.
  if (select pg_catalog.count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public') <> 14 then
    raise exception 'oryn-92: public não ficou com as 14 RPCs; nada foi revertido' using errcode = 'P0001';
  end if;
end $$;

-- Conferência antes de confirmar: esperado 0 linhas.
select p.oid::regprocedure as restante from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname in ('send_room_message', 'list_room_messages');

commit;
