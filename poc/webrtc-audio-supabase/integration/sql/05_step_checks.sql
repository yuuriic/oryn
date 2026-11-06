-- POC-02C.2B — VERIFICAÇÃO ENTRE MIGRAÇÕES, SOMENTE LEITURA. Rodar depois de CADA passo da aplicação
-- (0100, depois 0200, depois 0300, depois 0400, depois 0500, depois 0600, depois 0700), antes do próximo. Tolera objetos que ainda não existem.
-- Saída: step, item, status (PASS/FAIL/PENDING). PENDING = pertence a um passo ainda não aplicado.
-- Critério do passo N: nenhuma linha FAIL e nenhuma linha PENDING com step <= N.
-- O pós-voo completo (01_postflight.sql) vem depois do passo 3 e de novo depois do passo 4.

begin;
set transaction read only;

with
tables(t) as (values ('creator_grants'), ('creator_invites'), ('rooms'), ('room_members'), ('room_invites'),
                     ('room_sessions'), ('pair_counters'), ('signal_log')),
client_roles(r) as (values ('anon'), ('authenticated'), ('service_role')),
has_oryn as (select pg_catalog.to_regnamespace('oryn') is not null as ok),
has_fns as (select pg_catalog.to_regprocedure('public.join_room(uuid)') is not null as ok),
-- MVP 01 (0400): as 2 RPCs de gerenciamento de salas.
fns_0400(sig) as (values ('public.list_my_rooms()'), ('public.close_room(uuid)')),
has_0400 as (select pg_catalog.to_regprocedure('public.close_room(uuid)') is not null as ok),
-- Chat por sala (0500): as 2 tabelas e as 2 RPCs do chat.
fns_0500(sig) as (values ('public.send_room_message(uuid,uuid,text)'), ('public.list_room_messages(uuid,bigint,bigint,integer)')),
has_0500 as (select pg_catalog.to_regclass('oryn.room_messages') is not null as ok),
-- Salas de grupo (0600): as 4 RPCs, as 4 funções internas e os 2 gatilhos.
fns_0600(sig) as (values ('public.list_room_members(uuid)'), ('public.get_voice_participants(uuid)'),
                         ('public.leave_room_membership(uuid)'), ('public.remove_room_member(uuid,text)')),
fns_0600_internal(sig) as (values ('oryn.member_ref(uuid,uuid)'), ('oryn.enforce_room_capacity()'),
                                  ('oryn.guard_member_reactivation()'), ('oryn.end_membership(uuid,uuid,text)')),
has_0600 as (select pg_catalog.to_regprocedure('public.remove_room_member(uuid,text)') is not null as ok),
-- Soundboard (0700): 7 RPCs de usuário, 2 do servidor, 2 predicados, 2 tabelas, o bucket e 2 políticas.
fns_0700(sig) as (values ('public.sound_clock()'), ('public.list_sounds(uuid)'), ('public.request_sound_upload(uuid,text,integer)'),
                         ('public.claim_sound_validation(uuid)'), ('public.remove_sound(uuid)'), ('public.list_sound_cleanup(uuid)'),
                         ('public.trigger_sound(uuid,uuid)')),
