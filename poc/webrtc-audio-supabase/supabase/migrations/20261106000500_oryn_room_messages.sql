-- Chat de texto persistente por sala.
--
-- Aditiva: cria 2 tabelas privadas e 2 RPCs em `public`. Não altera tabela, política, função ou publicação existente:
-- WebRTC, ICE, sinalização e Realtime continuam iguais. Mesmas regras da 0200: SECURITY DEFINER com
-- `set search_path = ''`, nomes qualificados, EXECUTE só para `authenticated`, erros com códigos curtos e genéricos.
--
-- O autor vem sempre do JWT. A chave estrangeira composta impede mensagem de quem nunca foi membro daquela sala.
-- `seq` é a ordem total da sala: atribuído sob a trava da sala, na ordem de confirmação e NUNCA reutilizado. Assim, o
-- cliente pode pedir "depois de N" sem perder uma mensagem que confirmou depois de outra já lida. O contador fica em
-- tabela própria porque a exclusão de uma conta apaga as mensagens dela: com max(seq) + 1, a mensagem seguinte repetiria
-- o número da apagada, e quem já leu até ali nunca a receberia. Depois de uma exclusão, o histórico pode ter lacunas.
-- O texto fica fora de qualquer log ou evento; `realtime.messages` não recebe nada desta migração.
create table oryn.room_messages (
  room_id uuid not null,
  seq bigint not null check (seq >= 1),
  author_id uuid not null,
  client_nonce uuid not null,
  body text not null check (
    pg_catalog.char_length(body) between 1 and 4000
    and pg_catalog.btrim(body, E' \n\t') <> ''
    and body !~ E'[\\x01-\\x08\\x0B-\\x1F\\x7F]'),
  created_at timestamptz not null,
  primary key (room_id, seq),
  unique (room_id, author_id, client_nonce),
  foreign key (room_id, author_id) references oryn.room_members (room_id, user_id) on delete cascade
);
-- Controle de taxa: últimas mensagens de um autor numa sala.
create index room_messages_rate_idx on oryn.room_messages (room_id, author_id, created_at);

-- Último seq de cada sala (como oryn.pair_counters). Some só com a sala.
create table oryn.room_message_counters (
  room_id uuid primary key references oryn.rooms (id) on delete cascade,
  last_seq bigint not null check (last_seq >= 1)
);

-- Acesso direto negado: RLS ligado, nenhuma política, nenhum privilégio. Só as RPCs abaixo alcançam a tabela.
alter table oryn.room_messages enable row level security;
alter table oryn.room_message_counters enable row level security;
revoke all on table oryn.room_messages, oryn.room_message_counters from public, anon, authenticated, service_role;

