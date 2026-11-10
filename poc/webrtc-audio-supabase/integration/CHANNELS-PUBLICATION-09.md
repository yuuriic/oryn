# Etapa 9 — canais persistentes (migração 0900)

Branch `feat/channels-0900`, preparada sobre a `main` em `0774829`. Este documento **não autoriza** aplicação
remota, publicação, merge, commit ou push. Nada foi executado no Supabase de produção.

Migração: `supabase/migrations/20261110000900_oryn_channels.sql` (I-1 do diagnóstico de espaços e canais).

## Modelo

- Cada linha de `oryn.rooms` é um **espaço**; `oryn.room_members` continua sendo a lista de membros. Tabelas não
  foram renomeadas.
- `oryn.channels` guarda os canais do espaço: `kind` (`text` ou `voice`), `name` (1–40), `position`,
  `is_default`, `archived_at`. Toda sala tem exatamente um canal padrão de cada tipo (`conversa` e `voz`).
- `room_messages.channel_id` e `room_sessions.channel_id` são obrigatórios, com chave estrangeira composta
  `(room_id, channel_id)` para `oryn.channels (room_id, id)`: mensagem ou sessão nunca aponta para canal de outro
  espaço, nem por inserção direta.
- Gatilhos `BEFORE INSERT` preenchem o canal padrão quando `channel_id` vem nulo e recusam canal do tipo errado.
  Um gatilho `AFTER INSERT` em `oryn.rooms` cria os dois canais padrão das salas novas.

## Contratos

**Mantidos (mesma assinatura, retorno e códigos de erro), agora sobre os canais padrão:** `create_room` (sem
mudança de corpo), `send_room_message`, `list_room_messages`, `join_room`, `get_roster`,
`get_voice_participants`. O cliente publicado continua funcionando sem atualização.

**Redefinidos por isolamento de voz:** `leave_room` (o `bye` vai só para o canal da sessão) e
`authorize_signal` (remetente e destinatário no mesmo canal; antes, na mesma sala). No canal padrão, o
comportamento é o de antes.

**Novos (EXECUTE só para `authenticated`, `SECURITY DEFINER`, `search_path` vazio, chamador por
`oryn.require_uid()`):**

| RPC | Regra |
|---|---|
| `list_channels(p_room_id)` | membro ativo (sala aberta ou encerrada); arquivados no fim |
| `create_channel(p_room_id, p_name, p_kind)` | só o dono, sala aberta; até 20 canais ativos; nome único por tipo entre os ativos (`name-taken`) |
| `archive_channel(p_channel_id)` | só o dono, sala aberta; padrões não; idempotente; na voz, envia `bye` e revoga as sessões (`channel-archived`) |
| `send_channel_message(p_channel_id, p_client_nonce, p_body)` | membro ativo; canal de texto; não arquivado; mesma idempotência e limite de taxa do espaço |
| `list_channel_messages(p_channel_id, …)` | membro ativo; canal de texto (arquivado continua legível) |
| `join_voice_channel(p_channel_id)` | membro ativo, sala aberta, canal de voz não arquivado |
| `get_channel_participants(p_channel_id)` | membro ativo; canal de voz |

**Voz:** um usuário não mantém sessões vivas em dois canais de voz do mesmo espaço (`in-other-channel`; sair
antes). Entre espaços diferentes nada muda. O limite de 2 sessões por usuário por sala e a capacidade de membros
(até 4) não mudam. `hello`/`bye` e sinalização ficam restritos ao canal; os tópicos do Realtime continuam por
sessão (`oryn:s:{sessão}`), sem mudança de política.

**Travas:** a entrada na voz trava a linha de membro e depois o canal (`FOR SHARE`); o arquivamento trava a sala
e depois o canal. Entrada e arquivamento se serializam pelo canal; envio e arquivamento, pela sala. Os testes em
PostgreSQL 17 mostram que, sem cada trava, a corrida correspondente aparece.

## Artefatos

- `scripts/channels-09-artifacts.mjs`: gera os SQL abaixo e o manifesto a partir do SQL versionado, sem conexão.
  `--check` só compara. Nunca regenerar para contornar divergência de produção.
- `scripts/channels-09-manifest.json`: SHA-256 (UTF-8, CRLF → LF) das nove migrações e dos quatro SQL.
- `sql/30_channels_09_preflight.sql`: histórico com as oito versões exatas; corpos, assinaturas, volatilidade,
  owner, `search_path` e ACLs das sete RPCs a redefinir; ausência da tabela, colunas e funções da 0900;
  permissões do papel que migra (inclusive ser dono das tabelas de `oryn`).
