# Etapa 10: capacidade de 5 contas por sala (migração 1000)

Branch `feat/voice-volume-5`, preparada sobre a `main` em `8bdf491`. Este documento **não autoriza** aplicação
remota, publicação, merge, commit ou push. Nada foi executado no Supabase de produção.

Migração: `supabase/migrations/20261112001000_oryn_room_capacity_5.sql` (Etapa Macro 6, piloto privado).

## O que muda

- Muda só o corpo de `oryn.enforce_room_capacity()`: sala **nova** com mais de 5 lugares é recusada. Antes da 1000,
  o limite era 4.
- A função é redefinida com `CREATE OR REPLACE`, que mantém dono, ACL (sem EXECUTE para clientes), `search_path`
  vazio e o gatilho `oryn_room_capacity` (`BEFORE INSERT` em `oryn.rooms`). A própria migração confere isso antes
  do `COMMIT` e falha fechada.
- **Sem mudança:** tabelas, dados, RPCs e políticas. O `CHECK (max_members between 2 and 10)` continua igual.
  Também não mudam o limite de 2 sessões por conta, os 40 sinais por sessão a cada 10 s e as travas de admissão.
- **Salas existentes não mudam:** o gatilho só confere inserções e nenhuma RPC altera `max_members`. Uma sala de 4
  continua sendo de 4.
- **Admissão:** `redeem_room_invite` e `create_room_invite` contam os membros ativos contra `max_members` com a
  sala travada (`FOR NO KEY UPDATE`). A sexta conta de uma sala de 5 é recusada com `room-full`, também em corrida
  pela última vaga (testado em PostgreSQL 17).

## Artefatos

- `scripts/capacity-10-artifacts.mjs`: gera os SQL abaixo e o manifesto a partir do SQL versionado, sem conexão.
  `--check` só compara. Nunca regenerar para contornar divergência de produção.
- `scripts/capacity-10-manifest.json`: SHA-256 (UTF-8, CRLF → LF) das dez migrações e dos três SQL.
- `sql/40_capacity_10_preflight.sql`: confere:
  - o histórico com as nove versões exatas;
  - a função com o corpo da 0600 (md5), owner, ACL, `search_path` e volatilidade;
  - o gatilho ativo e só ele (`BEFORE INSERT FOR EACH ROW`);
  - o `CHECK` da tabela;
  - as permissões de quem migra.

  Só catálogo e histórico: não lê dados de usuários.
- `sql/41_capacity_10_postflight.sql`: o mesmo, com dez versões e o corpo da 1000.
- `sql/97_rollback_capacity_10.sql`: reversão transacional. Exige o `41` antes, restaura o corpo da 0600, tira a
  versão `20261112001000` do histórico e exige o `40` antes do `COMMIT`.

O executor `scripts/oryn-push-step.ps1` aceita `-Step 10`:
- usa a lista fixa das dez migrações e confere os três manifestos;
- roda o pré-voo `40` antes do plano e de novo antes da escrita, e o pós-voo `41` depois;
- recusa reaplicação;
- mantém as demais garantias das etapas 8 e 9: CLI 2.122.0, senha só no ambiente, sem `--yes`, limpeza em `finally`.

## Ordem de publicação: clientes primeiro, banco por último

O aplicativo Windows **embute** o cliente web. Um cliente anterior (desktop instalado antes desta versão, ou aba da
web aberta antes do deploy e não recarregada) conecta a no máximo 3 pares (`MAX_MESH_PEERS = 3`). Numa sala de 5, ele
ignora o participante mais recente: os dois se veem na lista, mas não se ouvem, sem explicação na tela. Por isso
nenhuma sala de 5 pode existir enquanto houver cliente antigo em uso.

1. **Web (Vercel).** Publicar o cliente novo: ele oferece 5 lugares, conecta a até 4 pares e traz o volume
   individual. Funciona com o banco atual.
2. **Desktop.** Distribuir o instalador novo. Também funciona com o banco atual.
3. **Confirmação.** Confirmar que todos os participantes conhecidos do piloto atualizaram o desktop e recarregaram
   as abas da web.
4. **Banco (1000).** Só depois da confirmação, pedir autorização para aplicar a 1000, que habilita salas de 5.

Entre os passos 1 e 4, quem escolher 5 lugares recebe "Nome da sala, nome de exibição ou número de lugares inválido"
e nada é criado. As salas de 2 a 4 funcionam normalmente.

