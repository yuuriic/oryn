-- REVERSÃO SÓ DA MIGRAÇÃO 0700 (soundboard). NÃO toca nas migrações 0100–0600, em salas, mensagens, membros ou chamadas.
-- Rodar SOMENTE com autorização explícita. Tudo numa transação.
--
-- Ordem: publicar o cliente anterior; apagar os objetos do bucket `oryn-sounds` pela Storage API ou pelo painel; então rodar
-- este script. O catálogo de sons é APAGADO: quem quiser os sons de volta precisa publicá-los de novo.
-- O script não apaga objetos nem o bucket por SQL. Bucket que restar fica privado e sem política: nenhum cliente o alcança.
-- A 0700 pode ser reaplicada depois, pois o bucket é criado só se não existir.
-- Idempotente: pode rodar de novo, ou num banco sem a 0700, sem efeito.
-- Sucesso: 07 e 08 voltam EXATAMENTE ao registro de antes da 0700, e public volta a ter as 20 RPCs.

begin;

drop policy if exists oryn_sounds_upload on storage.objects;
drop policy if exists oryn_sounds_read on storage.objects;
drop function if exists public.finish_sound_cleanup(uuid[]);
drop function if exists public.complete_sound_validation(uuid, boolean, text, integer, integer, text, text);
drop function if exists public.trigger_sound(uuid, uuid);
drop function if exists public.list_sound_cleanup(uuid);
drop function if exists public.remove_sound(uuid);
drop function if exists public.claim_sound_validation(uuid);
drop function if exists public.request_sound_upload(uuid, text, integer);
drop function if exists public.list_sounds(uuid);
drop function if exists public.sound_clock();
drop function if exists oryn_realtime.can_upload_sound(text);
drop function if exists oryn_realtime.can_read_sound(text);
drop table if exists oryn.sound_trigger_state;
drop table if exists oryn.sound_assets;

do $$
begin
  if pg_catalog.to_regclass('supabase_migrations.schema_migrations') is not null then
    delete from supabase_migrations.schema_migrations where version = '20261108000700';
  end if;
  -- Falha fechada: depois da reversão, public tem de ter exatamente as 20 RPCs de antes.
  if (select pg_catalog.count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public') <> 20 then
    raise exception 'oryn-94: public não ficou com as 20 RPCs; nada foi revertido' using errcode = 'P0001';
  end if;
end $$;

-- Conferência antes de confirmar: esperado 0 linhas.
select p.oid::regprocedure::text as restante from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
 where p.proname in ('sound_clock', 'list_sounds', 'request_sound_upload', 'claim_sound_validation', 'remove_sound', 'list_sound_cleanup',
                     'trigger_sound', 'complete_sound_validation', 'finish_sound_cleanup', 'can_read_sound', 'can_upload_sound')
   and n.nspname in ('public', 'oryn_realtime')
union all
select policyname::text from pg_catalog.pg_policies where schemaname = 'storage' and policyname in ('oryn_sounds_read', 'oryn_sounds_upload');

commit;
