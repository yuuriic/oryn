# Capacidade-alvo de oito participantes: avaliação técnica

**Estado em 2026-11-07: em avaliação. O limite em vigor continua em 4 contas por sala.** Nenhuma migração, função, política, contrato ou configuração de produção foi alterada. Investigação feita na branch `feat/midnight-ui` (`e82b3d6`), só por leitura do código e da documentação.

## 1. Recomendação

**Não liberar oito participantes com a arquitetura atual sem antes executar a P02 e a P07 em 6 e 8.**

- **Bloqueio de código:** o limite de 4 está em 3 lugares (seção 2). Subir só o banco não basta: o cliente se conecta a no máximo 3 pares e fica em malha parcial, sem erro visível.
- **Bloqueio de evidência:** não há teste com 5 ou mais pessoas, nem TURN provisionado. A ARCHITECTURE.md (§2.2) diz que 4 é um envelope de teste, não capacidade comprovada.
- **Risco medido no código:** com 8 pessoas, quem entra precisa negociar com 7 pares, mas o cliente envia no máximo 30 sinais a cada 10 s. Pela estimativa da seção 4, a entrada levaria de 10 a 20 s. A meta é p95 ≤ 5 s.
- **Viabilidade:** para voz em desktop, o mesh de 8 é **plausível, mas não comprovado**. Pela estimativa, a banda cabe no envelope nominal. CPU com jogo aberto, celulares, redes restritivas sem TURN e a sinalização são as incertezas.
- **Caminho sugerido:** P02 na stack local com 6 e 8 contas, numa branch descartável. Depois, aparelhos reais em redes diferentes e TURN. Decidir entre **4, 6 ou 8** com os números na mão. Se 8 falhar nos critérios, abrir o ADR de SFU (§9.3).

## 2. Onde o limite de 4 está definido

| Camada | Local | Regra |
|---|---|---|
| Banco, tabela | `20261023000100_oryn_schema.sql:38` | `check (max_members between 2 and 10)`. Não é o limite real |
| Banco, `create_room` | `20261023000200_oryn_functions.sql:152` | Aceita de 2 a 10 |
| **Banco, gatilho** | `20261107000600_oryn_room_membership.sql:31-41` | `oryn.enforce_room_capacity`: sala **nova** acima de 4 recebe `invalid-argument`. Só em `INSERT`, então as salas antigas não são afetadas. **É o limite efetivo** |
| **Cliente, criação** | `src/web/rooms.ts:12` e `index.html` (`#create-capacity`) | `ROOM_CAPACITIES = [2, 3, 4]` e `isRoomCapacity` recusa o resto antes da RPC |
| **Cliente, voz** | `src/web/mesh-signaling.ts:26` | `MAX_MESH_PEERS = 3`: com mais contas na sala, o cliente negocia só com as 3 primeiras |
| Cliente, fila | `src/web/mesh-signaling.ts:28` | `MESH_MAX_QUEUE = 192`, calculada para 3 pares |
| Edge Function `signal` | `supabase/functions/` | Não conhece capacidade. Encaminha, e o banco autoriza |
| Testes | `tests/sql-room-membership.test.ts:43,62`, `tests/web-mesh.test.ts:166` | Aceitam 2, 3 e 4 e recusam 5 e 10. Fixam `MAX_MESH_PEERS = 3` |

## 3. Criação, entrada, admissão, concorrência e autorização

- **Criação:** a concessão de criador fica travada `FOR UPDATE`, depois vêm a validação de 2 a 10 e o gatilho de 4.
- **Convite:** `create_room_invite` trava a sala, recusa com `room-full` quando ela está cheia e permite até 3 convites pendentes. Para chegar a 8, o dono emite pelo menos 3 rodadas de convites. Funciona, mas é atrito.
- **Admissão:** `redeem_room_invite` trava o convite e depois a sala (`FOR NO KEY UPDATE`) e conta os membros ativos. A contagem é exata sob concorrência, para qualquer N. Já existe teste de corrida (`10_concurrency_redeem.sql`, `room-membership.pg`).
- **Entrada na voz:** `join_room` aceita até 2 sessões vivas por conta. Com 8 contas, são até **16 sessões**. Só a mais antiga de cada conta entra no mesh.
- **Autorização:** `is_active_member`, os tópicos privados `oryn:s:{sessão}` e `authorize_signal` não dependem de N. Nenhuma regra de autorização precisa mudar para 8.
- **Fan-out:** `publish_control` faz um `realtime.send` por sessão viva. Isso vale para `hello` e para os sons. Com 8 contas e o cooldown de 2 s por conta, são até 4 disparos/s × 15 sessões ≈ **60 mensagens Realtime/s por sala**. A justificativa "sem teto extra por sala" (runbook §14.14) foi escrita para 4 contas. **Conferir a cota do plano.**
- **Limite de taxa da sinalização:** no banco, 40 sinais por sessão em 10 s, contando todos os destinos (`authorize_signal`). No cliente, 30 em 10 s, numa fila única para todos os pares (`supabase-signaling.ts:281`).

## 4. Mesh WebRTC com 8 participantes

