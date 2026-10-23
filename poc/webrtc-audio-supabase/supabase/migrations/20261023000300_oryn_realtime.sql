-- POC-02C.1A — autorização dos canais PRIVADOS do Realtime para os tópicos da Oryn (oryn:s:{sessão}).
--
-- - Receber: só o dono de uma sessão ativa, de membro ativo, em sala aberta (oryn.can_receive_topic).
-- - Enviar: NENHUM cliente envia Broadcast/Presence em tópicos oryn:* (sem política INSERT permissiva e com
--   política RESTRITIVA que nega INSERT nesses tópicos). Toda publicação é do servidor: realtime.send em
--   funções SECURITY DEFINER (eventos de controle) ou Edge Function com a chave secreta (sinalização).
-- - Presence nos tópicos oryn:* também é negado (sem política; restritiva cobre leitura/escrita).
-- Requer, no projeto Supabase real: canais com `private: true` e "Allow public access" DESLIGADO
-- (configuração do painel, NOT VERIFIED nesta etapa).

alter table realtime.messages enable row level security;

-- Receber: tópico exato oryn:s:{sessão} (minúsculo, como o servidor publica) e sessão própria ativa.
create policy oryn_receive_own_session_topic on realtime.messages
  as permissive for select to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and (select realtime.topic()) like 'oryn:s:%'
    and (select oryn_realtime.can_receive_topic((select realtime.topic())))
  );

-- Barreiras RESTRITIVAS (valem mesmo que outra política permissiva seja criada no futuro). A comparação é
-- sem distinção de maiúsculas: "ORYN:..." também é tratado como tópico da Oryn.
create policy oryn_topics_read_guard on realtime.messages
  as restrictive for select to authenticated
  using (
    (select realtime.topic()) is null
    or pg_catalog.lower((select realtime.topic())) not like 'oryn:%'
    or (realtime.messages.extension = 'broadcast'
        and (select realtime.topic()) like 'oryn:s:%'
        and (select oryn_realtime.can_receive_topic((select realtime.topic()))))
  );

-- anon nunca lê tópicos da Oryn (sem depender de função: anon não tem EXECUTE em nada do domínio).
create policy oryn_topics_read_guard_anon on realtime.messages
  as restrictive for select to anon
  using ((select realtime.topic()) is null or pg_catalog.lower((select realtime.topic())) not like 'oryn:%');

-- Nenhum cliente escreve (Broadcast ou Presence) em tópicos da Oryn.
create policy oryn_topics_no_client_write on realtime.messages
  as restrictive for insert to authenticated, anon
  with check ((select realtime.topic()) is null or pg_catalog.lower((select realtime.topic())) not like 'oryn:%');