- `sql/31_channels_09_postflight.sql`: nove versões; as 22 funções da 0900 (corpo por md5 e ACL); RLS sem política
  e sem privilégio em `oryn.channels`; `channel_id` NOT NULL com as chaves compostas; índices; os 3 gatilhos
  ativos; o novo motivo de revogação; e agregados (cada sala com um padrão de cada tipo, nenhuma mensagem fora de
  canal de texto, nenhuma sessão fora de canal de voz). Não lê conteúdo nem identificadores.
- `sql/32_channels_09_recovered.sql`: estado depois da recuperação.
- `sql/96_recover_channels_09.sql`: recuperação transacional, com guardas antes e depois.

O executor `scripts/oryn-push-step.ps1` aceita `-Step 9` com a lista fixa das nove migrações, confere os dois
manifestos e roda o pré-voo `30` antes do plano e antes da escrita, e o pós-voo `31` depois. Reaplicação é
recusada. Demais garantias iguais às da etapa 8 (CLI 2.122.0, senha só no ambiente, sem `--yes`, limpeza em
`finally`).

Os verificadores históricos `01_postflight.sql` e `05_step_checks.sql` passam a conhecer a 0900 (passo 9 e
contagens de 13 tabelas e 36 RPCs). Antes da aplicação, o `01` dá FAIL nesses itens: esperado.

## Sequência futura, mediante autorizações específicas

1. Revisão arquitetural; commit assinado pelo usuário; PR com CI.
2. **Ordem de publicação: banco antes do frontend.** As RPCs antigas foram mantidas para isso: o cliente
   publicado funciona com o banco já migrado. O frontend que usa canais (I-2) só pode ser integrado depois.
3. Operador único, janela de baixo uso, backup lógico privado antes (plano sem PITR). Registrar o `30` em
   evidência privada.
4. Com autorização do pré-voo remoto, na pasta da POC:

   ```powershell
   pwsh -File integration/scripts/oryn-push-step.ps1 -Step 9
   ```

   Exigir plano contendo exclusivamente `20261110000900`.
5. Somente com autorização explícita da migração remota:

   ```powershell
   pwsh -File integration/scripts/oryn-push-step.ps1 -Step 9 -Apply
   ```

   Digitar exatamente `APLICAR 20261110000900`.
6. Registrar o `31` e o `05_step_checks.sql` (passo 9). Smoke com contas controladas no cliente publicado:
   chat, voz, convites e soundboard como antes.

O merge desta branch publica apenas arquivos de migração e testes; nenhum frontend muda nesta entrega.

## Falhas e recuperação

Erro, timeout ou desconexão durante a aplicação: parar. A 0900 roda em `BEGIN … COMMIT`; falha antes do COMMIT
desfaz tudo (testado). Consultar histórico e objetos antes de qualquer nova tentativa; não usar
`migration repair` automaticamente nem aplicar o SQL à mão.

Se for preciso desfazer o comportamento (com autorização e cliente sem canais publicado):

1. Conferir o `31` e executar integralmente `96_recover_channels_09.sql` como o dono das funções, em ferramenta
   que preserve a transação e interrompa em erro.
2. O script exige o pós-voo exato; devolve os corpos anteriores das sete RPCs redefinidas (`CREATE OR REPLACE`,
   mantém assinaturas, owner e grants) e tira o EXECUTE das sete RPCs novas.
3. **Mantém** a tabela, as colunas, índices e gatilhos: os gatilhos levam toda gravação dos corpos antigos ao
   canal padrão. Sem DROP, CASCADE, DML de dados ou alteração do histórico. Exige o `32` antes do COMMIT.

Depois da recuperação: dados preservados integralmente (testado); o histórico mantém a nona versão (o executor
recusa reaplicação); `30` e `31` passam a FAIL e `32` a OK. Limitações aceitas: mensagens de canais não padrão
voltam a aparecer no chat único da sala (mesmo espaço, mesmos membros), e sessões vivas em canais de voz não
padrão expiram pelo batimento. Reativação exige novo plano e migração compensatória autorizada.

## Validação local direcionada

```powershell
node integration/scripts/channels-09-artifacts.mjs --check
pnpm exec vitest run tests/sql-channels.test.ts tests/sql-definer-audit.test.ts tests/sql-review.test.ts tests/sql-permissions.test.ts tests/postflight-local.test.ts tests/push-step-script.test.ts
pnpm exec vitest run --config vitest.pg.config.ts tests/pg/channels.pg.test.ts tests/pg/channels-publication.pg.test.ts
pnpm exec tsc --noEmit
```

Os testes do executor usam CLI falsa e fixture temporária, sem rede. Os testes em PostgreSQL usam servidor
descartável em loopback, com shim do Supabase e owner não superusuário. Evidências de produção: nenhuma.