| N | Conexões no grupo | Envios por cliente | Uplink estimado por cliente* |
|---|---|---|---|
| 2 | 1 | 1 | ~50 kbit/s |
| 4 | 6 | 3 | ~150 kbit/s |
| 6 | 15 | 5 | ~250 kbit/s |
| 8 | 28 | 7 | ~350 kbit/s, e o mesmo na descida |

\* Estimativa, não medição: Opus a ~32 kbit/s mais cerca de 20 kbit/s de cabeçalhos RTP, UDP, IP e SRTP, a 50 pacotes/s. Cabe nos 5 Mbit/s nominais da §12, mas não foi medida com jogo aberto.

- **CPU:** cada `RTCPeerConnection` tem seu codificador e sua pilha DTLS/SRTP. Com 8, são 7 codificações e 7 decodificações Opus por cliente. Isso é barato em desktop, mas não foi medido. A meta da §12 (≤ 10% de CPU) foi definida para chamadas de 4. Para celular, não há medição nenhuma.
- **Sinalização na entrada:** cada candidato ICE vai em uma mensagem, sem agrupamento (`call.ts:456`). Por par, o recém-chegado envia oferta ou resposta, de 3 a 6 candidatos e o fim da coleta: de 5 a 8 sinais. Para 7 pares, são de **35 a 56 sinais**. Com a fila limitada a 30 a cada 10 s, a entrada leva **de 10 a 20 s**. Estimativa a confirmar na P02.
- **Conectividade sem TURN:** são 28 caminhos diretos, e cada um pode falhar sozinho. Em rede restritiva, mais pessoas ficam "sem conexão" com parte do grupo. O `ice.ts` já aceita os modos de relay, mas nenhum TURN foi provisionado (`NET-01-NET-02.md`: "não há TURN nesta versão").
- **Compatibilidade de clientes:** um cliente antigo em cache, com `MAX_MESH_PEERS = 3`, numa sala de 8 ouve só 3 pessoas, sem erro. O cliente novo precisa estar no ar antes de o banco aceitar mais de 4, e é preciso decidir como tratar abas antigas.
- **Interface:** participantes, chamada e membros foram validados com até 4 pessoas. Com 7 cartões, a grade quebra em linhas. Falta conferir em 360 px.

## 5. Evidências existentes

| N | Evidência | Natureza |
|---|---|---|
| 2 | NET-01 manual positivo em produção; validação A/B do MVP-01; sons com 2 participantes (P05) | Aparelhos reais, sem métricas de CPU, latência ou perda |
| 3–4 | Chrome com microfone falso, stack local e uma máquina: 4 contas com 75 de 75, áudio medido em cada conexão (2026-11-06; reexecutado na Midnight, 75 de 75) | Prova o transporte, não a qualidade nem a rede |
| 3–4 | Roteiro de 12 passos em aparelhos reais (runbook §14.13) | **Resultados não registrados** |
| 2–4 | SQL: capacidades 2, 3 e 4 aceitas e 5 e 10 recusadas; corrida no resgate do convite | Testes automatizados |
| 6 | Nenhuma | — |
| 8 | Nenhuma | — |
| — | P02 e P07 | **Não executadas** (§14: "todas não executadas") |

## 6. Lacunas e validações mínimas para liberar 8

**Pré-requisitos de código (mudança de contrato, cada um com autorização própria):**
1. Nova migração aditiva com `create or replace` de `oryn.enforce_room_capacity` para o novo teto, com rollback, pós-voo e baseline S2 novos.
2. Cliente: `ROOM_CAPACITIES`, `MAX_MESH_PEERS = N−1`, `MESH_MAX_QUEUE` proporcional e o orçamento de sinalização. Opções: agrupar candidatos, que muda o protocolo, ou rever os limites de 30 e 40 em 10 s, que muda o banco.
3. Ordem: cliente publicado antes do banco, e uma estratégia para clientes antigos.

**Validações mínimas, em ordem, com relatório no formato da §14:**
1. **Local, com 6 e depois 8 contas** (Chrome com microfone falso): todas as 15 ou 28 conexões com áudio; tempo de entrada do último a chegar; número de `429`/`rate-limited`; saída e retorno sem derrubar os demais.
2. **Aparelhos reais, com 6 e depois 8**, em pelo menos 3 redes diferentes, inclusive 4G/CGNAT, por 15 min ou mais. Por par, via `getStats`: RTT, perda, jitter e bitrate. Por cliente: CPU, memória e uplink. Tudo com jogo aberto, no baseline da §12 (4 núcleos e 8 GiB).
3. **Boca-ouvido:** amostra externa, com p95 ≤ 200 ms.
4. **TURN:** provisionar e testar com UDP bloqueado e no modo `relay-tls`. Medir o volume retransmitido para o custo (P07).
5. **Backend durante 8 entradas simultâneas:** mensagens Realtime por segundo, invocações da `signal`, crescimento de `signal_log` e comparação com as cotas do plano Supabase (P07).
6. **Critério de decisão:** entrada p95 ≤ 5 s, reconexão p95 ≤ 10 s, perda ≤ 1% no cenário nominal e CPU dentro da meta a definir para 8. Se falhar, ficar em 4 ou 6 e abrir o ADR de SFU.