**Risco residual:** o servidor não conhece a versão do cliente e não existe bloqueio de versão. Um cliente antigo
que escape da confirmação ainda pode entrar numa sala de 5 e ficar sem o áudio de um participante. A mitigação é
operacional (a distribuição é privada e os participantes são conhecidos). Uma trava técnica exigiria contrato novo no
servidor e está fora deste incremento.

## Sequência futura, mediante autorizações específicas

1. Revisão arquitetural; commit assinado pelo usuário; PR com CI.
2. Publicar a web e distribuir o instalador desktop novo, cada um com autorização própria. Fazer o smoke com contas
   controladas: criar sala de 2 a 4, entrar por convite, voz, chat e volume individual. Escolher 5 lugares deve dar a
   mensagem de lugares inválido.
3. Confirmar que todos os participantes conhecidos do piloto estão na versão nova (desktop reinstalado, abas
   recarregadas). Sem essa confirmação, não seguir.
4. Operador único, em janela de baixo uso, com backup lógico privado antes (o plano não tem PITR). Registrar o `40`
   em evidência privada.
5. Com autorização do pré-voo remoto, na pasta da POC:

   ```powershell
   pwsh -File integration/scripts/oryn-push-step.ps1 -Step 10
   ```

   Exigir plano contendo exclusivamente `20261112001000`.
6. Somente com autorização explícita da migração remota:

   ```powershell
   pwsh -File integration/scripts/oryn-push-step.ps1 -Step 10 -Apply
   ```

   Digitar exatamente `APLICAR 20261112001000`.
7. Registrar o `41`. Fazer o smoke com contas controladas: criar uma sala de 5 e conferir que a sexta conta é
   recusada. Depois, homologar com 5 pessoas reais (seção seguinte).

## Homologação real com 5 participantes (pendente)

Os testes automatizados provam a coordenação (quem conecta com quem, admissão, limites) e não a qualidade do áudio.
Antes de liberar salas de 5 no piloto, medir com 5 pessoas reais, em redes domésticas e com jogo aberto:

- tempo de entrada do quinto participante;
- 4 conexões estabelecidas em cada cliente;
- perda, jitter e RTT;
- CPU e memória;
- recusa do sexto participante;
- saída e volta;
- volume individual e "Silenciar para mim" sem efeito nos outros.

Sem TURN, redes com CGNAT, 4G ou UDP bloqueado podem não conectar todos os pares (ARCHITECTURE.md §9.1). Isso é um
requisito separado da liberação externa.

## Falhas e recuperação

Se houver erro, timeout ou desconexão durante a aplicação, parar. A 1000 roda em `BEGIN … COMMIT`, e uma falha antes
do `COMMIT` desfaz tudo. Antes de qualquer nova tentativa, consultar o histórico e a função. Não usar
`migration repair` automaticamente nem aplicar o SQL à mão.

Se for preciso voltar ao limite de 4 (com autorização):

Voltar ao limite de 4 **no banco** não significa voltar ao cliente antigo. As salas de 5 continuam existindo depois
da reversão, e um cliente com `MAX_MESH_PEERS = 3` deixaria essas salas sem o áudio de um participante.

1. Antes de reverter, publicar um cliente que **preserve `MAX_MESH_PEERS = 4`** e apenas deixe de oferecer 5 lugares
   (`ROOM_CAPACITIES` até 4). Se houver salas de 5, **não** distribuir o cliente antigo, nem a web nem o instalador
   desktop anterior.
2. Alternativa operacional, por decisão do proprietário: encerrar as salas de 5 antes da reversão.
3. Executar integralmente `97_rollback_capacity_10.sql` como o dono das funções, em ferramenta que preserve a
   transação e interrompa em erro.

Depois da reversão:
- as salas já criadas com 5 lugares continuam válidas, com os mesmos membros (testado);
- `40` volta a OK e `41` a FAIL;
- a etapa 10 pode ser reaplicada pelo executor (testado).

Executada uma segunda vez, a reversão encontra o pós-voo ausente e não faz nada.

## Validação local direcionada

```powershell
node integration/scripts/capacity-10-artifacts.mjs --check
pnpm exec vitest run tests/sql-room-membership.test.ts tests/sql-channels.test.ts tests/push-step-script.test.ts
pnpm exec vitest run --config vitest.pg.config.ts tests/pg/capacity-publication.pg.test.ts
pnpm exec tsc --noEmit
```

Os testes do executor usam CLI falsa e fixture temporária, sem rede. Os testes em PostgreSQL usam um servidor
descartável em loopback, com o shim do Supabase e um owner não superusuário. Evidências de produção: nenhuma.
