-- Soundboard: reconciliação de objetos, SOMENTE LEITURA. Não apaga nada. Só identificadores técnicos, sem conteúdo nem dados de conta.
-- orfao_sem_catalogo   objeto sem linha no catálogo: conta ou sala excluída, ou envio perdido;
-- apagado_com_objeto   catálogo diz que o objeto foi apagado, mas ele existe;
-- pendente             trabalho que a função `sound-media` conclui quando o dono abrir o painel, com a idade em horas.
-- Apagar objeto órfão é operação à parte, pela Storage API, com autorização.

begin;
set transaction read only;

select 'orfao_sem_catalogo' as tipo, o.name as chave, null::numeric as idade_horas
  from storage.objects o
 where o.bucket_id = 'oryn-sounds' and not exists (select 1 from oryn.sound_assets a where a.object_key = o.name)
union all
select 'apagado_com_objeto', a.object_key, null
  from oryn.sound_assets a
 where a.object_deleted_at is not null and exists (select 1 from storage.objects o where o.bucket_id = 'oryn-sounds' and o.name = a.object_key)
union all
select 'pendente', a.object_key, pg_catalog.round((extract(epoch from pg_catalog.now() - coalesce(a.delete_requested_at, a.upload_expires_at)) / 3600)::numeric, 1)
  from oryn.sound_assets a
 where a.state = 'pending_delete' or (a.state = 'rejected' and a.object_deleted_at is null)
    or (a.state = 'quarantine' and a.upload_expires_at <= pg_catalog.now())
order by 1, 2;

rollback;
