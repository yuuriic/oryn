-- Salas de grupo e ciclo de vida de membros: capacidade de até 4 contas, lista de membros, saída e remoção, e a identidade
-- de participante de que a voz multiponto precisa.
--
-- Aditiva: cria 7 funções e 2 gatilhos. Não altera tabela, política, publicação nem o corpo de função existente. Os
-- gatilhos deixam mais restritos dois comportamentos, sem mudar assinatura ou códigos de erro:
-- - oryn.rooms: sala NOVA com mais de 4 lugares é recusada. Salas antigas não são tocadas. create_room continua
--   validando 2 a 10 antes de inserir; o limite real passa a ser este.
-- - oryn.room_members: uma conta que saiu ou foi removida só volta por convite emitido DEPOIS disso.
--
-- Pertença: `removed_at` já existia, e chat, roster, sessões e Realtime já o respeitam. Faltava quem o preenchesse.
--
-- Travas das duas operações de saída, na mesma ordem de close_room:
-- 1. a sala; 2. a linha do membro; 3. as sessões dele (UPDATE); 4. os convites SEM ESPERAR (SKIP LOCKED); 5. o membro (UPDATE).
-- - join_room trava a linha de membro antes de conferir a pertença: se chegou antes, esta operação espera e revoga também a
--   sessão recém-criada; se chegou depois, ele espera e, ao reconferir, encontra o membro removido (not-member).
-- - redeem_room_invite trava o CONVITE e depois a SALA. Esperar por um convite aqui, com a sala travada, formaria ciclo. Por
--   isso os convites vão com SKIP LOCKED. Um convite pulado está com um resgate em curso: se for da conta que acabou de sair,
--   o gatilho de reativação o recusa depois da espera.
-- - send_room_message, close_room e create_room_invite travam a sala primeiro: serializam-se por ela.

-- ---------------------------------------------------------------- auxiliares (schema oryn) ----------

-- Referência opaca de uma conta numa sala: estável na sala, diferente entre salas, sem revelar nem permitir comparar o id
-- da conta entre salas. Não é segredo nem autorização: quem decide é sempre o servidor, a partir do JWT.
create function oryn.member_ref(p_room uuid, p_user uuid) returns text
language sql immutable set search_path = '' as $$
  select pg_catalog.substr(pg_catalog.encode(oryn.token_hash(p_room::text || ':' || p_user::text), 'hex'), 1, 32)
$$;

-- Limite do MVP: até 4 contas por sala, inclusive o dono. Só em salas novas, para não invalidar registros antigos.
create function oryn.enforce_room_capacity() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.max_members > 4 then
    raise exception 'invalid-argument' using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger oryn_room_capacity before insert on oryn.rooms
  for each row execute function oryn.enforce_room_capacity();

-- Quem saiu ou foi removido só volta por convite emitido depois disso. redeem_room_invite marca o convite como usado na
-- mesma transação, antes de reativar: é esse convite que se confere aqui. O erro desfaz o resgate, e o convite não é consumido.
create function oryn.guard_member_reactivation() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.removed_at is not null and new.removed_at is null and not exists (
    select 1 from oryn.room_invites i
     where i.room_id = new.room_id and i.used_by = new.user_id and i.used_at = pg_catalog.now()
       and i.created_at > old.removed_at
  ) then
    raise exception 'invite-invalid' using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger oryn_member_reactivation before update of removed_at on oryn.room_members
  for each row execute function oryn.guard_member_reactivation();

-- Núcleo de sair e remover. Só chamado pelas duas RPCs abaixo, com a sala já travada e a autorização já decidida.
-- O `bye` vai a TODAS as sessões vivas, inclusive às do próprio membro: é como elas sabem que a sessão acabou.
create function oryn.end_membership(p_room uuid, p_user uuid, p_reason text) returns void
language plpgsql set search_path = '' as $$
declare v_sid uuid;
begin
  perform 1 from oryn.room_members m where m.room_id = p_room and m.user_id = p_user for no key update;
  for v_sid in
    select s.id from oryn.room_sessions s
     where s.room_id = p_room and s.user_id = p_user and s.revoked_at is null and oryn.session_is_fresh(s.last_seen_at)
     order by s.id
  loop
    perform oryn.publish_control(p_room, null, 'bye', pg_catalog.jsonb_build_object('session_id', v_sid));
  end loop;
  update oryn.room_sessions set revoked_at = pg_catalog.now(), revoke_reason = p_reason
   where room_id = p_room and user_id = p_user and revoked_at is null;
  update oryn.room_invites set revoked_at = pg_catalog.now()
   where id in (select i.id from oryn.room_invites i
                 where i.room_id = p_room and i.used_at is null and i.revoked_at is null and i.expires_at > pg_catalog.now()
                   and (p_reason = 'removed' or i.created_by = p_user)
                   for no key update skip locked);
  update oryn.room_members set removed_at = pg_catalog.clock_timestamp() where room_id = p_room and user_id = p_user;
end $$;

-- ---------------------------------------------------------------- RPCs de usuário (schema public) -----

