# TURN no Oryn: credenciais temporárias e relay na malha de voz

Branch `feat/turn-relay`, preparada sobre a `main` em `204e57b`. Este documento **não autoriza** provisionar o provedor,
criar chaves, gravar secrets, publicar a função, a web ou o desktop, nem fazer commit, push ou merge. Nada foi executado
fora da máquina local.

Referência: `ARCHITECTURE.md` §9.1 (TURN antes do piloto externo, com UDP bloqueado e TCP/TLS testados). TURN é uma
pendência da Etapa Macro 4 que chega à Etapa 6. As etapas macro não mudam.

**Estado: implementado e validado localmente, com simulações. TURN real, relay UDP e TURN/TLS NÃO estão homologados.**

## Arquitetura

```
navegador / desktop ── POST /functions/v1/turn  {room_id, channel_id, session_id} + JWT do usuário
        │                     │
        │                     ├─ Auth: o JWT é válido? (GET /auth/v1/user)
        │                     ├─ Banco, com o JWT do usuário: a sessão está viva nesta voz e é dele?
        │                     │    get_channel_participants(canal) ou get_voice_participants(sala)
        │                     ├─ Limites em memória (reaproveitamento, pedidos simultâneos, teto por conta)
        │                     └─ Cloudflare: generate-ice-servers {ttl}  (token só na função)
        │◄──── {iceServers (STUN + TURN com credencial temporária), expiresAt}
        │
        └─ IceShare (uma por chamada) ── responde ao pedido ICE de cada par (PeerCall)
```

| Peça | Arquivo | Origem |
|---|---|---|
| Formato de URL ICE e sanitização de listas | `supabase/functions/_shared/ice-servers.ts` | `ice.ts` e `sanitizeServers` da POC-02B |
| Adaptador Cloudflare (emissão) | `supabase/functions/_shared/turn-provider.ts` | `CloudflareTurnProvider` da POC-02B, portado para APIs Web (sem `Buffer`) |
| Autenticação, autorização, limites, configuração e HTTP | `supabase/functions/_shared/turn-core.ts` | Novo; segue o padrão de `signal-core.ts` e `signal-http.ts` |
| Ligação Deno | `supabase/functions/turn/index.ts` | Novo |
| Configuração da chamada, compartilhada | `src/web/ice-share.ts` | Novo; usa `buildRtcConfiguration` (`ice.ts`, cópia da POC) |
| Malha | `src/web/mesh-call.ts` (`ice`, caminho por par) e `src/web/main.ts` | Alteração mínima |

O `src/web/ice.ts` continua idêntico à cópia da POC (teste existente). O `_shared/ice-servers.ts` repete o
`parseIceUrl` e os limites. `tests/turn-function.test.ts` prova a paridade dos dois sobre um conjunto de URLs.

## Fluxo de autorização

1. JWT no formato certo; corpo estrito com exatamente `room_id`, `channel_id` (ou `null`) e `session_id`, até 512 bytes.
   Fora disso, a resposta é 401, 400 ou 413, **sem Auth, banco ou provedor**.
2. JWT válido no Auth; fora disso, 401 (ou 503 se o Auth estiver fora).
3. Com o JWT do usuário, a RPC de participantes da voz pedida. Ela só devolve sessões **vivas e não revogadas** de quem
   é membro ativo. A sessão do corpo tem de estar na lista com `is_self = true`. Senão: 403 `session-invalid` (inclui a
   sessão revogada, vencida, de outra conta ou de outra voz), 403 `not-member`, 400 (canal que não é de voz) ou 503.
   - Sala, canal e sessão do corpo só valem depois dessa confirmação. No canal, a sala vem do próprio canal (a RPC a
     deriva); `room_id` só é usado na voz padrão.
   - **Sem migração**: as RPCs são as das migrações 0600 e 0900.
4. Provedor desligado → 503 `turn-unavailable`.
5. Limites (seção seguinte) → 429 `ice-limit`.
6. Emissão → 200, ou 503 `turn-unavailable` se o provedor falhar.

Nenhum passo de recusa chama a Cloudflare (testado). A chave secreta do Supabase não é usada pela função.

## Variáveis de ambiente (nomes; nenhum valor real foi criado)

**Função `turn` (secrets do Supabase, só com autorização):**

| Variável | Uso |
|---|---|
| `ORYN_TURN_PROVIDER` | `cloudflare` ou `off` (padrão `off`: a função responde `turn-unavailable`, e o cliente segue por STUN) |
| `ORYN_TURN_KEY_ID` | ID da chave TURN (obrigatório com `cloudflare`) |
| `ORYN_TURN_API_TOKEN` | **Segredo**: token da API TURN. Só como secret da função; nunca em `VITE_*`, repositório, log ou terminal compartilhado |
| `ORYN_TURN_TTL_S` | Validade das credenciais, de 1800 a 43200 s (padrão 7200) |

