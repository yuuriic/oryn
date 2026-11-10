# PR #23 — publicação da identidade da conta

Branch `feat/profile-display-name`. Preparado sobre `b210aec`; migração aplicada a
partir de `e3db322`; recuperação de senha em `40273f4`. Este documento não autoriza
merge, publicação, alterações de Auth, commit ou push. A migração funcional
`20261109224924_oryn_account_display_name.sql` permanece intacta.

## Estado em 2026-11-10

| Item | Estado | Origem da evidência |
|---|---|---|
| Migração `20261109224924` | **Aplicada** no remoto em 2026-11-10T02:14:41Z, a partir de `e3db322`. Pós-voo `21` OK, histórico com oito versões, `oryn_scope` de 93 para 96 entradas (três helpers novos e seis RPCs alteradas) | Registro da aplicação e auditoria daquela sessão |
| SMTP do Auth | Gmail SMTP configurado; envio de e-mail comprovado (convite e recuperação) | Relatado pelo operador |
| Site URL e Redirect URLs | Configurados conforme evidências anteriores; Site URL não alterada nesta etapa | Relatado pelo operador; não relido nesta atualização |
| Recuperação de senha | Homologada com Supabase remoto e conta de teste: e-mail recebido, link aberto no ambiente local, senha alterada, nova senha aceita, senha anterior recusada, reutilização do link recusada, sessões anteriores encerradas | Relatado pelo operador; testes automatizados, inspeção visual e CI do `40273f4` verificados |
| Ambiente temporário | Servidor local `127.0.0.1:5174` encerrado; Redirect URL temporária `http://127.0.0.1:5174/` removida | Encerramento verificado; remoção relatada pelo operador |
| Cadastro público | **Desabilitado** no projeto real | Relatado pelo operador |
| Merge e publicação | **Não autorizados**; o frontend do PR #23 não está em produção | Estado do PR e do Git |

O backup lógico pré-migração é privado e fica fora do repositório (contém dados
pessoais do Auth). No plano atual, sem backups gerenciados/PITR, a recuperação primária
do banco é a `95` (seção "Falhas e recuperação").

Este PR contribui para a Etapa Macro 6 (piloto Windows/web), mas não a encerra. A
recuperação de senha não é evidência do P08 (recuperação operacional), definido em
`ARCHITECTURE.md` §14 e exigido pela Etapa 6 em §17.

## Estado de referência e limites

Registro histórico do pré-voo, anterior à aplicação: sete migrações, nenhum
helper/gatilho do perfil, seis RPCs coincidentes com o SQL anterior e `oryn_scope`
com 93 entradas / MD5 `0ad4a054e64e1a2122c27e58021e8838`. Depois da aplicação, o
histórico já tem a oitava versão: o executor recusa a etapa 8 no pré-voo, e a
migração **não deve ser reaplicada**.

O CI não comprova configurações remotas nem a entrega de e-mails; essas evidências vêm
da homologação acima. Templates de confirmação de cadastro no remoto não foram
homologados, porque o cadastro público segue desabilitado. Não aplicar `config.toml`
local ao serviço remoto. Cadastro não concede direito de criar salas.

## Artefatos e executor

- `scripts/profile-08-manifest.json`: nomes exatos e SHA-256 das oito migrações e
  quatro scripts SQL. Hashes em UTF-8, normalizando apenas CRLF para LF.
- `scripts/profile-08-artifacts.mjs`: gera os artefatos a partir do SQL aprovado,
  sem conexão ao banco. `--check` só compara. Alterar o manifesto requer revisão;
  nunca regenerá-lo para contornar uma divergência de produção.
- `sql/20_profile_08_preflight.sql`: SELECT de catálogo e histórico. Exige as sete
  versões e nomes exatos, seis RPCs anteriores (corpos, assinaturas, retornos,
  volatilidade, owner, SECURITY DEFINER, search_path e ACLs), ausência dos helpers
  e gatilho do perfil e permissões necessárias. Nenhuma leitura de contas.
- `sql/21_profile_08_postflight.sql`: exige oito versões, seis RPCs novas, três
  helpers privados e o gatilho em `auth.users`, incluindo eventos, coluna, função
  alvo e estado habilitado. Não chama RPCs nem escreve dados.
