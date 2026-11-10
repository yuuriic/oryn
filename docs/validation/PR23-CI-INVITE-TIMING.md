# PR #23 — falha temporal na reentrada por convite

Diagnóstico em 2026-11-09, branch `feat/profile-display-name`, sobre o commit
`19c375acc6bc412286462a6a6b30d657413c06c9`. Correção local, sem novo commit, push,
execução remota, alteração de produção ou regressão completa.

## Falha observada

[POC-02C CI, execução 42721618287](https://github.com/yuuriic/oryn/actions/runs/42721618287):
Windows aprovado; Ubuntu 24.04 reprovado no teste de reentrada depois de remoção,
`tests/sql-room-membership.test.ts:251`. Esperado `null`; recebido `invite-invalid`.
Ubuntu: 1327 aprovados, 1 reprovado, 18 TODO. Os logs não registram os timestamps
das linhas do cenário; a igualdade descrita abaixo foi comprovada na reprodução
local determinística, não lida diretamente do runner.

## Causa

O convite usa `created_at default now()`. A remoção grava
`removed_at = clock_timestamp()`. O gatilho `oryn.guard_member_reactivation`, da
migração 0600, exige `i.created_at > old.removed_at`, além de conferir o usuário e
o consumo do convite na mesma transação. Igualdade é intencionalmente recusada.

No PGlite 0.5.11 instalado, o relógio de parede passa por
`_emscripten_date_now = () => Date.now()`: resolução de milissegundos. Duas RPCs
sequenciais podem concluir dentro do mesmo milissegundo. O teste positivo
pressupunha que a ordem das chamadas implicava timestamps estritamente distintos.
Isso não é garantido.

Cada teste cria e fecha seu próprio PGlite; não há evidência de vazamento de estado
entre casos. A diferença Windows/Ubuntu é compatível com o tempo de execução das
operações, não com uma diferença de autorização entre sistemas.

## Reprodução controlada

Sem modificar código de aplicação ou o relógio do sistema operacional, foi
substituído `Date.now` apenas no processo Node de diagnóstico, após criar o cenário.
Remoção, criação e resgate usaram o mesmo milissegundo; depois o relógio avançou 1 ms.

| Banco descartável | Convite com `created_at = removed_at` | Novo convite após avançar 1 ms |
|---|---|---|
| Somente migrações 0100–0700 | `invite-invalid` | sucesso (`null`) |
| Incluindo migração de nome global | `invite-invalid` | sucesso (`null`) |

O teste original também foi executado isoladamente, antes da alteração, e passou
nessa execução. Isso não elimina a instabilidade: o cenário controlado reproduz
a recusa em ambas as versões do schema, inclusive no Windows.

O commit de perfil não altera `create_room_invite`, `redeem_room_invite`,
`guard_member_reactivation` ou `end_membership`. As migrações 0200 e 0600 estão
inalteradas entre `882ee13` e `19c375a`. A migração de perfil só muda a resolução
de nomes nas RPCs existentes, não a criação/validação temporal dos convites.

## Correção realizada

Somente `tests/sql-room-membership.test.ts`:
- O cenário positivo controla `Date.now` com spy restaurado em `finally` e avança
  exatamente 1 ms entre remoção e criação do convite. Confere explicitamente no
  banco que `created_at > removed_at`, mantendo sucesso, nomes, histórico e retorno
  à chamada como asserções obrigatórias.
- O cenário positivo passa a cobrir conta legada e conta com nome global. Nesta
  última, o nome global permanece mesmo quando o resgate envia outro nome por sala.
- Novo caso congela o relógio no mesmo milissegundo e exige `invite-invalid`, membro
  ainda removido, sessão revogada e convite não consumido.

Não há sleep arbitrário, retry de asserção, teste ignorado para ocultar a falha,
troca de `>` por `>=` ou alteração de migração já aplicada. O comportamento
conservador da autorização é preservado: um convite sem timestamp estritamente
posterior não reativa um membro removido.

## Validação direcionada

| Execução | Resultado |
|---|---|
| Casos positivo legado/global e igualdade | 3 aprovados; demais 31 casos não selecionados |
| Arquivo completo de membros + SQL de nome global | 40/40 aprovados |
| PostgreSQL 17 temporário: resgate preso na remoção, controle sem gatilho e renomeações concorrentes | 3 aprovados; demais 9 casos não selecionados |
| TypeScript (`tsc --noEmit`) | Sem erros |
| `git diff --check` | Sem erros |

Comandos executados a partir de `poc/webrtc-audio-supabase`:

```text
pnpm exec vitest run tests/sql-room-membership.test.ts -t "convite emitido depois da remoção" --maxWorkers=1
pnpm exec vitest run tests/sql-room-membership.test.ts -t "convite emitido depois da remoção|timestamp igual" --maxWorkers=1
pnpm exec vitest run tests/sql-room-membership.test.ts tests/sql-account-name.test.ts --maxWorkers=1
pnpm exec vitest run --config vitest.pg.config.ts tests/pg/room-membership.pg.test.ts tests/pg/account-name.pg.test.ts -t "resgate preso|controle: sem o gatilho|renomeações concorrentes"
pnpm exec tsc --noEmit
```

## Parecer

APTO para preparar uma atualização do PR #23 com esta correção de testes.
A confirmação no Ubuntu deve vir do CI do próximo commit autorizado; não houve
execução local de Linux nem reexecução remota de workflows nesta atividade.
Os gates de migração, configuração do Auth e publicação registrados no relatório
de perfil continuam válidos. Este diagnóstico não autoriza integração ou deploy.