fns_0700_service(sig) as (values ('public.complete_sound_validation(uuid,boolean,text,integer,integer,text,text)'), ('public.finish_sound_cleanup(uuid[])')),
fns_0700_predicate(sig) as (values ('oryn_realtime.can_read_sound(text)'), ('oryn_realtime.can_upload_sound(text)')),
has_0700 as (select pg_catalog.to_regprocedure('public.trigger_sound(uuid,uuid)') is not null as ok),
c(step, item, ok, present) as (
  -- Passo 1 (0100): schema, tabelas, RLS, nenhum acesso de cliente.
  select 1, 'oryn: 8 tabelas (fora a da 0500)',
         (select pg_catalog.count(*) filter (where k.relname not in ('room_messages', 'room_message_counters', 'sound_assets', 'sound_trigger_state')) = 8 from pg_catalog.pg_class k join pg_catalog.pg_namespace n on n.oid = k.relnamespace
           where n.nspname = 'oryn' and k.relkind = 'r'), (select ok from has_oryn)
  union all
  select 1, 'oryn.' || t || ': RLS ligado e dono = ' || current_user,
         coalesce((select k.relrowsecurity and k.relowner = (select oid from pg_catalog.pg_roles where rolname = current_user)
                     from pg_catalog.pg_class k where k.oid = pg_catalog.to_regclass('oryn.' || t)), false),
         (select ok from has_oryn)
    from tables
  union all
  select 1, 'nenhum privilégio de ' || r || ' nas tabelas de oryn',
         not exists (select 1 from pg_catalog.pg_class k join pg_catalog.pg_namespace n on n.oid = k.relnamespace,
                            pg_catalog.aclexplode(coalesce(k.relacl, pg_catalog.acldefault('r', k.relowner))) a
                      where n.nspname = 'oryn' and a.grantee = (select oid from pg_catalog.pg_roles where rolname = r)),
         (select ok from has_oryn)
    from client_roles
  union all
  select 1, 'sem USAGE de ' || r || ' no schema oryn',
         case when (select ok from has_oryn) then not pg_catalog.has_schema_privilege(r, 'oryn', 'USAGE') else false end,
         (select ok from has_oryn)
    from client_roles
  union all
  -- Passo 2 (0200): exatamente as 12 RPCs, EXECUTE do contrato, search_path vazio. As da 0400 (passo 4)
  -- ficam fora da contagem, para o item continuar valendo depois do passo 4.
  select 2, 'public: exatamente 12 funções (fora as da 0400), todas SECURITY DEFINER com search_path vazio',
         (select pg_catalog.count(*) filter (where p.proname not in ('list_my_rooms', 'close_room', 'send_room_message', 'list_room_messages', 'list_room_members', 'get_voice_participants', 'leave_room_membership', 'remove_room_member', 'sound_clock', 'list_sounds', 'request_sound_upload', 'claim_sound_validation', 'remove_sound', 'list_sound_cleanup', 'trigger_sound', 'complete_sound_validation', 'finish_sound_cleanup')) = 12
                 and pg_catalog.bool_and(p.prosecdef and 'search_path=""' = any (coalesce(p.proconfig, '{}')))
            from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'),
         (select ok from has_fns)
  union all
  select 2, 'anon sem EXECUTE em nenhuma função de public/oryn/oryn_realtime',
         not exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
                      where n.nspname in ('public', 'oryn', 'oryn_realtime') and pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')),
         (select ok from has_fns)
  union all
  select 2, 'set_signal_state só para service_role',
         case when (select ok from has_fns) then
           pg_catalog.has_function_privilege('service_role', 'public.set_signal_state(uuid,text)', 'EXECUTE')
           and not pg_catalog.has_function_privilege('authenticated', 'public.set_signal_state(uuid,text)', 'EXECUTE')
         else false end,
         (select ok from has_fns)
  union all
  select 2, 'can_receive_topic: authenticated sim, anon não',
         case when pg_catalog.to_regprocedure('oryn_realtime.can_receive_topic(text)') is not null then
           pg_catalog.has_function_privilege('authenticated', 'oryn_realtime.can_receive_topic(text)', 'EXECUTE')
           and not pg_catalog.has_function_privilege('anon', 'oryn_realtime.can_receive_topic(text)', 'EXECUTE')
         else false end,
         (select ok from has_fns)
  union all
  -- Passo 3 (0300): 4 políticas da Oryn (3 restritivas) e RLS de realtime.messages intocado.
  select 3, 'realtime.messages: 4 políticas oryn_* (3 restritivas)',
         (select pg_catalog.count(*) = 4 and pg_catalog.count(*) filter (where permissive = 'RESTRICTIVE') = 3
            from pg_catalog.pg_policies where schemaname = 'realtime' and tablename = 'messages' and policyname like 'oryn_%'),
         exists (select 1 from pg_catalog.pg_policies where schemaname = 'realtime' and policyname like 'oryn_%')
  union all
  select 3, 'realtime.messages: RLS ligado',
         (select relrowsecurity from pg_catalog.pg_class where oid = 'realtime.messages'::regclass),
         exists (select 1 from pg_catalog.pg_policies where schemaname = 'realtime' and policyname like 'oryn_%')
  union all
  -- Passo 4 (0400, MVP 01): 2 RPCs novas, mesmas regras; nada mais muda (14 funções em public, fora as da 0500).
  select 4, 'public: exatamente 14 funções (fora as da 0500), todas SECURITY DEFINER com search_path vazio',
         (select pg_catalog.count(*) filter (where p.proname not in ('send_room_message', 'list_room_messages', 'list_room_members', 'get_voice_participants', 'leave_room_membership', 'remove_room_member', 'sound_clock', 'list_sounds', 'request_sound_upload', 'claim_sound_validation', 'remove_sound', 'list_sound_cleanup', 'trigger_sound', 'complete_sound_validation', 'finish_sound_cleanup')) = 14
                 and pg_catalog.bool_and(p.prosecdef and 'search_path=""' = any (coalesce(p.proconfig, '{}')))
            from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'),
         (select ok from has_0400)
  union all
  select 4, sig || ': EXECUTE só para authenticated (anon, service_role e PUBLIC não)',
         case when pg_catalog.to_regprocedure(sig) is not null then
           pg_catalog.has_function_privilege('authenticated', sig, 'EXECUTE')
           and not pg_catalog.has_function_privilege('anon', sig, 'EXECUTE')
           and not pg_catalog.has_function_privilege('service_role', sig, 'EXECUTE')
           and not exists (select 1 from pg_catalog.pg_proc p, pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
                            where p.oid = pg_catalog.to_regprocedure(sig) and a.grantee = 0 and a.privilege_type = 'EXECUTE')
         else false end,
         (select ok from has_0400)
    from fns_0400
  union all
  -- Passo 5 (0500, chat por sala): tabela privada, com RLS e sem privilégio de cliente, e 2 RPCs novas (16 funções em public).
  select 5, t || ': RLS ligado e nenhum privilégio de cliente',
         case when (select ok from has_0500) and pg_catalog.to_regclass(t) is not null then
           (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = pg_catalog.to_regclass(t))
           and not exists (select 1 from pg_catalog.pg_class c, pg_catalog.aclexplode(coalesce(c.relacl, pg_catalog.acldefault('r', c.relowner))) a
                            where c.oid = pg_catalog.to_regclass(t) and a.grantee <> c.relowner)
         else false end,
         (select ok from has_0500)
    from (values ('oryn.room_messages'), ('oryn.room_message_counters')) as chat_tables(t)
  union all
  select 5, 'public: exatamente 16 funções (fora as da 0600), todas SECURITY DEFINER com search_path vazio',
         (select pg_catalog.count(*) filter (where p.proname not in ('list_room_members', 'get_voice_participants', 'leave_room_membership', 'remove_room_member', 'sound_clock', 'list_sounds', 'request_sound_upload', 'claim_sound_validation', 'remove_sound', 'list_sound_cleanup', 'trigger_sound', 'complete_sound_validation', 'finish_sound_cleanup')) = 16
                 and pg_catalog.bool_and(p.prosecdef and 'search_path=""' = any (coalesce(p.proconfig, '{}')))
            from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'),
         (select ok from has_0500)
  union all
  select 5, sig || ': EXECUTE só para authenticated (anon, service_role e PUBLIC não)',
         case when pg_catalog.to_regprocedure(sig) is not null then
           pg_catalog.has_function_privilege('authenticated', sig, 'EXECUTE')
           and not pg_catalog.has_function_privilege('anon', sig, 'EXECUTE')
           and not pg_catalog.has_function_privilege('service_role', sig, 'EXECUTE')
           and not exists (select 1 from pg_catalog.pg_proc p, pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
                            where p.oid = pg_catalog.to_regprocedure(sig) and a.grantee = 0 and a.privilege_type = 'EXECUTE')
         else false end,
         (select ok from has_0500)
    from fns_0500
  union all
  -- Passo 6 (0600, salas de grupo): 4 RPCs novas (20 funções em public), internas sem EXECUTE de cliente e 2 gatilhos ativos.
  select 6, 'public: exatamente 20 funções (fora as da 0700), todas SECURITY DEFINER com search_path vazio',
         (select pg_catalog.count(*) filter (where p.proname not in ('sound_clock', 'list_sounds', 'request_sound_upload', 'claim_sound_validation', 'remove_sound', 'list_sound_cleanup', 'trigger_sound', 'complete_sound_validation', 'finish_sound_cleanup')) = 20 and pg_catalog.bool_and(p.prosecdef and 'search_path=""' = any (coalesce(p.proconfig, '{}')))
            from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'),
         (select ok from has_0600)
  union all
  select 6, sig || ': EXECUTE só para authenticated (anon, service_role e PUBLIC não)',
         case when pg_catalog.to_regprocedure(sig) is not null then
           pg_catalog.has_function_privilege('authenticated', sig, 'EXECUTE')
           and not pg_catalog.has_function_privilege('anon', sig, 'EXECUTE')
           and not pg_catalog.has_function_privilege('service_role', sig, 'EXECUTE')
           and not exists (select 1 from pg_catalog.pg_proc p, pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
                            where p.oid = pg_catalog.to_regprocedure(sig) and a.grantee = 0 and a.privilege_type = 'EXECUTE')
         else false end,
         (select ok from has_0600)
    from fns_0600
  union all
  select 6, sig || ': nenhum papel de cliente executa',
         case when pg_catalog.to_regprocedure(sig) is not null then
           not pg_catalog.has_function_privilege('authenticated', sig, 'EXECUTE')
           and not pg_catalog.has_function_privilege('anon', sig, 'EXECUTE')
           and not pg_catalog.has_function_privilege('service_role', sig, 'EXECUTE')
         else false end,
         (select ok from has_0600)
    from fns_0600_internal
  union all
  select 6, 'gatilhos oryn_room_capacity e oryn_member_reactivation ativos',
         (select pg_catalog.count(*) = 2 from pg_catalog.pg_trigger t
           where not t.tgisinternal and t.tgenabled = 'O' and t.tgname in ('oryn_room_capacity', 'oryn_member_reactivation')),
         (select ok from has_0600)
  union all
  -- Passo 7 (0700, soundboard): 29 funções em public, tabelas sem acesso direto, bucket privado e só 2 políticas no Storage.
  select 7, 'public: exatamente 29 funções, todas SECURITY DEFINER com search_path vazio',
         (select pg_catalog.count(*) = 29 and pg_catalog.bool_and(p.prosecdef and 'search_path=""' = any (coalesce(p.proconfig, '{}')))
            from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'),
         (select ok from has_0700)
  union all
  select 7, sig || ': EXECUTE só para authenticated',
         case when pg_catalog.to_regprocedure(sig) is not null then
           pg_catalog.has_function_privilege('authenticated', sig, 'EXECUTE')
           and not pg_catalog.has_function_privilege('anon', sig, 'EXECUTE')
           and not pg_catalog.has_function_privilege('service_role', sig, 'EXECUTE')
         else false end,
         (select ok from has_0700)
    from fns_0700
  union all
  select 7, sig || ': EXECUTE só para service_role',
         case when pg_catalog.to_regprocedure(sig) is not null then
           pg_catalog.has_function_privilege('service_role', sig, 'EXECUTE')
           and not pg_catalog.has_function_privilege('authenticated', sig, 'EXECUTE')
           and not pg_catalog.has_function_privilege('anon', sig, 'EXECUTE')
         else false end,
         (select ok from has_0700)
    from fns_0700_service
  union all
  select 7, sig || ': authenticated sim, anon e service_role não',
         case when pg_catalog.to_regprocedure(sig) is not null then
           pg_catalog.has_function_privilege('authenticated', sig, 'EXECUTE')
           and not pg_catalog.has_function_privilege('anon', sig, 'EXECUTE')
           and not pg_catalog.has_function_privilege('service_role', sig, 'EXECUTE')
         else false end,
         (select ok from has_0700)
    from fns_0700_predicate
  union all
  select 7, t || ': RLS ligado, sem política e sem privilégio de cliente',
         case when pg_catalog.to_regclass(t) is not null then
           (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = t::regclass)
           and not exists (select 1 from pg_catalog.pg_policies p where p.schemaname || '.' || p.tablename = t)
           and not pg_catalog.has_table_privilege('authenticated', t, 'SELECT')
           and not pg_catalog.has_table_privilege('anon', t, 'SELECT')
           and not pg_catalog.has_table_privilege('service_role', t, 'SELECT')
         else false end,
         (select ok from has_0700)
    from (values ('oryn.sound_assets'), ('oryn.sound_trigger_state')) as sound_tables(t)
  union all
  select 7, 'bucket oryn-sounds privado, com 2 MiB e só MP3 e WAV',
         exists (select 1 from storage.buckets b where b.id = 'oryn-sounds' and not b.public and b.file_size_limit = 2097152
                  and b.allowed_mime_types = array['audio/mpeg', 'audio/wav']),
         (select ok from has_0700)
  union all
  select 7, 'storage.objects: só as políticas oryn_sounds_read (SELECT) e oryn_sounds_upload (INSERT), para authenticated',
         (select pg_catalog.count(*) = 2 and pg_catalog.count(*) filter (where cmd = 'SELECT' and policyname = 'oryn_sounds_read') = 1
                 and pg_catalog.count(*) filter (where cmd = 'INSERT' and policyname = 'oryn_sounds_upload') = 1
                 and pg_catalog.bool_and(roles = array['authenticated']::name[])
            from pg_catalog.pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'oryn\_%'),
         (select ok from has_0700)
)
select step, item, case when not present then 'PENDING' when ok then 'PASS' else 'FAIL' end as status
  from c
 order by step, (case when not present then 'PENDING' when ok then 'PASS' else 'FAIL' end) <> 'FAIL', item;

rollback;