Também usa as variáveis que a plataforma injeta e `ORYN_ALLOWED_ORIGINS`, as mesmas da `signal` (CORS igual, inclusive
`https://tauri.localhost`).

**Cliente (bundle):**
- `VITE_ORYN_ICE_MODE`: modo padrão da build (`auto` quando vazio).
- `VITE_ORYN_STUN_URLS`: STUN do modo `direct` e do fallback.

URLs TURN em `VITE_*` são recusadas. Credencial TURN só chega pela função, temporária.

## Modos ICE

| Modo | Configuração | Sem TURN |
|---|---|---|
| `auto` (operação normal) | STUN + TURN, política `all`: o navegador usa a rota direta quando houver e o relay quando preciso | Segue **só com STUN** e mostra na barra "Retransmissão (TURN) indisponível: entre algumas redes, a voz pode não conectar." O aviso some quando todos os pares conectam. Nunca segue com a lista vazia. |
| `direct` | Só STUN; não chama a função | — |
| `relay` | Só TURN (`turn:` e `turns:`), política `relay` | **Falha fechada**: cada par recebe `turn-unavailable` e nenhuma `RTCPeerConnection` é criada |
| `relay-tls` | Só `turns:` sobre TCP, política `relay` | Falha fechada |

Os modos de teste não têm controle na interface: usa-se `?oryn-ice=<modo>` na URL da web ou `VITE_ORYN_ICE_MODE` numa
build de teste (o desktop não tem barra de endereço). O registro técnico (Diagnóstico) mostra o modo no início da
chamada.

**Evidência por par:** cada mudança do par selecionado vira uma linha no registro, por exemplo
`[Ana] Caminho de mídia: relay (TURN) — relay ↔ srflx · udp · TURN/tls (succeeded)`, e o `MeshCall` expõe o mesmo em
`paths`. Só tipos de candidato e transportes: nunca IP, porta, URL, SDP ou credencial (testado com estatísticas
simuladas que contêm endereços).

## Compartilhamento entre pares

Cada par (`PeerCall`) pede a configuração ao começar a negociar. O `IceShare` da chamada:
- responde a todos com **uma** emissão (pedidos simultâneos esperam a mesma busca). Numa sala de 5, são 1 chamada à
  função por cliente, não 4 (testado na malha com 5 participantes);
- reaproveita a configuração em reconexões e pares novos enquanto ela valer;
- tem prazo de 8 s (menor que os 10 s do `PeerCall`), para o par sempre receber uma resposta.

## Validade e renovação

- **TTL de referência: 2 h.** Mínimo de 30 min e máximo de 12 h. O máximo aceito pela Cloudflare **não foi
  verificado**.
- **Nunca reaproveitar perto do fim:**
  - a função só devolve a credencial guardada se ela ainda valer mais de 10 min;
  - o `IceShare` usa a mesma folga;
  - o `PeerCall` recusa a menos de 5 min;
  - uma credencial que já chega dentro da folga é tratada como falha. Sem isso, o `PeerCall` pediria de novo em ciclo
    (testado).
- **Credencial nova ≠ alocação renovada.**
  - Emitir uma credencial nova não muda uma conexão já estabelecida: ela segue usando a alocação TURN criada com a
    credencial antiga.
  - **[Hipótese, não verificada]** Quando a credencial vence, a alocação deixa de ser renovada no servidor TURN, e um
    par que estiver em relay cai alguns minutos depois. Pares diretos não são afetados.
  - Nesse caso, a recuperação de par que já existe entra em ação: falha de ICE, pedido de reconexão, um `PeerCall` novo,
    que pede configuração, e o `IceShare` busca uma credencial nova, porque a antiga venceu.
  - Resultado esperado: uma interrupção curta, só nos pares em relay, a cada TTL.
- **Por que não reinício de ICE proativo:** trocar a configuração (`setConfiguration`) e reiniciar o ICE antes do fim
  depende do comportamento do provedor, que não pode ser verificado localmente. A solução mínima justificada é a
  recuperação existente com credencial nova. Chamadas de mais de 2 h **não estão homologadas** (teste H6 abaixo). Se a
  interrupção for inaceitável, as opções são TTL maior (até 12 h, com mais exposição em caso de vazamento) ou renovação
  proativa, numa etapa própria.
- **Revogação:** não há. A credencial vale até o fim do TTL (como na POC, a revogação não derruba alocações ativas;
  não verificado).

