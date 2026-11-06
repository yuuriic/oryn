# NET-01 e NET-02 — Validação: chamada real entre redes e continuidade

| Campo | Valor |
|---|---|
| Data do registro | 06/11/2026 |
| Commit de referência | `f7bae53` (`main`, PR #15), publicado em produção |
| Código | `poc/webrtc-audio-supabase/` |
| Ambiente | Produção; Chrome no Windows e Safari no iPhone, em redes distintas |
| Status de NET-01 | **Validação funcional manual: positiva. Homologação técnica integral: pendente** (§6) |
| Status de NET-02 | **Validação funcional manual: positiva nos itens testados. Homologação técnica integral: pendente** (§6) |

Os testes manuais desta versão não registraram falha. A pendência é de medição e de cenários ainda não executados.

**NET-01:** chamada real entre redes diferentes, com saída e reentrada.
**NET-02:** continuidade da chamada: bloqueio do aparelho, segundo plano, troca de rede e duração.

Legenda:
- **[Observação manual]:** relato de quem fez o teste, com os aparelhos reais. O servidor não registra mídia, então voz e mudo
  só têm esta fonte.
- **[Registro técnico]:** lido nos registros do servidor e do banco, sem conteúdo de sinalização.
- **[Hipótese]:** explicação possível, ainda não verificada.
- **[Não comprovado]:** sem evidência suficiente, seja qual for a percepção no teste.

## 1. Chamada de referência

Em 06/11/2026, das 14:22 às 14:36 UTC, sobre o commit de referência. É a única chamada registrada nesta versão.

| Item | Observação manual | Registro técnico |
|---|---|---|
| Redes diferentes | Dois participantes em redes distintas | Endereços públicos e provedores diferentes entre as pontas |
| Áudio nos dois sentidos | Funcionando | Sem registro de mídia no servidor |
| Mudo e retorno do mudo | Funcionando | Sem registro de mídia no servidor |
| iPhone bloqueado | Áudio de entrada e saída mantido | Batimentos a cada 30 s, sem lacuna, sem marca do momento do bloqueio |
| Saída e reentrada | Funcionando | Saída confirmada; nova sessão 4 s depois; nova oferta e resposta |
| Duração | Pelo menos 15 min, **relato manual** | Tempos de sessão separados, em §2 |
| Troca 5G → Wi-Fi → 5G | **Teste manual bem-sucedido**, sem interrupção perceptível | Ver §3 |

Durante toda a chamada: duas ofertas e duas respostas, uma para cada entrada do par; nenhum pedido de reinício de ICE; as sessões
terminaram por saída explícita, sem expiração.

## 2. Duração

**[Observação manual]** Relato de chamada contínua de pelo menos 15 minutos, sem falhas perceptíveis.

**[Registro técnico]** Tempos de sessão no servidor, independentes do relato. O maior deles fica abaixo de 15 minutos:
- sessão do participante no Windows: cerca de 14 min 10 s;
- sessões do participante no iPhone: cerca de 3 min 45 s e, depois da reentrada, cerca de 10 min 5 s;
- maior trecho contínuo do par na mesma sessão: cerca de 10 min 5 s.

**[Não comprovado]** Duração contínua de mídia: nenhum registro a mede. Sessão no servidor não equivale a conexão nem a áudio.

## 3. Troca de rede

**[Observação manual]** Alternância 5G → Wi-Fi → 5G no iPhone, sem interrupção perceptível. O teste manual foi bem-sucedido.

**[Registro técnico]** Durante a chamada:
- todas as requisições HTTP do iPhone vieram do mesmo endereço público;
- não houve pedido de reinício de ICE;
- não houve candidato novo depois da reentrada.

**[Não comprovado]** Migração do caminho WebRTC. Os registros não mostram qual par de candidatos estava em uso, nem se ele mudou.

**[Hipótese]** Explicações compatíveis com o que se vê, sem distinção possível hoje:
- o iOS manteve no 5G as conexões já abertas, e a mídia não trocou de caminho;
- a mídia trocou de caminho por um mecanismo que não passa pela sinalização, com o HTTP mantido na conexão anterior;
- a troca ocorreu num trecho sem requisição HTTP.

## 4. Antes desta versão

**[Registro técnico]** Na primeira chamada real, em 05/11/2026, sobre `869a15a`, o Safari do iPhone manteve duas sessões vivas da mesma
conta, que terminaram sem `leave_room`. A reentrada ficou recusada por limite de sessões até elas expirarem, cerca de 95 s depois do
último batimento. A causa exata da saída ausente não foi isolada. A correção está no PR #13 (runbook §14.10).

**[Não comprovado]** Essa correção no iPhone real. A saída da chamada de referência foi explícita, então estes casos seguem abertos:
recarregar em chamada, fechar a aba, encerrar o Safari e abrir uma segunda aba.

## 5. Validação só local

Sem rede real, com microfone falso e Chrome na mesma máquina. Prova a lógica e o transporte, não NAT, Safari ou qualidade de voz.

- **Testes do repositório, na preparação do PR #15:** `pnpm test` com 811 aprovados e 18 `todo`. O `pnpm test:pg`, com 31 aprovados, foi
  executado por último na preparação do PR #13. Nenhuma suíte foi repetida neste registro.
- **Roteiros em navegador real, na preparação do PR #13:** saída, retorno, F5, queda abrupta, rede interrompida e uma segunda aba, com
  áudio medido por `getStats` nos dois sentidos depois de cada retorno. Esses roteiros não estão versionados.

## 6. Critérios

"Observação manual positiva" é validação funcional. "Não medido", "Não executado", "Sem relato de teste" e "Só local" indicam homologação técnica pendente, não
falha. Os critérios de NET-01 vêm do plano aprovado; os de NET-02 são os itens da sua definição.

### NET-01

| Critério | Situação |
|---|---|
| Áudio nos dois sentidos | Observação manual positiva |
| Saída e reentrada com áudio | Observação manual positiva; sinalização registrada |
| 120 s contínuos | Registro de sessão acima disso; mídia sem medição |
| Conexão em até 15 s | Não medido |
| Caminho sem relay | Não medido; não há TURN nesta versão |
| Perda até 2%, jitter P95 até 30 ms, RTT P95 até 300 ms, ocultação até 2% | Não medido |
| Recuperação de queda de rede em até 25 s | Só local |
| Chamada de cerca de 65 min, com renovação de token | Não executado |
| Casos de sessão abandonada no iPhone (§4) | Não executado |

### NET-02

| Item | Situação |
|---|---|
| iPhone bloqueado | Observação manual positiva; sem marca do momento do bloqueio nos registros |
| Safari em segundo plano | Sem relato de teste |
| Troca 5G → Wi-Fi → 5G | Observação manual positiva; migração do caminho não comprovada |
| Duração | Relato manual de pelo menos 15 min; tempos registrados em §2; mídia sem medição |

## 7. Comportamentos críticos

Lista no runbook, §14.11. Toda alteração futura precisa preservá-los.

## 8. Próxima etapa: observabilidade (não implementada)

**Objetivo:** responder ao que está como não comprovado em §2 e §3, sem enviar dados para fora do navegador.

**Requisitos:**
- separar **duração de sessão, duração de conexão e duração de mídia**;
- usar **identificadores efêmeros**, válidos só naquela chamada, para detectar mudanças do par ICE, sem endereço, porta ou candidato;
- registrar eventos de visibilidade e de ciclo de vida da página **só para observação**: a instrumentação não encerra nem altera a
  chamada;
- manter os relatórios **locais, limitados e sem informações sensíveis**: sem IP, SDP, candidato, token ou e-mail, sem envio
  automático e sem persistência;
- não mudar a lógica de ICE nem o fluxo da chamada.

**Requisito de continuidade:** bloquear a tela ou colocar o Safari em segundo plano não pode, por si só, encerrar uma chamada ativa. O
tratamento seguro de sessões abandonadas continua possível. Esta etapa não introduz comportamento novo.

**[Não comprovado]** Que o Safari no iPhone, em segundo plano, não acione um dos caminhos de encerramento que já existem: a saída no
`pagehide`, feita para fechar ou recarregar a aba, e a expiração no servidor depois de 90 s sem batimento. O bloqueio da tela teve observação
manual positiva; o segundo plano não tem relato de teste.

Depois disso, um reteste curto em rede real deve cobrir, com hora anotada: 15 minutos contínuos, troca de rede, bloqueio do aparelho, Safari
em segundo plano e os casos de §4.
