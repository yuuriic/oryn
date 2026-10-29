-- MVP 01 — AUDITORIA DAS FRENTES A E B (pós-Rodada 2), SOMENTE LEITURA. Rodar no SQL editor (ou MCP
-- execute_sql), como postgres, DEPOIS da execução controlada (A1/A2, B1/B2), QUALQUER que seja o resultado.
--
-- ⚠ ANTES DE RODAR: troque os três marcadores abaixo (em `params`):
--   <<ROOM_ID>> = UUID da sala da execução;  <<T0_UTC>> / <<T1_UTC>> = início e fim da execução, em UTC e COM o
--   sufixo Z (ex.: 2026-10-29T00:30:00Z). Sem a troca, a consulta FALHA de propósito (o marcador não é UUID nem horário).
-- J1 reprova janela invertida ou de 2 h ou mais (T0/T1 trocados ou copiados de outra execução).
-- Saída: item, expected, actual, status (PASS / FAIL / INFO). Ordenado: FAIL, INFO, PASS. READ ONLY e ROLLBACK.
-- Sem dado sensível: ids só com 8 caracteres; nenhum e-mail, display_name, token, hash de convite ou payload.
-- Estrutura (S1–S5) e A7 ficam com o 07/12: este script só lê dados de uma sala e não altera nada.
--
-- Frente A (A1): a sala fechada revoga, no MESMO instante do closed_at e com `room-closed`, toda sessão viva;
--   depois do fechamento não sobra sessão viva nem convite utilizável. Sala aberta = A1 FAIL (A1 é obrigatório).
-- Frente B (B2): cada sinal da janela entre sessões da sala recebe UMA classe. O banco não vê o cliente (as
--   tentativas de ack só existem no navegador): toda classe diferente de CONFIRMADO se julga CRUZANDO com o log
--   e o Network do receptor, nunca sozinha.
--   CONFIRMADO          state = acknowledged;
--   PENDENTE            published, receptor ainda vivo, publicado há menos de `ack_ceiling` (repetições em curso);
--   ESGOTADO            published, receptor vivo por `ack_ceiling` ou mais depois do published: as 3 tentativas do
--                       cliente já passaram. NÃO prova defeito: é desistência real se o log do receptor a registrou;
--                       só é defeito se o log NÃO bate (desistência falsa ou silenciosa);
--   FIM-JANELA          published, o receptor terminou menos de `ack_first` depois (inclusive antes): o close()
--                       descarta acks ainda na janela inicial — esperado perto da saída;
--   INCONCLUSIVO-FIM    published, o receptor terminou entre `ack_first` e `ack_ceiling` depois (no meio das repetições);
--   INCONCLUSIVO-SEM    nunca chegou a published (accepted/publishing/failed): não havia o que confirmar.
--   Fronteiras: folga < 3,5 s → FIM-JANELA; 3,5 s ≤ folga < 15 s → INCONCLUSIVO-FIM (ou PENDENTE, se vivo);
--   folga ≥ 15 s → ESGOTADO. Derivadas do cliente (supabase-signaling.ts): 1º ack 1,5 a 2,5 s depois da ENTREGA (que
--   precede o published), repetições +2 s e +4 s, 3 tentativas; com folga de RTT → 3,5 s e 15 s.
--   Horário do published: para state = published, `updated_at` É o instante da transição para published, porque
--   (0200) published só sai para acknowledged (ack_signals) e repetir published não grava (set_signal_state
--   devolve antes do UPDATE). Para os outros estados ele NÃO é o horário do published e a folga não é mostrada.
--   Receptor vivo = não revogado e oryn.session_is_fresh(last_seen_at) (90 s). Fim do receptor = o menor entre
--   revoked_at e last_seen_at + 90 s (a revogação `expired` é gravada depois que a sessão já venceu).
-- Latência (B3): só ponta a ponta, created_at → acknowledged: depois do ack, `updated_at` é o horário do ack e o do
--   published se perdeu. `signal_log.attempts` são tentativas de PUBLICAÇÃO (Edge Function), não de ack.

begin;
set transaction read only;