- `sql/22_profile_08_recovered.sql`: confere a recuperação funcional específica.
- `sql/95_recover_profile_08.sql`: recuperação transacional, com guardas antes e
  depois; não é um rollback geral.

O executor aceita apenas a lista histórica exata, com sete ou oito arquivos; a
etapa 8 exige os oito. Preserva as etapas 1–7 e fixa a CLI em **2.122.0**. Recusa
arquivos SQL extras, renomeados ou alterados e árvore suja em `supabase/`,
`integration/scripts/` ou `integration/sql/`. Os hashes das cópias temporárias são
conferidos. A senha continua SecureString, apenas no ambiente durante a execução,
sem argumento de linha de comando, com limpeza em `finally`. Não usar `--debug`.

Na etapa 8, executa o pré-voo via `db query --linked --project-ref ... --file ...
--output json` (Management API, somente SELECT). Exige acesso de leitura pela API;
essa consulta não usa a senha do banco como substituto da autenticação da API.
Indisponibilidade, FAIL ou saída desconhecida bloqueiam o procedimento. Reconfere
o pré-voo depois do dry-run e antes do push. O plano só pode conter a versão alvo;
saídas contraditórias ou outras versões são recusadas. Depois do push, exige
banco em dia **e** pós-voo correto para anunciar APLICADO. Histórico já com a
oitava versão é recusado no pré-voo, inclusive após recuperação.

## Sequência da publicação

Os passos 1 a 6 foram cumpridos (artefatos em `e3db322`, aplicação e pós-voo em
2026-11-10) e ficam como registro do procedimento; **não repetir**. No passo 7, SMTP,
Site URL e redirects foram tratados conforme a tabela acima; a confirmação de cadastro
continua pendente até a decisão de habilitar o cadastro. Resta o passo 8.

1. Revisar e registrar estes artefatos em commit assinado pelo fluxo do usuário;
   atualizar o PR e obter CI apropriado.
2. Confirmar projeto alvo, commit e manifesto. Reservar operador único e janela
   de baixo uso, sem outros executores/migradores ou alterações concorrentes de
   schema. As consultas e o push usam sessões distintas; não há trava distribuída
   abrangendo o procedimento. O CREATE de gatilho exige trava em `auth.users`.
3. Registrar os SELECTs `20` e o escopo/schema antes da aplicação em evidência
   privada. Conferir backup/recuperação disponíveis no plano e preservar definições
   e grants de referência. Não arquivar credenciais ou dados pessoais. Não usar
   baselines antigas S2/S4 como prova da etapa 8: ainda refletem a sexta migração.
4. Com autorização para o pré-voo remoto, na pasta da POC:

   ```powershell
   pwsh -File integration/scripts/oryn-push-step.ps1 -Step 8
   ```

   Informar projeto e senha pelos prompts. Exigir plano contendo exclusivamente
   `20261109224924`. O script não faz backup, não configura Auth nem publica frontend.
5. Somente com autorização explícita da migração remota:

   ```powershell
   pwsh -File integration/scripts/oryn-push-step.ps1 -Step 8 -Apply
   ```

   Digitar exatamente `APLICAR 20261109224924`. Não acrescentar `--yes`.
6. Registrar pós-voo `21`, histórico, escopo e diff estrutural. Esperado no escopo
   histórico: três novas funções e seis corpos alterados; o gatilho em `auth.users`
   precisa da verificação separada. Investigar qualquer outra diferença. Não
   alterar baselines simplesmente para obter PASS.
7. Aprovar separadamente configuração de SMTP/remetente, confirmação, Site URL e
   redirects. Coordenar habilitação do cadastro com a publicação do frontend.
   Confirmar também templates de confirmação compatíveis com o retorno à aplicação.
8. **Pendente.** Só então autorizar integração/publicação e smoke funcional com contas
   controladas. O merge do PR #23 pode disparar o deploy automático em produção:
   tratar merge como publicação. Antes dele, reconfirmar o estado remoto por leitura
   e que a origem de produção é a Site URL ou consta nas Redirect URLs (a recuperação
   de senha volta para a origem da página). Cadastro, confirmação, edição de nome,
   salas e chat escrevem dados: precisam de autorização própria. Habilitar o cadastro
   público é decisão separada. Não repetir a regressão remota completa.

