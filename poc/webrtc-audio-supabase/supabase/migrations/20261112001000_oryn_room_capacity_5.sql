-- Capacidade de salas NOVAS: até 5 contas, inclusive o dono (piloto privado da Etapa 6). Antes: até 4 (0600).
--
-- Aditiva quanto aos dados: nenhuma linha é criada, alterada ou apagada. Redefine só o corpo de
-- oryn.enforce_room_capacity(), com a mesma assinatura e o mesmo código de erro (invalid-argument). CREATE OR REPLACE
-- mantém dono, ACL e search_path da função; o gatilho oryn_room_capacity (BEFORE INSERT em oryn.rooms) não muda.
--
-- Salas existentes não são tocadas: o gatilho só confere inserções, e nenhuma RPC altera max_members. Uma sala de 4
-- continua de 4. create_room segue validando 2 a 10 antes de inserir; o limite real passa a ser este.
--
-- Admissão: inalterada. redeem_room_invite e create_room_invite contam os membros ativos contra max_members com a sala
-- travada (FOR NO KEY UPDATE) e recusam com room-full; a sexta conta de uma sala de 5 é recusada ali, também sob corrida.
-- Voz: o limite de 2 sessões por conta e o de 40 sinais por sessão a cada 10 s não mudam.
--
-- Reversão: integration/sql/97_rollback_capacity_10.sql restaura o corpo da 0600 (> 4) e remove esta versão do histórico.
-- Salas criadas com 5 lugares nesse intervalo continuam válidas (o gatilho não confere linhas existentes).
begin;

create or replace function oryn.enforce_room_capacity() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.max_members > 5 then
    raise exception 'invalid-argument' using errcode = 'P0001';
  end if;
  return new;
end $$;

-- Autoverificação (falha fechada): a função continua privada e com o search_path vazio, e o gatilho continua ligado.
do $$
declare v_role text;
begin
  if not exists (select 1 from pg_catalog.pg_proc p
                  where p.oid = 'oryn.enforce_room_capacity()'::regprocedure and not p.prosecdef
                    and 'search_path=""' = any (coalesce(p.proconfig, '{}')))
     or not exists (select 1 from pg_catalog.pg_trigger t
                     where t.tgrelid = 'oryn.rooms'::regclass and t.tgname = 'oryn_room_capacity' and not t.tgisinternal
                       and t.tgfoid = 'oryn.enforce_room_capacity()'::regprocedure and t.tgenabled = 'O') then
    raise exception 'oryn-1000: definição inesperada de oryn.enforce_room_capacity' using errcode = 'P0001';
  end if;
  foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
    if pg_catalog.has_function_privilege(v_role, 'oryn.enforce_room_capacity()', 'EXECUTE') then
      raise exception 'oryn-1000: privilégio inesperado de % em oryn.enforce_room_capacity', v_role using errcode = 'P0001';
    end if;
  end loop;
end $$;

commit;