with
params as (
  select '<<ROOM_ID>>'::uuid as room, '<<T0_UTC>>'::timestamptz as t0, '<<T1_UTC>>'::timestamptz as t1,
         interval '3.5 seconds' as ack_first, interval '15 seconds' as ack_ceiling
),
room as (select r.* from oryn.rooms r, params p where r.id = p.room),
members as (select m.* from oryn.room_members m, params p where m.room_id = p.room),
sessions as (
  select s.id, s.user_id, s.created_at, s.last_seen_at, s.revoked_at, s.revoke_reason,
         coalesce(m.role, '(fora da sala)') as role,
         (s.revoked_at is null and oryn.session_is_fresh(s.last_seen_at)) as alive,
         least(coalesce(s.revoked_at, pg_catalog.now()), s.last_seen_at + interval '90 seconds') as ended_at
    from oryn.room_sessions s join params p on s.room_id = p.room
    left join members m on m.user_id = s.user_id
),
signals as (
  select g.*, f.role as from_role, t.role as to_role, t.alive as to_alive, t.ended_at as to_ended_at
    from oryn.signal_log g, params p, sessions f, sessions t
   where g.created_at between p.t0 and p.t1 and f.id = g.session_id and t.id = g.to_session_id
),
classified as (
  select g.*,
         case
           when g.state = 'acknowledged' then 'CONFIRMADO'
           when g.state <> 'published' then 'INCONCLUSIVO-SEM'
           when g.to_ended_at - g.updated_at >= p.ack_ceiling then 'ESGOTADO'
           when g.to_alive then 'PENDENTE'
           when g.to_ended_at - g.updated_at < p.ack_first then 'FIM-JANELA'
           else 'INCONCLUSIVO-FIM'
         end as class,
         case when g.state = 'published'
              then pg_catalog.round(pg_catalog.date_part('epoch', g.to_ended_at - g.updated_at)::numeric, 3)::text
              else '-' end as slack_s
    from signals g, params p
),
fmt as (select 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'::text as ts),
r as (
-- ---------------------------------------------------------------- janela e sala ----------------------
select 'J1 janela T0 < T1 e menor que 2 h' as item, 'T0 < T1 < T0 + 2 h' as expected,
       (select pg_catalog.to_char(p.t0 at time zone 'utc', f.ts) || ' → ' || pg_catalog.to_char(p.t1 at time zone 'utc', f.ts) from params p, fmt f) as actual,
       case when (select p.t0 < p.t1 and p.t1 - p.t0 < interval '2 hours' from params p) then 'PASS' else 'FAIL' end as status
union all
select 'R1 sala existe', '1', (select pg_catalog.count(*)::text from room),
       case when (select pg_catalog.count(*) from room) = 1 then 'PASS' else 'FAIL' end
union all
select 'R2 sala criada dentro da janela', 'T0 ≤ created_at ≤ T1',
       coalesce((select pg_catalog.to_char(x.created_at at time zone 'utc', f.ts) from room x, fmt f), '-'),
       case when exists (select 1 from room x, params p where x.created_at between p.t0 and p.t1) then 'PASS' else 'INFO' end
union all
select 'INFO sala: id / dono / max_members / closed_at', '-',
       coalesce((select pg_catalog.left(x.id::text, 8) || ' / ' || pg_catalog.left(x.owner_id::text, 8) || ' / ' || x.max_members::text || ' / ' ||
                        coalesce(pg_catalog.to_char(x.closed_at at time zone 'utc', f.ts), '(aberta)') from room x, fmt f), '-'), 'INFO'
union all
select 'INFO membro ' || m.role || ' ' || pg_catalog.left(m.user_id::text, 8), '-',
       'entrou=' || pg_catalog.to_char(m.joined_at at time zone 'utc', f.ts) ||
       ' removido=' || coalesce(pg_catalog.to_char(m.removed_at at time zone 'utc', f.ts), '-'), 'INFO'
  from members m, fmt f
union all
select 'INFO sessão ' || s.role || ' ' || pg_catalog.left(s.id::text, 8), '-',
       'criada=' || pg_catalog.to_char(s.created_at at time zone 'utc', f.ts) ||
       ' visto=' || pg_catalog.to_char(s.last_seen_at at time zone 'utc', f.ts) ||
       ' revogada=' || coalesce(pg_catalog.to_char(s.revoked_at at time zone 'utc', f.ts), '-') ||
       ' motivo=' || coalesce(s.revoke_reason, case when s.alive then '(viva)' else '(vencida, não revogada)' end), 'INFO'
  from sessions s, fmt f
union all
-- ---------------------------------------------------------------- Frente A ---------------------------
select 'A1 sala encerrada', 'closed_at preenchido',
       coalesce((select pg_catalog.to_char(x.closed_at at time zone 'utc', f.ts) from room x, fmt f where x.closed_at is not null), '(aberta)'),
       case when exists (select 1 from room x where x.closed_at is not null) then 'PASS' else 'FAIL' end
union all
select 'A1 sessões vivas no fechamento: revogadas com room-closed no instante do closed_at', 'todas',
       (select pg_catalog.count(*) filter (where s.revoke_reason = 'room-closed' and s.revoked_at = x.closed_at)::text || ' de ' || pg_catalog.count(*)::text
          from sessions s, room x where x.closed_at is not null and s.created_at <= x.closed_at and (s.revoked_at is null or s.revoked_at >= x.closed_at)),
       case when exists (select 1 from room x where x.closed_at is not null)
             -- coalesce: sessão sem revogação dá NULL, e bool_and ignora NULL (passaria como PASS)
             and (select pg_catalog.count(*) > 0 and pg_catalog.bool_and(coalesce(s.revoke_reason = 'room-closed' and s.revoked_at = x.closed_at, false))
                    from sessions s, room x where s.created_at <= x.closed_at and (s.revoked_at is null or s.revoked_at >= x.closed_at))
            then 'PASS' else 'FAIL' end
union all
select 'A1 nenhuma sessão não revogada na sala', '0',
       (select pg_catalog.count(*)::text from sessions s where s.revoked_at is null),
       case when not exists (select 1 from sessions s where s.revoked_at is null) then 'PASS' else 'FAIL' end
union all
select 'A1 nenhum convite utilizável na sala', '0',
       (select pg_catalog.count(*)::text from oryn.room_invites i, params p
         where i.room_id = p.room and i.used_at is null and i.revoked_at is null and i.expires_at > pg_catalog.now()),
       case when not exists (select 1 from oryn.room_invites i, params p
                              where i.room_id = p.room and i.used_at is null and i.revoked_at is null and i.expires_at > pg_catalog.now())
            then 'PASS' else 'FAIL' end
union all
-- ---------------------------------------------------------------- Frente B ---------------------------
select 'B0 sinais da janela entre sessões da sala', '> 0', (select pg_catalog.count(*)::text from signals),
       case when (select pg_catalog.count(*) from signals) > 0 then 'PASS' else 'FAIL' end
union all
select 'INFO B0 sinais da janela de OUTRAS salas (outra atividade; não deveria haver)', '0',
       (select pg_catalog.count(*)::text from oryn.signal_log g, params p
         where g.created_at between p.t0 and p.t1 and not exists (select 1 from sessions s where s.id = g.session_id)), 'INFO'
union all
select 'INFO B1 receptor ' || x.to_role || ' ' || pg_catalog.left(x.to_session_id::text, 8) || ': estados', '-',
       pg_catalog.string_agg(x.state || '=' || x.n::text, ', ' order by x.state), 'INFO'
  from (select g.to_session_id, g.to_role, g.state, pg_catalog.count(*) as n from signals g group by 1, 2, 3) x
 group by x.to_session_id, x.to_role
union all
select 'INFO B1 receptor ' || x.to_role || ' ' || pg_catalog.left(x.to_session_id::text, 8) || ': sinais (1 por msg_id) / acknowledged (= Σ respostas de ack_signals desse receptor)', '-',
       x.n::text || ' / ' || x.acked::text, 'INFO'
  from (select g.to_session_id, g.to_role, pg_catalog.count(*) as n,
               pg_catalog.count(*) filter (where g.state = 'acknowledged') as acked
          from signals g group by 1, 2) x
union all
select 'INFO B2 classes: CONFIRMADO / PENDENTE / ESGOTADO / FIM-JANELA / INCONCLUSIVO-FIM / INCONCLUSIVO-SEM', '-',
       (select pg_catalog.count(*) filter (where class = 'CONFIRMADO')::text || ' / ' ||
               pg_catalog.count(*) filter (where class = 'PENDENTE')::text || ' / ' ||
               pg_catalog.count(*) filter (where class = 'ESGOTADO')::text || ' / ' ||
               pg_catalog.count(*) filter (where class = 'FIM-JANELA')::text || ' / ' ||
               pg_catalog.count(*) filter (where class = 'INCONCLUSIVO-FIM')::text || ' / ' ||
               pg_catalog.count(*) filter (where class = 'INCONCLUSIVO-SEM')::text from classified), 'INFO'
union all
select 'INFO B2 sinal ' || c.class || ' ' || pg_catalog.left(c.msg_id::text, 8), '-',
       c.kind || ' ' || c.from_role || '→' || c.to_role || ' estado=' || c.state ||
       ' criado=' || pg_catalog.to_char(c.created_at at time zone 'utc', f.ts) ||
       ' última_transição=' || pg_catalog.to_char(c.updated_at at time zone 'utc', f.ts) ||
       ' fim_receptor=' || case when c.to_alive then '(vivo)' else pg_catalog.to_char(c.to_ended_at at time zone 'utc', f.ts) end ||
       ' folga_s=' || c.slack_s || ' tentativas_publicação=' || c.attempts::text, 'INFO'
  from classified c, fmt f
 where c.class <> 'CONFIRMADO'
union all
select 'INFO B3 latência created→acknowledged por receptor ' || x.to_role || ' ' || pg_catalog.left(x.to_session_id::text, 8) || ' (ms: n / mín / p50 / máx)', '-',
       x.n::text || ' / ' || x.mn::text || ' / ' || x.p50::text || ' / ' || x.mx::text, 'INFO'
  from (select g.to_session_id, g.to_role, pg_catalog.count(*) as n,
               pg_catalog.round(pg_catalog.min(e)) as mn,
               pg_catalog.round((pg_catalog.percentile_cont(0.5) within group (order by e))::numeric) as p50,
               pg_catalog.round(pg_catalog.max(e)) as mx
          from (select g2.*, pg_catalog.date_part('epoch', g2.updated_at - g2.created_at)::numeric * 1000 as e
                  from signals g2 where g2.state = 'acknowledged') g
         group by 1, 2) x
union all
select 'INFO agora (UTC)', '-', (select pg_catalog.to_char(pg_catalog.now() at time zone 'utc', f.ts) from fmt f), 'INFO'
)
select r.item, r.expected, r.actual, r.status from r
order by r.status = 'PASS', r.status = 'INFO', r.item;

rollback;
