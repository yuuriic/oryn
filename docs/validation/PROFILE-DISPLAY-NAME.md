# Identidade e nome de exibição — validação local

Estado em 2026-11-09: implementação na branch `feat/profile-display-name`, base
`882ee13` (Hybrid Midnight Gold integrado). Não commitada, integrada ou publicada.
Nenhuma alteração no Supabase remoto, push, PR, merge ou deploy nesta entrega.

## Contrato de identidade

- Origem única global: `auth.users.raw_user_meta_data.display_name`, pela API do
  Supabase Auth. Nenhuma tabela de perfil ou RPC pública nova.
- Cadastro por e-mail e senha, com nome. Se o Auth exigir confirmação, a UI pede
  que o usuário confirme o e-mail e depois faça login. Uma resposta sem sessão
  nunca é tratada como login. Fragmentos de confirmação são removidos da URL e
  não substituem uma conta já autenticada. `detectSessionInUrl` continua falso.
- Perfil compacto em diálogo nativo: foco contido, Escape, nome acessível e layout
  Gold. A aplicação só envia `{data: {display_name}}` ao editar a conta atual.
- Regra: rejeitar controles C0/DEL/C1; normalizar os espaços Unicode especificados
  em SQL/TypeScript para um espaço, remover espaços nas pontas e exigir 1–32
  pontos de código. Surrogates isolados são recusados antes do envio; o Postgres
  também não aceita essas sequências em JSON. Não exigir nomes únicos.
- Nome é apresentação: não substitui UUID, referência de membro, papel, convite,
  membership ou qualquer verificação de autorização.

A UI de cadastro exige nome. A ausência de metadado continua aceita no Auth para
compatibilidade com provisionamento legado; essas contas usam os nomes por sala
até adotar o nome global no perfil. Isso não concede permissão para criar salas.
Edições simultâneas do próprio perfil usam a última gravação aceita pelo Auth.

## Compatibilidade e sincronização

`oryn.room_members.display_name` permanece como fallback de contas legadas. A
primeira escolha global ocorre pelo perfil; não se escolhe automaticamente um
dos nomes por sala. Metadados antigos inválidos usam o fallback e não bloqueiam
atualizações de outros campos do Auth. Depois da adoção, remover ou invalidar o
nome é recusado pelo gatilho.

As seis RPCs existentes de roster, participantes, membros, entrada e mensagens
mantêm suas assinaturas, colunas, grants e autorização. Apenas a resolução do nome
prefere o metadado global validado. Não há escrita em cascata em membros,
mensagens, convites ou sessões. O nome retornado por essas RPCs fica consistente
assim que uma consulta nova começa após a alteração.

Clientes antigos ainda podem enviar `p_display_name`: ele grava só o fallback e
nunca sobrescreve o metadado global. Esses clientes podem continuar mostrando
e-mail na lateral e nomes antigos já em memória até consultar novamente. Não é
possível atualizar código de abas antigas sem recarga.

No cliente novo:
- criação e aceitação de convite reutilizam o nome global; contas legadas mantêm
  os campos por sala até adotar o global;
- conta atual consulta o Auth a cada 15 s quando visível; a restauração reaproveita
  o usuário atual retornado por `getUser`, sem mudar tokens ou iniciar chamada;
- membros e chamada aproveitam suas consultas periódicas já existentes;
- chat reconsulta os nomes do intervalo carregado aproximadamente a cada 15 s,
  enquanto visível. Não fecha o painel, não altera o cursor de novidades nem
  descarta fila, nonce, rascunho ou envio pendente. O histórico mostra o nome
  atual, conforme o modelo existente, sem criar snapshots de autoria.

Atualizações não são instantâneas entre aparelhos. Sem rede ou em segundo plano,
o cliente mantém o último nome e converge nas consultas seguintes. O custo extra
do chat é proporcional às páginas de histórico que já estão abertas.

## Migração preparada

`poc/webrtc-audio-supabase/supabase/migrations/20261109224924_oryn_account_display_name.sql`

Migração aditiva e transacional, gerada pela CLI: três funções privadas (normalização,
resolução de nome e validação), um gatilho em `auth.users`, substituição das seis
funções públicas existentes só no ponto que resolve nomes. Helpers sem EXECUTE
para clientes. Gatilho SECURITY DEFINER com `search_path` vazio, necessário para
o Auth invocar a validação sem receber acesso ao schema privado. Não utiliza
metadados em autorização nem adiciona políticas ou grants de cliente.

Aplicada e exercitada apenas no contêiner `supabase_db_oryn-e2e-local`, Postgres
17.11. Testes de bootstrap também a aplicam como dono não superusuário no shim.
As sete migrações anteriores não foram editadas.

O executor remoto `oryn-push-step.ps1` permanece deliberadamente limitado às
sete etapas anteriores e recusa encontrar oito arquivos. Não foi habilitada
publicação desta migração por esse executor. Seus testes usam uma fixture isolada
das sete etapas com CLI falsa; preservam a recusa de árvore suja, sem fazer commits.
Testes de rollback histórico continuam verificando apenas suas etapas originais.

## Execução e evidências

