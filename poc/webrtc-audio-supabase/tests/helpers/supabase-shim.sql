-- SHIM DE TESTE (NÃO é o Supabase): reproduz, em Postgres puro, só as peças do Supabase de que as
-- migrações dependem. Usado no PGlite (Postgres 18) e no Postgres 17 embutido (tests/pg). Ajustado no
-- 02C.2B ao que foi OBSERVADO no projeto real (leitura de catálogo da 02C.2A, PG 17.11):
-- - `realtime.messages`: particionada por intervalo de `inserted_at`, RLS JÁ LIGADO, dono
--   `supabase_realtime_admin` (não o dono das migrações), INSERT/SELECT/UPDATE para anon/authenticated/
--   service_role, colunas id uuid, binary_payload e skip_broadcast;
-- - `realtime.send`: SECURITY INVOKER, EXECUTE para PUBLIC, injeta `id` no payload, faz SET LOCAL de
--   realtime.topic e CAPTURA qualquer erro (só WARNING) — cópia do código lido no projeto;
-- - dono das migrações (`migration_owner`, como o `postgres`): não superusuário, COM BYPASSRLS.
--
-- O QUE NÃO É FIEL (documentado; ver integration/RUNBOOK-02C.1B.md):
-- - o `supautils.policy_grants` do Supabase deixa o `postgres` criar e remover POLÍTICAS em
--   realtime.messages sem ser dono. Aqui isso é aproximado por pertencer a supabase_realtime_admin, o que
--   também permitiria ALTER TABLE. Por isso um teste estático proíbe ALTER TABLE em realtime.* nas migrações;
-- - as partições diárias e a limpeza de 3 dias são feitas pelo serviço Realtime: aqui há UMA partição larga;
-- - os outros papéis do Supabase (authenticator, supabase_admin…) e o serviço Realtime não existem.

create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create role supabase_realtime_admin nologin noinherit;
-- Dono das migrações, como o `postgres` do Supabase: NÃO é superusuário; tem BYPASSRLS (como no real).
-- As migrações rodam com este papel (db.ts e tests/pg), para que as funções SECURITY DEFINER executem com
-- privilégios realistas (o usuário padrão do teste é superusuário e mascararia revogações).
create role migration_owner nologin nosuperuser bypassrls noinherit;
grant create on database postgres to migration_owner;
grant usage, create on schema public to migration_owner;
-- Aproximação do supautils.policy_grants (ver acima).
grant supabase_realtime_admin to migration_owner with inherit true;

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
  topic text not null,
  extension text not null,
  payload jsonb,
  event text,
  private boolean default false,
  updated_at timestamp without time zone not null default now(),
  inserted_at timestamp without time zone not null default now(),
  id uuid not null default gen_random_uuid(),
  binary_payload bytea,
  skip_broadcast boolean default false,
  primary key (id, inserted_at)
) partition by range (inserted_at);
-- Uma partição larga no lugar das diárias criadas pelo serviço Realtime.
create table realtime.messages_shim partition of realtime.messages for values from ('2000-01-01') to ('2100-01-01');
alter table realtime.messages enable row level security; -- o Supabase entrega com RLS ligado
alter table realtime.messages owner to supabase_realtime_admin;
alter table realtime.messages_shim owner to supabase_realtime_admin;

create function realtime.topic() returns text language sql stable as $$
  select nullif(current_setting('realtime.topic', true), '')::text
$$;

-- Cópia do realtime.send lido no projeto real (SECURITY INVOKER; erros viram WARNING).
create function realtime.send(payload jsonb, event text, topic text, private boolean default true) returns void
language plpgsql as $$
DECLARE
  generated_id uuid;
  final_payload jsonb;
BEGIN
  BEGIN
    generated_id := gen_random_uuid();
    IF payload ? 'id' THEN
      final_payload := payload;
    ELSE
      final_payload := jsonb_set(payload, '{id}', to_jsonb(generated_id));
    END IF;
    EXECUTE format('SET LOCAL realtime.topic TO %L', topic);
    INSERT INTO realtime.messages (id, payload, event, topic, private, extension)
    VALUES (generated_id, final_payload, event, topic, private, 'broadcast');
  EXCEPTION
    WHEN OTHERS THEN
      RAISE WARNING 'WarnSendingBroadcastMessage: %', SQLERRM;
  END;
END;
$$;
alter function realtime.topic() owner to supabase_realtime_admin;
alter function realtime.send(jsonb, text, text, boolean) owner to supabase_realtime_admin;
-- EXECUTE para PUBLIC em realtime.send e realtime.topic: padrão do Postgres, como no real (=X).

grant usage on schema realtime to anon, authenticated, service_role, migration_owner;
grant select, insert, update on realtime.messages to anon, authenticated, service_role;
grant select, insert, update, delete, truncate, references, trigger on realtime.messages to migration_owner;
