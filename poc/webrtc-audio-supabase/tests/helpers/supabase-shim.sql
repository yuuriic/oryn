-- SHIM DE TESTE (NÃO é o Supabase): reproduz, em Postgres puro (PGlite), só as peças do Supabase de que
-- as migrações dependem, para testar autorização localmente. Diferenças em relação ao Supabase real são
-- riscos NOT VERIFIED (ver README):
-- - papéis anon/authenticated/service_role e os privilégios PADRÃO do Supabase no schema public
--   (EXECUTE/ALL para anon, authenticated e service_role), para provar que as migrações os revogam;
-- - auth.users mínimo e auth.uid() lendo request.jwt.claims (como o PostgREST faz);
-- - realtime.messages, realtime.topic() (lido de uma configuração da transação) e realtime.send()
--   (insere em realtime.messages, como o Broadcast from the Database documentado).

create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
-- Dono das migrações, como o `postgres` do Supabase: NÃO é superusuário nem ignora RLS. As migrações
-- rodam com este papel (db.ts), para que as funções SECURITY DEFINER executem com privilégios realistas
-- (no PGlite o usuário padrão é superusuário e mascararia revogações que quebram operações internas).
create role migration_owner nologin nosuperuser nobypassrls noinherit;
grant create on database postgres to migration_owner;
grant usage, create on schema public to migration_owner;

-- Privilégios padrão do Supabase no schema public (o que as migrações precisam neutralizar).
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;

create schema auth;
create table auth.users (
  id uuid primary key,
  is_anonymous boolean not null default true,
  created_at timestamptz not null default now()
);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(coalesce(
    current_setting('request.jwt.claim.sub', true),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  ), '')::uuid
$$;
grant usage on schema auth to anon, authenticated, service_role, migration_owner;
grant execute on function auth.uid() to anon, authenticated, service_role, migration_owner;
grant references on auth.users to migration_owner; -- chaves estrangeiras para auth.users

create schema realtime;
create table realtime.messages (
  id bigserial primary key,
  topic text not null,
  extension text not null,
  payload jsonb,
  event text,
  private boolean,
  inserted_at timestamptz not null default now()
);
create function realtime.topic() returns text language sql stable as $$
  select nullif(current_setting('realtime.topic', true), '')
$$;
create function realtime.send(payload jsonb, event text, topic text, private boolean default true) returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into realtime.messages (topic, extension, payload, event, private) values (topic, 'broadcast', payload, event, private);
end $$;
revoke all on function realtime.send(jsonb, text, text, boolean) from public;
-- O dono das migrações publica eventos de controle (realtime.send) e cria as políticas de realtime.messages
-- (políticas exigem ser dono da tabela). No Supabase real esses privilégios do `postgres` são NOT VERIFIED.
grant execute on function realtime.send(jsonb, text, text, boolean) to migration_owner;
alter table realtime.messages owner to migration_owner;
grant usage on schema realtime to anon, authenticated, migration_owner;
grant select, insert on realtime.messages to anon, authenticated;
grant usage, select on sequence realtime.messages_id_seq to anon, authenticated;
grant execute on function realtime.topic() to anon, authenticated, migration_owner;