-- Envia uma mensagem. Sala alheia ou inexistente: mesma resposta (`unauthorized`), sem revelar se existe.
--
-- Trava a sala (FOR NO KEY UPDATE, como close_room e create_room_invite) e reconfere a pertença depois da espera. Com
-- isso, seq, idempotência, limite de taxa e sala encerrada são exatos sob concorrência. Só espera pela sala, então
-- não forma ciclo com as ordens de close_room ou redeem_room_invite; a chave estrangeira usa KEY SHARE, que não
-- conflita com a trava de membro do join_room.
--
-- Repetir o mesmo (sala, autor, p_client_nonce) devolve a mensagem original, mesmo com a sala já encerrada e sem
-- consumir o limite: é o caso da resposta perdida. O mesmo identificador com outro texto é recusado.
create function public.send_room_message(p_room_id uuid, p_client_nonce uuid, p_body text)
returns table (seq bigint, display_name text, is_mine boolean, client_nonce uuid, body text, created_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := oryn.require_uid();
  v_name text;
  v_closed timestamptz;
  v_seq bigint;
  v_body text;
  v_at timestamptz;
  v_recent integer;
begin
  perform 1 from oryn.room_members m where m.room_id = p_room_id and m.user_id = v_uid and m.removed_at is null;
  if not found then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if p_client_nonce is null or p_body is null
     or pg_catalog.char_length(p_body) not between 1 and 4000
     or pg_catalog.btrim(p_body, E' \n\t') = ''
     or p_body ~ E'[\\x01-\\x08\\x0B-\\x1F\\x7F]' then
    raise exception 'invalid-argument' using errcode = 'P0001';
  end if;

  select r.closed_at into v_closed from oryn.rooms r where r.id = p_room_id for no key update;
  select m.display_name into v_name from oryn.room_members m
   where m.room_id = p_room_id and m.user_id = v_uid and m.removed_at is null;
  if not found then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  select m.seq, m.body, m.created_at into v_seq, v_body, v_at from oryn.room_messages m
   where m.room_id = p_room_id and m.author_id = v_uid and m.client_nonce = p_client_nonce;
  if found then
    if v_body <> p_body then
      raise exception 'invalid-argument' using errcode = 'P0001';
    end if;
  else
    if v_closed is not null then
      raise exception 'room-closed' using errcode = 'P0001';
    end if;
    select pg_catalog.count(*) into v_recent from oryn.room_messages m
     where m.room_id = p_room_id and m.author_id = v_uid and m.created_at > pg_catalog.clock_timestamp() - interval '60 seconds';
    if v_recent >= 30 then
      raise exception 'rate-limited' using errcode = 'P0001';
    end if;
    insert into oryn.room_message_counters as c (room_id, last_seq) values (p_room_id, 1)
    on conflict (room_id) do update set last_seq = c.last_seq + 1
    returning c.last_seq into v_seq;
    v_body := p_body;
    v_at := pg_catalog.clock_timestamp();
    insert into oryn.room_messages (room_id, seq, author_id, client_nonce, body, created_at)
    values (p_room_id, v_seq, v_uid, p_client_nonce, v_body, v_at);
  end if;

  seq := v_seq;
  display_name := v_name;
  is_mine := true;
  client_nonce := p_client_nonce;
  body := v_body;
  created_at := v_at;
  return next;
end $$;

-- Histórico de um membro ativo, aberta ou encerrada a sala. Sala alheia ou inexistente: `unauthorized`.
-- Sempre em ordem crescente de seq, com no máximo p_limit linhas:
-- - sem cursor: as mais recentes;
-- - p_before_seq: as mais recentes anteriores a ele (página mais antiga);
-- - p_after_seq: as primeiras posteriores a ele (atualização periódica).
-- Não expõe a conta de ninguém: só o nome de exibição na sala e `is_mine`. O identificador da tentativa só volta nas
-- mensagens do próprio chamador, para reconciliar um envio cuja resposta se perdeu.
create function public.list_room_messages(p_room_id uuid, p_before_seq bigint default null, p_after_seq bigint default null, p_limit integer default 50)
returns table (seq bigint, display_name text, is_mine boolean, client_nonce uuid, body text, created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := oryn.require_uid();
begin
  perform 1 from oryn.room_members m where m.room_id = p_room_id and m.user_id = v_uid and m.removed_at is null;
  if not found then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if p_limit is null or p_limit not between 1 and 100 or (p_before_seq is not null and p_after_seq is not null) then
    raise exception 'invalid-argument' using errcode = 'P0001';
  end if;
  if p_after_seq is not null then
    return query
      select m.seq, a.display_name, m.author_id = v_uid, case when m.author_id = v_uid then m.client_nonce end, m.body, m.created_at
        from oryn.room_messages m join oryn.room_members a on a.room_id = m.room_id and a.user_id = m.author_id
       where m.room_id = p_room_id and m.seq > p_after_seq
       order by m.seq
       limit p_limit;
  else
    return query
      select x.seq, x.display_name, x.is_mine, x.client_nonce, x.body, x.created_at
        from (select m.seq, a.display_name, m.author_id = v_uid as is_mine,
                     case when m.author_id = v_uid then m.client_nonce end as client_nonce, m.body, m.created_at
                from oryn.room_messages m join oryn.room_members a on a.room_id = m.room_id and a.user_id = m.author_id
               where m.room_id = p_room_id and (p_before_seq is null or m.seq < p_before_seq)
               order by m.seq desc
               limit p_limit) x
       order by x.seq;
  end if;
end $$;

-- ---------------------------------------------------------------- permissões explícitas ---------------

revoke all on function public.send_room_message(uuid, uuid, text), public.list_room_messages(uuid, bigint, bigint, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.send_room_message(uuid, uuid, text), public.list_room_messages(uuid, bigint, bigint, integer)
  to authenticated;

-- Autoverificação (falha fechada): se qualquer condição falhar, a migração inteira é desfeita.
do $$
declare v_fn text; v_role text; v_table text;
begin
  foreach v_fn in array array['public.send_room_message(uuid,uuid,text)', 'public.list_room_messages(uuid,bigint,bigint,integer)'] loop
    if not exists (select 1 from pg_catalog.pg_proc p
                    where p.oid = v_fn::regprocedure and p.prosecdef
                      and 'search_path=""' = any (coalesce(p.proconfig, '{}')))
       or pg_catalog.has_function_privilege('anon', v_fn, 'EXECUTE')
       or pg_catalog.has_function_privilege('service_role', v_fn, 'EXECUTE')
       or not pg_catalog.has_function_privilege('authenticated', v_fn, 'EXECUTE') then
      raise exception 'oryn-0500: definição ou permissões inesperadas em %', v_fn using errcode = 'P0001';
    end if;
  end loop;
  foreach v_table in array array['oryn.room_messages', 'oryn.room_message_counters'] loop
    if not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = v_table::regclass) then
      raise exception 'oryn-0500: RLS desligado em %', v_table using errcode = 'P0001';
    end if;
    foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
      if pg_catalog.has_table_privilege(v_role, v_table, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') then
        raise exception 'oryn-0500: privilégio inesperado de % em %', v_role, v_table using errcode = 'P0001';
      end if;
    end loop;
  end loop;
end $$;