-- Membros ativos da sala, aberta ou encerrada, só para membro ativo. Sem conta de ninguém: nome na sala, papel, indicação de
-- si mesmo e presença na chamada. A referência serve só para pedir a remoção. Sala alheia ou inexistente: mesma resposta.
create function public.list_room_members(p_room_id uuid)
returns table (member_ref text, display_name text, role text, is_self boolean, in_call boolean, joined_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := oryn.require_uid();
begin
  perform 1 from oryn.room_members m where m.room_id = p_room_id and m.user_id = v_uid and m.removed_at is null;
  if not found then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  return query
    select oryn.member_ref(m.room_id, m.user_id), m.display_name, m.role, m.user_id = v_uid,
           exists (select 1 from oryn.room_sessions s
                    where s.room_id = m.room_id and s.user_id = m.user_id and s.revoked_at is null
                      and oryn.session_is_fresh(s.last_seen_at)),
           m.joined_at
      from oryn.room_members m
     where m.room_id = p_room_id and m.removed_at is null
     order by m.role = 'owner' desc, m.joined_at, m.user_id;
end $$;

-- Sessões vivas da sala com a referência da conta: é o que permite distinguir duas contas de duas sessões da mesma conta.
-- Como get_roster, exige membro ativo de sala aberta e responde not-member, que encerra a chamada em curso.
create function public.get_voice_participants(p_room_id uuid)
returns table (session_id uuid, participant_ref text, display_name text, is_self boolean, joined_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := oryn.require_uid();
begin
  if not oryn.is_active_member(p_room_id, v_uid) then
    raise exception 'not-member' using errcode = '42501';
  end if;
  return query
    select s.id, oryn.member_ref(s.room_id, s.user_id), m.display_name, s.user_id = v_uid, s.created_at
      from oryn.room_sessions s
      join oryn.room_members m on m.room_id = s.room_id and m.user_id = s.user_id and m.removed_at is null
     where s.room_id = p_room_id and s.revoked_at is null and oryn.session_is_fresh(s.last_seen_at)
     order by s.created_at, s.id;
end $$;

-- Saída definitiva do próprio chamador. O dono encerra a sala: não há transferência de propriedade neste MVP.
-- As mensagens continuam visíveis aos membros restantes. Sala encerrada: quem saiu deixa de vê-la.
create function public.leave_room_membership(p_room_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := oryn.require_uid(); v_role text;
begin
  perform 1 from oryn.room_members m where m.room_id = p_room_id and m.user_id = v_uid and m.removed_at is null;
  if not found then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  perform 1 from oryn.rooms r where r.id = p_room_id for no key update;
  select m.role into v_role from oryn.room_members m where m.room_id = p_room_id and m.user_id = v_uid and m.removed_at is null;
  if not found then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if v_role = 'owner' then
    raise exception 'owner-cannot-leave' using errcode = 'P0001';
  end if;
  perform oryn.end_membership(p_room_id, v_uid, 'left');
end $$;

-- Remoção pelo dono, em sala aberta. Sala alheia, inexistente, chamador sem poder e referência desconhecida têm a mesma
-- resposta, sem revelar nada. O dono não remove a si mesmo: encerra a sala. Revoga os convites pendentes da sala, porque
-- eles não são nominais e podem estar com quem foi removido.
create function public.remove_room_member(p_room_id uuid, p_member_ref text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := oryn.require_uid(); v_target uuid;
begin
  perform 1 from oryn.rooms r where r.id = p_room_id and r.owner_id = v_uid and r.closed_at is null for no key update;
  if not found or not oryn.is_active_member(p_room_id, v_uid) or p_member_ref is null then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  select m.user_id into v_target from oryn.room_members m
   where m.room_id = p_room_id and m.removed_at is null and m.user_id <> v_uid
     and oryn.member_ref(m.room_id, m.user_id) = p_member_ref;
  if not found then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  perform oryn.end_membership(p_room_id, v_target, 'removed');
end $$;

-- ---------------------------------------------------------------- permissões explícitas ---------------

revoke all on function oryn.member_ref(uuid, uuid), oryn.enforce_room_capacity(), oryn.guard_member_reactivation(),
  oryn.end_membership(uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.list_room_members(uuid), public.get_voice_participants(uuid),
  public.leave_room_membership(uuid), public.remove_room_member(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.list_room_members(uuid), public.get_voice_participants(uuid),
  public.leave_room_membership(uuid), public.remove_room_member(uuid, text) to authenticated;

-- Autoverificação (falha fechada): se qualquer condição falhar, a migração inteira é desfeita.
do $$
declare v_fn text; v_role text;
begin
  foreach v_fn in array array['public.list_room_members(uuid)', 'public.get_voice_participants(uuid)',
                              'public.leave_room_membership(uuid)', 'public.remove_room_member(uuid,text)'] loop
    if not exists (select 1 from pg_catalog.pg_proc p
                    where p.oid = v_fn::regprocedure and p.prosecdef
                      and 'search_path=""' = any (coalesce(p.proconfig, '{}')))
       or pg_catalog.has_function_privilege('anon', v_fn, 'EXECUTE')
       or pg_catalog.has_function_privilege('service_role', v_fn, 'EXECUTE')
       or not pg_catalog.has_function_privilege('authenticated', v_fn, 'EXECUTE') then
      raise exception 'oryn-0600: definição ou permissões inesperadas em %', v_fn using errcode = 'P0001';
    end if;
  end loop;
  foreach v_fn in array array['oryn.member_ref(uuid,uuid)', 'oryn.enforce_room_capacity()', 'oryn.guard_member_reactivation()',
                              'oryn.end_membership(uuid,uuid,text)'] loop
    foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
      if pg_catalog.has_function_privilege(v_role, v_fn, 'EXECUTE') then
        raise exception 'oryn-0600: privilégio inesperado de % em %', v_role, v_fn using errcode = 'P0001';
      end if;
    end loop;
  end loop;
end $$;