## Proteção contra abuso e seus limites

Em memória, por instância da função:
- a mesma conta e sessão reaproveitam a credencial válida;
- pedidos simultâneos dela viram uma emissão só;
- no máximo **12 emissões por conta por hora** (cada entrada na voz é uma sessão nova) e **16 emissões em andamento**
  no total.

**Esses limites não são quota global nem controle financeiro.**
- Cada instância da Edge Function começa do zero, e a plataforma pode manter várias.
- Quem tem conta e sessão viva pode obter credenciais até o teto de cada instância.
- A credencial chega ao navegador (inerente ao WebRTC) e vale até o fim do TTL.

O que limita o custo de fato é o orçamento e o alerta de consumo na conta do provedor. Isso será definido antes do
provisionamento. Uma quota durável exigiria estado persistente, isto é, uma migração com decisão própria.

## Sinalização com cinco participantes

Os candidatos de relay somam sinais à negociação. A estimativa por entrada, numa sala de 5, sobe de 16–28 para cerca
de 24–40 sinais, contra a janela de 30 a cada 10 s do cliente. O excedente espera na fila e não se perde, então a
entrada pode demorar alguns segundos a mais. **Hipótese a medir na H5.** Se a entrada atrasar, a primeira medida é
reduzir as URLs TURN entregues (por exemplo, UDP + TLS 443), não aumentar o limite.

## Testes locais (simulados) × evidência real

| Coberto localmente (sem rede, sem Cloudflare, sem Supabase remoto) | Arquivo |
|---|---|
| Provedor: URL, Bearer, TTL e corpo; porta 53 e hosts não documentados removidos; JSON inválido, sem TURN, HTTP de erro, corpo vazio ou grande demais, rede e timeout → falha fechada; token fora do resultado e das mensagens | `tests/turn-function.test.ts` |
| Núcleo: JWT ausente, malformado ou recusado; corpo inválido; sem sessão viva; sessão de outra conta; não membro; banco fora; provedor desligado → nenhuma chamada ao provedor | `tests/turn-function.test.ts` |
| Limites: pedidos simultâneos → 1 emissão; reaproveitamento e renovação; teto por conta e global; logs sem credencial, JWT, URL ou ids | `tests/turn-function.test.ts` |
| HTTP (CORS, OPTIONS, 405, `no-store`), configuração e RPCs com o JWT do usuário (nunca a chave secreta) | `tests/turn-function.test.ts` |
| `IceShare`: 4 pares → 1 busca; `direct` sem função; vencida não reaproveitada; validade curta recusada; `auto` → STUN com aviso único; `relay`/`relay-tls` → falha fechada; prazo; resposta da função validada | `tests/ice-share.test.ts` |
| Malha com 5: 1 busca por cliente; os pares com STUN+TURN e política `all`; `auto` sem TURN conecta por STUN; `relay` sem TURN não cria conexão; reconexão sem nova emissão; caminho por par sem IP; logs sem credencial | `tests/web-mesh.test.ts` |
| Configuração: `auto` padrão, modos válidos, TURN em `VITE_*` recusado, `main.ts` sem `direct` fixo | `tests/web-config.test.ts` |

**Evidência real: nenhuma.**
- A API da Cloudflare nunca foi chamada.
- Não há relay UDP, TURN/TLS ou UDP bloqueado comprovados.
- O gateway do Supabase não exercitou a função.

## Procedimento futuro de provisionamento e publicação (não autorizado)

1. **Decisões do proprietário:**
   - orçamento e alerta de consumo;
   - confirmar o TTL;
   - confirmar `auto` com fallback por STUN;
   - aceitar os limites em memória para o piloto privado.
2. **Proprietário, no painel da Cloudflare:** criar a chave TURN e configurar o alerta de consumo. O ID e o token ficam
   só com o proprietário.
3. **Proprietário:** gravar `ORYN_TURN_PROVIDER=cloudflare`, `ORYN_TURN_KEY_ID`, `ORYN_TURN_API_TOKEN` e, se diferente
   do padrão, `ORYN_TURN_TTL_S` como secrets do projeto Supabase. Não colar os valores em chat, terminal compartilhado
   ou arquivo do repositório.
