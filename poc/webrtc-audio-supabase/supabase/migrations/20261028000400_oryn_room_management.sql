-- MVP 01 — gerenciamento de salas pela interface: listar as próprias salas e encerrar uma sala.
--
-- Aditiva: só cria 2 RPCs em `public`. Não altera tabela, política nem função existente (join_room incluída).
-- Mesmas regras da 0200: SECURITY DEFINER com `set search_path = ''`, nomes qualificados, EXECUTE só para
-- `authenticated`, erros com códigos curtos e genéricos.

-- Salas em que o chamador é membro ativo, abertas e encerradas. Dos outros membros, só a contagem.
-- Ordem: abertas primeiro, depois as mais recentes. No máximo 50.
create function public.list_my_rooms()
returns table (room_id uuid, name text, role text, is_open boolean, closed_at timestamptz,
               member_count integer, max_members integer, created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := oryn.require_uid();
begin
  return query
    select r.id, r.name, m.role, r.closed_at is null, r.closed_at,
           (select pg_catalog.count(*)::integer from oryn.room_members a where a.room_id = r.id and a.removed_at is null),
           r.max_members, r.created_at
      from oryn.room_members m join oryn.rooms r on r.id = m.room_id
     where m.user_id = v_uid and m.removed_at is null
     order by r.closed_at is null desc, r.created_at desc, r.id
     limit 50;
end $$;

-- Encerra a sala (só o dono). Preserva o histórico: preenche closed_at, não apaga nada. Idempotente: sala já
-- encerrada devolve o closed_at original sem publicar nem alterar nada. Sala alheia ou inexistente: mesma
-- resposta (`unauthorized`), sem revelar se existe.
--
-- Travas (MVP 01; auditoria completa no relatório de correção do impasse):
-- 1. a sala; 2. TODAS as linhas de membro, em ordem de user_id; 3. as sessões não revogadas (UPDATE);
-- 4. os convites pendentes SEM ESPERAR (SKIP LOCKED); 5. a própria sala (UPDATE).
-- - join_room trava a linha de membro antes de conferir a pertença: se chegou antes, este encerramento espera
--   e, com snapshot novo, revoga também a sessão recém-criada; se chegou depois, ele espera e, ao reconferir,
--   encontra a sala fechada (not-member).
-- - create_room_invite trava a sala primeiro, como aqui: os dois se serializam pela sala.
-- - Convites: redeem_room_invite trava o CONVITE e depois a SALA, e revoke_room_invite atualiza vários
--   convites sem ordem definida. Esperar por um convite aqui (com a sala travada) formaria ciclo com o
--   primeiro, e atualizar vários convites em ordem própria, com o segundo. Por isso este encerramento nunca
--   espera por convite: revoga todos os que estão livres e pula os travados. Um convite pulado está com um
--   resgate ou uma revogação em curso. A revogação o revoga; o resgate espera esta sala, reconfere
--   `closed_at is null` depois da espera e recusa (invite-invalid). Assim nenhum convite fica UTILIZÁVEL:
--   create_room_invite e redeem_room_invite exigem a sala aberta, sob trava da sala.
--
-- Aviso aos clientes: o `bye` já existente, com o session_id de cada sessão viva, para as demais sessões vivas,
-- publicado ANTES das revogações (publish_control só publica para sessões não revogadas). Broadcast do banco
-- sai por replicação lógica: nada é entregue se esta transação desfizer.
create function public.close_room(p_room_id uuid) returns timestamptz
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := oryn.require_uid(); v_closed timestamptz; v_sid uuid;
begin
  select r.closed_at into v_closed from oryn.rooms r
   where r.id = p_room_id and r.owner_id = v_uid for no key update;
  if not found then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if v_closed is not null then
    return v_closed;
  end if;
  perform 1 from oryn.room_members m where m.room_id = p_room_id order by m.user_id for no key update;
  for v_sid in
    select s.id from oryn.room_sessions s
     where s.room_id = p_room_id and s.revoked_at is null and oryn.session_is_fresh(s.last_seen_at)
     order by s.id
  loop
    perform oryn.publish_control(p_room_id, v_sid, 'bye', pg_catalog.jsonb_build_object('session_id', v_sid));
  end loop;
  update oryn.room_sessions set revoked_at = pg_catalog.now(), revoke_reason = 'room-closed'
   where room_id = p_room_id and revoked_at is null;
  update oryn.room_invites set revoked_at = pg_catalog.now()
   where id in (select i.id from oryn.room_invites i
                 where i.room_id = p_room_id and i.used_at is null and i.revoked_at is null and i.expires_at > pg_catalog.now()
                   for no key update skip locked);
  update oryn.rooms set closed_at = pg_catalog.now() where id = p_room_id returning rooms.closed_at into v_closed;
  return v_closed;
end $$;

-- ---------------------------------------------------------------- permissões explícitas ---------------

revoke all on function public.list_my_rooms(), public.close_room(uuid) from public, anon, authenticated, service_role;
grant execute on function public.list_my_rooms(), public.close_room(uuid) to authenticated;

-- Autoverificação (falha fechada): se qualquer condição falhar, a migração inteira é desfeita.
do $$
declare v_fn text;
begin
  foreach v_fn in array array['public.list_my_rooms()', 'public.close_room(uuid)'] loop
    if not exists (select 1 from pg_catalog.pg_proc p
                    where p.oid = v_fn::regprocedure and p.prosecdef
                      and 'search_path=""' = any (coalesce(p.proconfig, '{}')))
       or pg_catalog.has_function_privilege('anon', v_fn, 'EXECUTE')
       or pg_catalog.has_function_privilege('service_role', v_fn, 'EXECUTE')
       or not pg_catalog.has_function_privilege('authenticated', v_fn, 'EXECUTE') then
      raise exception 'oryn-0400: definição ou permissões inesperadas em %', v_fn using errcode = 'P0001';
    end if;
  end loop;
end $$;
