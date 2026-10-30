-- POC-02C.1A — esquema de domínio da sinalização Oryn (salas, membros, convites, sessões, registro de sinais).
--
-- Princípios:
-- - Tabelas no schema PRIVADO `oryn` (não deve ser exposto na Data API do Supabase).
-- - RLS habilitado em todas as tabelas e NENHUMA política: acesso direto negado por padrão.
-- - Nenhum privilégio de tabela para anon/authenticated/service_role; toda escrita/leitura passa por
--   funções RPC SECURITY DEFINER (migração 0200) com validações explícitas.
-- - Nunca há coluna para SDP, candidatos ICE ou qualquer payload de sinalização: só metadados.
-- - Segredos (tokens de convite) só existem como hash SHA-256.

create schema if not exists oryn;
revoke all on schema oryn from public;

-- Quem pode criar salas (concedido por convite de criador emitido pelo administrador do projeto).
create table oryn.creator_grants (
  user_id uuid primary key references auth.users (id) on delete cascade,
  max_open_rooms integer not null default 2 check (max_open_rooms between 1 and 5),
  granted_at timestamptz not null default now()
);

-- Convites de criador: emitidos SÓ pelo administrador (oryn.admin_issue_creator_invite), uso único.
create table oryn.creator_invites (
  id uuid primary key default gen_random_uuid(),
  token_hash bytea not null unique check (octet_length(token_hash) = 32),
  max_open_rooms integer not null default 2 check (max_open_rooms between 1 and 5),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  used_by uuid references auth.users (id) on delete set null,
  revoked_at timestamptz,
  check (expires_at > created_at)
);

create table oryn.rooms (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40 and name !~ '[[:cntrl:]]'),
  max_members integer not null default 3 check (max_members between 2 and 10),
  created_at timestamptz not null default now(),
  closed_at timestamptz
);
create index rooms_owner_open_idx on oryn.rooms (owner_id) where closed_at is null;

create table oryn.room_members (
  room_id uuid not null references oryn.rooms (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('owner', 'member')),
  display_name text not null check (char_length(display_name) between 1 and 32 and display_name !~ '[[:cntrl:]]'),
  joined_at timestamptz not null default now(),
  removed_at timestamptz,
  primary key (room_id, user_id)
);

-- Convites de sala: uso único, expiração curta, consumo atômico; só o hash é guardado.
create table oryn.room_invites (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references oryn.rooms (id) on delete cascade,
  token_hash bytea not null unique check (octet_length(token_hash) = 32),
  created_by uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  used_by uuid references auth.users (id) on delete set null,
  revoked_at timestamptz,
  check (expires_at > created_at)
);
create index room_invites_room_idx on oryn.room_invites (room_id);

-- Conexões (aba/dispositivo) de um membro numa sala. O tópico privado é oryn:s:{id}.
create table oryn.room_sessions (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references oryn.rooms (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoke_reason text check (revoke_reason in ('left', 'expired', 'removed', 'room-closed')),
  check ((revoked_at is null) = (revoke_reason is null))
);
create index room_sessions_active_idx on oryn.room_sessions (room_id) where revoked_at is null;

-- Sequência por par remetente→destino (atribuída pelo servidor).
create table oryn.pair_counters (
  from_session uuid not null references oryn.room_sessions (id) on delete cascade,
  to_session uuid not null references oryn.room_sessions (id) on delete cascade,
  last_seq bigint not null check (last_seq >= 1),
  primary key (from_session, to_session)
);

-- Registro de sinalização: idempotência, sequência, estados de publicação e limites. SEM payload.
create table oryn.signal_log (
  msg_id uuid primary key default gen_random_uuid(),
  session_id uuid not null references oryn.room_sessions (id) on delete cascade,
  to_session_id uuid not null references oryn.room_sessions (id) on delete cascade,
  client_msg_id uuid not null,
  kind text not null check (kind in ('offer', 'answer', 'candidate', 'end-of-candidates', 'restart-request')),
  pair_epoch integer not null check (pair_epoch >= 0),
  seq bigint not null check (seq >= 1),
  payload_bytes integer not null check (payload_bytes between 1 and 16384),
  state text not null default 'accepted' check (state in ('accepted', 'publishing', 'published', 'failed', 'acknowledged')),
  attempts integer not null default 0 check (attempts between 0 and 5),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (session_id, client_msg_id),
  check (session_id <> to_session_id)
);
create index signal_log_rate_idx on oryn.signal_log (session_id, created_at);

-- Acesso direto negado por padrão: RLS ligado, nenhuma política, nenhum privilégio.
alter table oryn.creator_grants enable row level security;
alter table oryn.creator_invites enable row level security;
alter table oryn.rooms enable row level security;
alter table oryn.room_members enable row level security;
alter table oryn.room_invites enable row level security;
alter table oryn.room_sessions enable row level security;
alter table oryn.pair_counters enable row level security;
alter table oryn.signal_log enable row level security;

revoke all on all tables in schema oryn from public, anon, authenticated, service_role;
revoke all on all sequences in schema oryn from public, anon, authenticated, service_role;
alter default privileges in schema oryn revoke all on tables from public, anon, authenticated, service_role;
alter default privileges in schema oryn revoke all on functions from public, anon, authenticated, service_role;