| Verificação | Resultado |
|---|---|
| Regressão Vitest local | 1328 aprovados, 18 TODO, 1 arquivo pulado; nenhuma falha |
| PostgreSQL 17 temporário (regressão completa) | 56/56; concorrência de identidade repetida na migração final: 1/1 |
| Testes dirigidos de identidade, sessão, mesh e SQL | 79/79 |
| Testes dirigidos de fixtures históricas, executor falso e sessão | 96/96 |
| Navegador Chrome, stack real local | 26/26; 0 erros de página |
| Confirmação com GoTrue e SMTP locais | 6/6; 1 e-mail sintético recebido; Auth temporário removido |
| TypeScript e build com configuração local | Sem erros |

A primeira regressão encontrou fixtures que exigiam exatamente sete arquivos de
migração e testes do executor que dependiam da árvore de trabalho limpa. Foram
isoladas as sete etapas históricas na fixture e mantidas as travas do executor.
Também foi corrigida a corrida entre o evento inicial de login do Auth e a
restauração com metadados atuais. O teste em dois contextos reproduziu a falha e
passou depois da correção. Nenhum commit foi usado para contornar essas travas.

Roteiros reproduzíveis, sem leitura de `.env` e sem dependência nova no aplicativo:
- `integration/scripts/identity-local-e2e.mjs`: cadastro, conta legada, duas contas
  em chamada, outro contexto autenticado, chat pendente/rascunho, renomeação,
  mute, contagem de PCs/ofertas, RTP, Soundboard com WAV e perfil desktop/mobile.
- `integration/scripts/identity-confirmation-local.mjs`: Auth descartável com a
  mesma imagem local e SMTP de teste; confirmação exigida, login recusado antes
  de confirmar e aceito depois. O contêiner adicional e o SMTP terminam ao final.

Os roteiros exigem instalação local de Playwright indicada por
`ORYN_PLAYWRIGHT_MODULE`, senha do banco local em `ORYN_LOCAL_DB_PASSWORD` e, no
primeiro, chave publicável local em `ORYN_LOCAL_PUBLIC_KEY`. Não usar valores de
produção. As URLs são fixas em loopback e o banco é a stack descartável local.

O preview anterior na porta 5173 foi preservado. Os roteiros servem os bytes do
build novo no contexto de teste do Playwright, nessa origem, com os cabeçalhos
de `vercel.json` e CSP gerada para a API local. Não simulam Auth, RPC, Storage,
Realtime ou WebRTC. O bloqueio de rede local do Chrome é ajustado só no processo
descartável de teste. Dispositivo de áudio falso e autoplay liberado.

Resultados finais e PNGs em
`poc/webrtc-audio-supabase/integration/evidence/profile-display-name/` (ignorados
pelo Git): cadastro desktop, perfil desktop em chamada, perfil mobile e confirmação
mobile. Só cenários e contas sintéticas; não exportar tokens, senhas ou e-mails reais.

## Limites e eventual publicação

Não comprova qualidade perceptiva de áudio, redes reais, SMTP de produção,
Safari/Firefox ou aplicativo Tauri empacotado. O teste de outro dispositivo usa
outro contexto do navegador na mesma máquina.

Antes de qualquer publicação, em atividade separada e autorizada: revisar o
gatilho e seu acoplamento ao Auth, conferir cadastro/SMTP/confirmação/Site URL no
ambiente alvo, preparar preflight, baseline e plano de reversão, aplicar o banco
antes do cliente. O `config.toml` alterado configura somente a stack local; não
habilita cadastro no serviço remoto. Uma reversão só do frontend conserva o nome
global no Auth e o fallback legado; não remover o gatilho/helper enquanto as
RPCs atuais dependerem deles. Não apagar metadados nem reescrever mensagens.

O limite de quatro contas, a negociação WebRTC, o protocolo de sinalização, o
Soundboard e a composição Hybrid Midnight Gold foram preservados.

## Arquivos da entrega

Todos os caminhos abaixo, exceto este relatório, são relativos a
`poc/webrtc-audio-supabase/`:

| Grupo | Arquivos |
|---|---|
| Interface e identidade | `index.html`, `src/web/identity.ts`, `src/web/main.ts`, `src/web/styles/login.css` |
| Sessão e nomes em telas existentes | `src/web/auth-session.ts`, `src/web/chat.ts`, `src/web/mesh-signaling.ts` (somente rótulo do par existente) |
| Banco e configuração local | `supabase/migrations/20261109224924_oryn_account_display_name.sql`, `supabase/config.toml` |
| Roteiros de navegador | `integration/scripts/identity-local-e2e.mjs`, `integration/scripts/identity-confirmation-local.mjs` |
| Testes novos | `tests/web-identity.test.ts`, `tests/sql-account-name.test.ts`, `tests/pg/account-name.pg.test.ts` |
| Testes ajustados | `tests/auth-session.test.ts`, `tests/helpers/supabase-shim.sql`, `tests/postflight-local.test.ts`, `tests/push-step-script.test.ts`, `tests/sql-review.test.ts`, `tests/web-chat.test.ts`, `tests/web-config.test.ts`, `tests/web-mesh.test.ts` |
| Documentação | `README.md`, `docs/validation/PROFILE-DISPLAY-NAME.md` na raiz do repositório |
