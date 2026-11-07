-- Soundboard por sala (Etapa Macro 5): catálogo privado, arquivos em Storage privado, quarentena e disparo por evento.
--
-- Aditiva: cria 2 tabelas, 9 RPCs, 2 predicados, 1 bucket e 2 políticas em storage.objects. Não altera tabela, política,
-- publicação nem corpo de função existente. A Edge Function `signal` e o transporte de voz não mudam.
--
-- O arquivo nunca passa pelo Realtime nem pelo WebRTC. O clique vira um evento curto, e cada cliente toca a própria cópia.
--
-- Estados de um som:
--   quarantine     reservado pelo dono, com prazo de envio; ninguém lê o objeto;
--   available      validado pela função `sound-media`, com hash, formato, tamanho e duração reais; imutável;
--   rejected       recusado na validação; o objeto é apagado em seguida;
--   pending_delete removido pelo dono: sai do catálogo e deixa de ser lido na hora; o objeto é apagado depois;
--   deleted        objeto apagado; a linha fica como registro.
--
-- Exclusão em dois tempos: SQL e Storage não são atômicos. `remove_sound` e um envio vencido deixam o trabalho pendente, e
-- `sound-media` apaga o objeto e confirma. Repetir é seguro. Sem agendador: a limpeza roda quando o dono remove ou abre o
-- painel. Objetos sem linha, por exclusão de conta ou sala, são listados por integration/sql/15_sound_orphans.sql.

-- ---------------------------------------------------------------- tabelas ----------------------------