## Falhas e recuperação

Erro, timeout ou desconexão: parar; não concluir que houve rollback apenas pelo
código de saída. Consultar histórico e objetos. Se os sete estados anteriores
continuarem íntegros e não houver objetos do perfil, a migração continua pendente;
uma nova tentativa exige diagnóstico e autorização. O SQL aprovado contém BEGIN/
COMMIT; o registro da versão é responsabilidade do mecanismo de migrações. Estado
parcial ou histórico divergente exige investigação; não usar `migration repair`
automaticamente e não aplicar o SQL à mão para "completar".

Para falha exclusiva do frontend, retornar ao Gold pode bastar, conservando banco
e nomes globais. Essa publicação de recuperação também exige autorização.

Se for necessário desfazer o comportamento do banco:

1. Autorizar a recuperação e assegurar frontend Gold e operador único. Conferir
   `21` e executar integralmente `95_recover_profile_08.sql` como o mesmo owner
   das funções, em ferramenta que preserve a transação e interrompa em erro.
2. O script exige o estado pós-migração exato; restaura as seis RPCs anteriores
   com CREATE OR REPLACE (mantém assinaturas, owner e grants) e troca apenas o
   validador por `RETURN NEW`. Mantém gatilho habilitado e três helpers privados.
   Não precisa ser dono de `auth.users`, nem usa DROP TRIGGER, CASCADE ou DML.
3. Exige `22` correto antes do COMMIT. Conferir novamente `22` e guardar o registro
   da recuperação. Falha em qualquer comando exige ROLLBACK/encerramento da sessão;
   não continuar uma transação com erro.

Usuários, metadados (inclusive nomes escolhidos), salas, membros, convites, sessões,
mensagens e catálogo/objetos de sons são preservados. A apresentação retorna ao
fallback por sala. O validador inerte restaura o comportamento anterior de aceitar
metadados sem a validação do perfil. O histórico conserva a oitava versão como
registro de aplicação; `20` e `21` passam a FAIL e `22` a OK. Isso é intencional:
o executor recusa reaplicação. Reativação ou limpeza definitiva requer novo plano
e migração compensatória autorizada, nunca remoção silenciosa do histórico.

Não executar `90_rollback.sql` nem os rollbacks 0400–0700 para recuperar perfil.

## Validação local direcionada

```powershell
node integration/scripts/profile-08-artifacts.mjs --check
pnpm exec vitest run tests/push-step-script.test.ts
pnpm exec vitest run --config vitest.pg.config.ts tests/pg/profile-publication.pg.test.ts
pnpm exec tsc --noEmit
```

Os testes do executor usam CLI falsa e fixture temporária: não acessam rede. Os
testes SQL usam PostgreSQL 17 descartável em loopback, com shim do Supabase e owner
não superusuário, sem propriedade de `auth.users`. Validam histórico divergente,
ACL/permissões, colisão de helper, aplicação, falha antes do COMMIT, reaplicação,
falha durante recuperação, gatilho alterado e preservação de todos os registros
das tabelas do domínio/Auth/Storage do cenário sintético.

`ORYN_PROFILE_LOCAL_CLI`, opcional, aponta para a CLI real para validar o formato
JSON em um SELECT no PostgreSQL efêmero. A URL é sempre loopback; a senha fica no
ambiente do subprocesso. Isso não valida a Management API remota.

Evidências locais ignoradas pelo Git: `integration/evidence/profile-publication/`.
Resultados desta preparação e limitações devem acompanhar o pedido de autorização;
eles não constituem homologação do Auth ou do frontend em produção.

Resultado local: **36/36** testes do executor e **4/4** testes em PostgreSQL 17,
incluindo o probe opcional da CLI real; TypeScript, integridade dos artefatos e
`git diff --check` sem erros. JSONs `executor-results.json` e
`postgres-results.json` na pasta privada acima. Sem regressão funcional completa.