4. Ativação da função:
   - Hoje `[functions.turn]` tem `enabled = false`. Pela referência de configuração do Supabase, a função é **ignorada
     no deploy** e **não é servida localmente** (`supabase start` / `functions serve`). É a mesma trava que a
     `signal` teve até ser autorizada. A integração GitHub do Supabase não lê esta pasta, então não há deploy
     automático.
   - A trava vale só para a CLI com este `config.toml`. Ela não desativa uma função que já tenha sido publicada por
     outro meio (nenhuma foi).
   - Para ativar, com autorização: trocar para `enabled = true` em commit próprio e rodar, na pasta da POC,
     `supabase functions deploy turn --project-ref <ref> --use-api`, como na `signal`. O `verify_jwt = true`
     continua.
   - Validado localmente sem o Supabase: `deno check` e a partida no Deno 2.1 (a linha do Edge Runtime), com a rede
     restrita ao loopback. Nos modos `off` e `cloudflare`, CORS, 401, 400, 403 e o 503 de falha fechada saíram como
     nos testes, e a chamada ao provedor foi bloqueada pelo runtime. A imagem exata do Edge Runtime (Docker) não foi
     usada.
5. Antes do cliente, conferir a função: sem JWT → 401; com JWT e sem sessão → 403; com sessão viva → 200. Isso usa
   contas controladas e não registra a resposta.
6. Publicar a web e gerar o instalador desktop novo, cada um com autorização.
   - A ordem é segura: com a função ausente ou desligada, o cliente novo segue por STUN, como hoje.
   - Um cliente antigo continua em `direct`.
7. Fazer a homologação real (abaixo).

## Runbook mínimo

**TURN indisponível** (falha do provedor, secret ausente, token recusado):
- **Efeito:** o cliente em `auto` segue só com STUN e mostra o aviso na barra. Pares entre redes comuns continuam;
  redes restritivas podem não conectar. Nenhuma chamada é derrubada por isso.
- **Diagnóstico:** nos logs da função, `outcome: provider-failed` com o motivo curto (por exemplo `HTTP 401`, `tempo
  esgotado`), sem dados sensíveis. No registro técnico do cliente, "TURN indisponível (código)".
- **Ação:** conferir o status do provedor e a validade do token. Se o token foi revogado ou trocado, rotacionar
  (abaixo). Para desligar de propósito: `ORYN_TURN_PROVIDER=off`, e o cliente segue por STUN.

**Rotação do token ou da chave:**
1. Criar o token novo no provedor.
2. Gravar o secret novo no Supabase. A função lê os secrets na partida; confirmar que as instâncias novas usam o valor
   novo (por exemplo, com um redeploy autorizado).
3. Revogar o token antigo no provedor.
4. Conferir um 200 com uma conta controlada.

Credenciais TURN já emitidas valem até o fim do TTL. Trocar o token da API não as invalida.

**Vazamento suspeito do token:** revogar no provedor primeiro (o TURN fica indisponível e o cliente segue por STUN) e
depois rotacionar.

## Plano de homologação real (pendente)

Toda evidência sai do **par selecionado**, nos dois lados, pelo registro técnico ou por `paths`, sem IPs, credenciais
ou SDP.

| # | Cenário | Modo | Aprovação |
|---|---|---|---|
| H1 | Duas redes domésticas | `auto` | Áudio nos dois sentidos; tipo do par registrado (direto ou relay) |
| H2 | Relay UDP forçado | `relay` nos dois lados | Par `relay` com transporte UDP; áudio nos dois sentidos |
| H3 | TURN/TLS | `relay-tls` | Candidato local `relay` com `TURN/tls` no par selecionado |
| H4 | UDP bloqueado por método documentado (por exemplo, regra de firewall de saída no Windows) ou 4G/CGNAT | `auto` | Conecta via relay. Sem método de bloqueio, registrar como limitação, sem declarar "UDP bloqueado" |
| H5 | Sala de 5 (depois da migração 1000) com um participante em `relay` | `auto` | 4 conexões em todos; entrada do quinto medida (meta da §12: p95 ≤ 5 s); perda ≤ 1% |
| H6 | Chamada mais longa que o TTL (ou TTL de teste de 30 min) com um par em relay | `auto` | Duração da interrupção no fim do TTL medida, ou ausência dela. Só então declarar chamadas longas aceitas |
| H7 | Autorização no projeto real | — | Sem JWT → 401; sessão encerrada → 403; o provedor não é chamado (contagem no painel) |
| H8 | Provedor desligado | `auto` e `relay` | `auto` conecta por STUN com o aviso; `relay` falha fechado |
| H9 | Logs da função e do cliente | — | Nenhuma credencial, token, JWT, IP ou SDP |
| H10 | Consumo | — | Bytes de relay no painel comparados à estimativa (pior caso de 5 em relay: cerca de 0,45 GB/h) |

Só depois de H1–H9 aprovados é possível declarar o TURN homologado. O piloto externo depende também da homologação com
5 participantes e das decisões de orçamento.