create table oryn.sound_assets (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  room_id uuid not null references oryn.rooms (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (pg_catalog.char_length(name) between 1 and 40 and name !~ '[[:cntrl:]]'),
  version integer not null default 1 check (version >= 1),
  object_key text not null unique,
  state text not null default 'quarantine' check (state in ('quarantine', 'available', 'rejected', 'pending_delete', 'deleted')),
  sha256 text check (sha256 ~ '^[0-9a-f]{64}$'),
  mime text check (mime in ('audio/mpeg', 'audio/wav')),
  size_bytes integer check (size_bytes between 1 and 2097152),
  duration_ms integer check (duration_ms between 1 and 10000),
  reject_reason text check (pg_catalog.char_length(reject_reason) <= 40),
  created_at timestamptz not null default pg_catalog.now(),
  upload_expires_at timestamptz not null,
  validated_at timestamptz,
  delete_requested_at timestamptz,
  object_deleted_at timestamptz,
  constraint sound_assets_available_complete check (
    state <> 'available' or (sha256 is not null and mime is not null and size_bytes is not null and duration_ms is not null and validated_at is not null))
);
create index sound_assets_room_state_idx on oryn.sound_assets (room_id, state);

-- Último disparo por conta e sala. A linha é o que torna o cooldown exato sob concorrência, inclusive entre duas sessões da conta.
create table oryn.sound_trigger_state (
  room_id uuid not null references oryn.rooms (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  last_at timestamptz not null,
  primary key (room_id, user_id)
);

-- Acesso direto negado: RLS ligado, nenhuma política, nenhum privilégio. Só as RPCs abaixo alcançam as tabelas.
alter table oryn.sound_assets enable row level security;
alter table oryn.sound_trigger_state enable row level security;
revoke all on oryn.sound_assets, oryn.sound_trigger_state from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- bucket e políticas ------------------

-- Os limites do bucket são a primeira barreira; a prova do conteúdo é da função `sound-media`.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('oryn-sounds', 'oryn-sounds', false, 2097152, array['audio/mpeg', 'audio/wav'])
on conflict (id) do nothing;

-- Predicados das políticas: a chave do objeto precisa existir no catálogo, e a pasta sozinha não prova nada.
create function oryn_realtime.can_read_sound(p_key text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from oryn.sound_assets a
     where a.object_key = p_key and a.state = 'available' and oryn.is_active_member(a.room_id, auth.uid()))
$$;

-- Só o dono da sala, no envio que ele reservou e dentro do prazo. Sem política de UPDATE nem DELETE: o objeto enviado não muda.
create function oryn_realtime.can_upload_sound(p_key text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from oryn.sound_assets a
      join oryn.rooms r on r.id = a.room_id
     where a.object_key = p_key and a.state = 'quarantine' and a.upload_expires_at > pg_catalog.now()
       and a.owner_id = auth.uid() and r.owner_id = auth.uid() and oryn.is_active_member(a.room_id, auth.uid()))
$$;

create policy oryn_sounds_read on storage.objects
  as permissive for select to authenticated
  using (bucket_id = 'oryn-sounds' and oryn_realtime.can_read_sound(name));

create policy oryn_sounds_upload on storage.objects
  as permissive for insert to authenticated
  with check (bucket_id = 'oryn-sounds' and oryn_realtime.can_upload_sound(name));

-- ---------------------------------------------------------------- RPCs de usuário ---------------------

-- Hora do servidor, para o cliente estimar a diferença do próprio relógio. Não revela nada além da hora.
create function public.sound_clock() returns timestamptz
language plpgsql volatile security definer set search_path = '' as $$
declare v_uid uuid := oryn.require_uid();
begin
  return pg_catalog.clock_timestamp();
end $$;

-- Catálogo da sala, só para membro ativo de sala aberta. O dono vê também os envios em andamento.
create function public.list_sounds(p_room_id uuid)
returns table (asset_id uuid, name text, version integer, sha256 text, mime text, size_bytes integer, duration_ms integer, state text, created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := oryn.require_uid();
begin
  if not oryn.is_active_member(p_room_id, v_uid) then
    raise exception 'not-member' using errcode = '42501';
  end if;
  return query
    select a.id, a.name, a.version, a.sha256, a.mime, a.size_bytes, a.duration_ms, a.state, a.created_at
      from oryn.sound_assets a
      join oryn.rooms r on r.id = a.room_id
     where a.room_id = p_room_id
       and (a.state = 'available' or (a.state = 'quarantine' and a.upload_expires_at > pg_catalog.now() and r.owner_id = v_uid))
     order by a.created_at, a.id;
end $$;

-- Reserva o envio de um som. A sala travada torna exato o limite de 20, contando os envios ainda no prazo.
-- Sala alheia, inexistente ou encerrada e chamador sem poder têm a mesma resposta.
create function public.request_sound_upload(p_room_id uuid, p_name text, p_size_bytes integer)
returns table (asset_id uuid, object_key text, upload_expires_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := oryn.require_uid(); v_name text := pg_catalog.btrim(p_name); v_id uuid := pg_catalog.gen_random_uuid(); v_key text; v_exp timestamptz;
begin
  perform 1 from oryn.rooms r where r.id = p_room_id and r.owner_id = v_uid and r.closed_at is null for no key update;
  if not found or not oryn.is_active_member(p_room_id, v_uid) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if not oryn.valid_label(v_name, 40) or p_size_bytes is null or p_size_bytes not between 1 and 2097152 then
    raise exception 'invalid-argument' using errcode = 'P0001';
  end if;
  if (select pg_catalog.count(*) from oryn.sound_assets a
       where a.room_id = p_room_id
         and (a.state = 'available' or (a.state = 'quarantine' and a.upload_expires_at > pg_catalog.now()))) >= 20 then
    raise exception 'sound-quota' using errcode = 'P0001';
  end if;
  v_key := p_room_id::text || '/' || v_id::text || '/v1';
  v_exp := pg_catalog.now() + interval '10 minutes';
  insert into oryn.sound_assets (id, room_id, owner_id, name, object_key, upload_expires_at)
  values (v_id, p_room_id, v_uid, v_name, v_key, v_exp);
  return query select v_id, v_key, v_exp;
end $$;

-- Primeira parte da validação, com o JWT do dono: devolve a chave do objeto a conferir. A função não decide quem pode.
create function public.claim_sound_validation(p_asset_id uuid) returns text
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := oryn.require_uid(); v_state text; v_key text; v_exp timestamptz;
begin
  select a.state, a.object_key, a.upload_expires_at into v_state, v_key, v_exp
    from oryn.sound_assets a join oryn.rooms r on r.id = a.room_id
   where a.id = p_asset_id and r.owner_id = v_uid and r.closed_at is null and oryn.is_active_member(a.room_id, v_uid);
  if not found then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if v_state <> 'quarantine' or v_exp <= pg_catalog.now() then
    raise exception 'sound-unavailable' using errcode = 'P0001';
  end if;
  return v_key;
end $$;

-- Remoção pelo dono. Sai do catálogo e deixa de ser lido na hora; o objeto é apagado depois. Idempotente.
create function public.remove_sound(p_asset_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := oryn.require_uid(); v_room uuid;
begin
  select a.room_id into v_room from oryn.sound_assets a where a.id = p_asset_id;
  if not found then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  perform 1 from oryn.rooms r where r.id = v_room and r.owner_id = v_uid for no key update;
  if not found or not oryn.is_active_member(v_room, v_uid) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  update oryn.sound_assets set state = 'pending_delete', delete_requested_at = pg_catalog.now()
   where id = p_asset_id and state in ('quarantine', 'available');
end $$;

-- Objetos a apagar numa sala, com o JWT do dono: removidos, recusados ainda não apagados e envios vencidos.
create function public.list_sound_cleanup(p_room_id uuid)
returns table (asset_id uuid, object_key text)
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := oryn.require_uid();
begin
  if not exists (select 1 from oryn.rooms r where r.id = p_room_id and r.owner_id = v_uid)
     or not oryn.is_active_member(p_room_id, v_uid) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  return query
    select a.id, a.object_key from oryn.sound_assets a
     where a.room_id = p_room_id
       and (a.state = 'pending_delete'
            or (a.state = 'rejected' and a.object_deleted_at is null)
            or (a.state = 'quarantine' and a.upload_expires_at <= pg_catalog.now()))
     order by a.created_at, a.id
     limit 50;
end $$;

-- Disparo. Remetente e sala vêm da sessão no banco, nunca do cliente. O evento tem identificador gerado aqui e prazo de 2 s,
-- e não é repetido: um disparo sem resposta não volta a tocar depois. Sem trava da sala: o cooldown é a própria linha.
-- O INSERT … ON CONFLICT serializa disparos simultâneos da mesma conta, e só um passa a cada 2 s.
create function public.trigger_sound(p_session_id uuid, p_asset_id uuid)
returns table (event_id uuid, asset_id uuid, version integer, sha256 text, issued_at timestamptz, expires_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := oryn.require_uid(); v_room uuid; v_last timestamptz; v_version integer; v_hash text;
        v_now timestamptz := pg_catalog.clock_timestamp(); v_event uuid := pg_catalog.gen_random_uuid();
begin
  select s.room_id, s.last_seen_at into v_room, v_last from oryn.room_sessions s
   where s.id = p_session_id and s.user_id = v_uid and s.revoked_at is null;
  if not found or not oryn.session_is_fresh(v_last) or not oryn.is_active_member(v_room, v_uid) then
    raise exception 'session-invalid' using errcode = '42501';
  end if;
  select a.version, a.sha256 into v_version, v_hash from oryn.sound_assets a
   where a.id = p_asset_id and a.room_id = v_room and a.state = 'available';
  if not found then
    raise exception 'sound-unavailable' using errcode = 'P0001';
  end if;
  insert into oryn.sound_trigger_state as t (room_id, user_id, last_at) values (v_room, v_uid, v_now)
  on conflict (room_id, user_id) do update set last_at = excluded.last_at
    where t.last_at <= excluded.last_at - interval '2 seconds';
  if not found then
    raise exception 'rate-limited' using errcode = 'P0001';
  end if;
  perform oryn.publish_control(v_room, p_session_id, 'sound', pg_catalog.jsonb_build_object(
    'event_id', v_event, 'session_id', p_session_id, 'sender_ref', oryn.member_ref(v_room, v_uid),
    'asset_id', p_asset_id, 'version', v_version, 'sha256', v_hash,
    'issued_at', v_now, 'expires_at', v_now + interval '2 seconds'));
  return query select v_event, p_asset_id, v_version, v_hash, v_now, v_now + interval '2 seconds';
end $$;

-- ---------------------------------------------------------------- RPCs do servidor (só service_role) --

-- Registra o resultado da validação. Quem prova o conteúdo é a função `sound-media`; nenhum cliente alcança esta RPC.
create function public.complete_sound_validation(p_asset_id uuid, p_ok boolean, p_mime text, p_size_bytes integer, p_duration_ms integer, p_sha256 text, p_reason text)
returns text
language plpgsql security definer set search_path = '' as $$
declare v_state text; v_exp timestamptz; v_hash text;
begin
  select a.state, a.upload_expires_at, a.sha256 into v_state, v_exp, v_hash from oryn.sound_assets a where a.id = p_asset_id for update;
  if not found then
    raise exception 'not-found' using errcode = 'P0001';
  end if;
  if v_state = 'available' and p_ok and v_hash = p_sha256 then
    return v_state;
  end if;
  if v_state <> 'quarantine' then
    raise exception 'sound-unavailable' using errcode = 'P0001';
  end if;
  if p_ok and v_exp > pg_catalog.now() then
    update oryn.sound_assets set state = 'available', mime = p_mime, size_bytes = p_size_bytes, duration_ms = p_duration_ms,
           sha256 = p_sha256, validated_at = pg_catalog.now()
     where id = p_asset_id;
    return 'available';
  end if;
  update oryn.sound_assets set state = 'rejected', reject_reason = case when p_ok then 'upload-expired' else p_reason end, validated_at = pg_catalog.now()
   where id = p_asset_id;
  return 'rejected';
end $$;

-- Confirma que os objetos foram apagados. Repetir é seguro: só muda quem ainda está pendente.
create function public.finish_sound_cleanup(p_asset_ids uuid[]) returns integer
language plpgsql security definer set search_path = '' as $$
declare v_n integer;
begin
  update oryn.sound_assets set object_deleted_at = pg_catalog.now(),
         state = case when state = 'rejected' then 'rejected' else 'deleted' end
   where id = any (p_asset_ids) and object_deleted_at is null
     and (state in ('pending_delete', 'rejected') or (state = 'quarantine' and upload_expires_at <= pg_catalog.now()));
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- ---------------------------------------------------------------- permissões explícitas ---------------

revoke all on function public.sound_clock(), public.list_sounds(uuid), public.request_sound_upload(uuid, text, integer),
  public.claim_sound_validation(uuid), public.remove_sound(uuid), public.list_sound_cleanup(uuid), public.trigger_sound(uuid, uuid),
  public.complete_sound_validation(uuid, boolean, text, integer, integer, text, text), public.finish_sound_cleanup(uuid[]),
  oryn_realtime.can_read_sound(text), oryn_realtime.can_upload_sound(text)
  from public, anon, authenticated, service_role;
grant execute on function public.sound_clock(), public.list_sounds(uuid), public.request_sound_upload(uuid, text, integer),
  public.claim_sound_validation(uuid), public.remove_sound(uuid), public.list_sound_cleanup(uuid), public.trigger_sound(uuid, uuid),
  oryn_realtime.can_read_sound(text), oryn_realtime.can_upload_sound(text)
  to authenticated;
grant execute on function public.complete_sound_validation(uuid, boolean, text, integer, integer, text, text), public.finish_sound_cleanup(uuid[])
  to service_role;

-- Autoverificação (falha fechada): se qualquer condição falhar, a migração inteira é desfeita.
do $$
declare v_fn text;
begin
  foreach v_fn in array array['public.sound_clock()', 'public.list_sounds(uuid)', 'public.request_sound_upload(uuid,text,integer)',
                              'public.claim_sound_validation(uuid)', 'public.remove_sound(uuid)', 'public.list_sound_cleanup(uuid)',
                              'public.trigger_sound(uuid,uuid)'] loop
    if not exists (select 1 from pg_catalog.pg_proc p
                    where p.oid = v_fn::regprocedure and p.prosecdef and 'search_path=""' = any (coalesce(p.proconfig, '{}')))
       or pg_catalog.has_function_privilege('anon', v_fn, 'EXECUTE')
       or pg_catalog.has_function_privilege('service_role', v_fn, 'EXECUTE')
       or not pg_catalog.has_function_privilege('authenticated', v_fn, 'EXECUTE') then
      raise exception 'oryn-0700: definição ou permissões inesperadas em %', v_fn using errcode = 'P0001';
    end if;
  end loop;
  foreach v_fn in array array['public.complete_sound_validation(uuid,boolean,text,integer,integer,text,text)', 'public.finish_sound_cleanup(uuid[])'] loop
    if not pg_catalog.has_function_privilege('service_role', v_fn, 'EXECUTE')
       or pg_catalog.has_function_privilege('authenticated', v_fn, 'EXECUTE')
       or pg_catalog.has_function_privilege('anon', v_fn, 'EXECUTE') then
      raise exception 'oryn-0700: permissões inesperadas em %', v_fn using errcode = 'P0001';
    end if;
  end loop;
  if not exists (select 1 from storage.buckets b
                  where b.id = 'oryn-sounds' and not b.public and b.file_size_limit = 2097152
                    and b.allowed_mime_types = array['audio/mpeg', 'audio/wav']) then
    raise exception 'oryn-0700: bucket oryn-sounds fora do contrato' using errcode = 'P0001';
  end if;
  if (select pg_catalog.count(*) from pg_catalog.pg_policies
       where schemaname = 'storage' and tablename = 'objects' and policyname in ('oryn_sounds_read', 'oryn_sounds_upload')) <> 2 then
    raise exception 'oryn-0700: políticas de Storage ausentes' using errcode = 'P0001';
  end if;
end $$;
