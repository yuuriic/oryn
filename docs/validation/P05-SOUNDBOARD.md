# P05 — Soundboard

**Estado: testes locais e teste controlado de Storage em produção executados; homologação em aparelhos reais pendente. A P05 não está aprovada, e a Etapa Macro 5 não está encerrada.**

Critério da arquitetura (`ARCHITECTURE.md`, §14): sem duplicação ou reprodução fora do prazo, com latência medida. Meta da §12: clique até a reprodução remota em cache, p95 ≤ 300 ms. **Essa meta não foi comprovada.**

## 1. Ambiente

| Item | Valor |
|---|---|
| Data | 2026-11-06 |
| Código | Branch local a partir de `c478b69`, com migração `20261108000700` e função `sound-media` |
| Backend | Stack local descartável do Supabase, com Postgres, Realtime, Storage e Edge Functions reais, sem ligação com o projeto remoto |
| Cliente | Build de produção em Chrome real, sem interface gráfica, 3 a 4 processos na mesma máquina Windows |
| Áudio | Microfone falso do Chrome; saída medida por analisador Web Audio depois do limitador |
| Sons | WAV senoidal gerado pelo roteiro e MP3 sintético de silêncio |

Os roteiros de navegador não estão versionados e não rodam no CI.

## 2. Resultados automatizados

| Caso da P05 | Evidência | Resultado |
|---|---|---|
| Cache frio e quente | Reentrada sem nenhum download; som fora do cache baixado e tocado dentro do prazo | Aprovado |
| Evento duplicado | Mesmo `event_id` enviado duas vezes pelo Realtime real toca uma vez | Aprovado |
| Evento atrasado | Evento emitido há 5 s não toca | Aprovado |
| Relógio divergente | Com ±25 s no navegador, evento novo toca e evento de 4 s atrás não toca. Com ±1 h, em teste sem navegador | Aprovado |
| Arquivo inválido | HTML com MIME falso sobe, é recusado pela função e apagado; acima de 2 MiB e outro MIME são recusados pelo bucket | Aprovado |
| Quotas | 40 reservas simultâneas em PostgreSQL 17: exatamente 20 passam | Aprovado |
| Cooldown | 20 disparos simultâneos em PostgreSQL 17: 1 passa e sai 1 evento | Aprovado |
| Isolamento | Membro, estranho, sem login e URL pública recusados no Storage real; quarentena não é lida; removido perde a leitura. Na stack local, sem CDN: em produção, ver "Contrato de remoção" | Aprovado |
| Simultaneidade | 3 sons disparados: no máximo 2 ativos em cada cliente | Aprovado |
| Pico | 3 disparos de onda em escala cheia: pico de 0,84 depois do limitador, sem estouro | Aprovado no analisador |
| Mistura e voz | Pacotes e energia de voz seguem durante os sons; 1 faixa enviada por conexão; 1 captura de microfone | Aprovado no transporte |
| Volume e desativação | Volume 0 silencia só os sons; desativar não afeta os outros | Aprovado |
| Limpeza de cache | Sai ao remover o som, ao ser removido da sala e ao sair da conta; sem credencial guardada | Aprovado |
| Sessão em espera | A segunda sessão da conta não toca; a principal toca | Aprovado |

**Totais:** roteiro de sons em Chrome, 81 de 81. Regressão no mesmo build: grupo 75 de 75, voz 47 de 47 e chat 58 de 58. Suítes automatizadas: `pnpm test` com 1204 aprovados, 18 `todo` e 0 reprovados; `pnpm test:pg` com 55 de 55.

## 3. Teste controlado de Storage em produção

Executado em 2026-11-07, às 01:18 UTC, com autorização específica, numa sala sem sons e sem sessões vivas. Um ciclo, sem repetição. **Resultado: 23 aprovados e 1 reprovado (C2).**

| Verificação | Resultado |
|---|---|
| Chave `sb_secret_` só no `apikey`: leitura e exclusão no Storage pela função | **Aprovado** |
| WAV válido: 200, `available`, hash igual ao local, dono lê bytes idênticos | Aprovado |
| Sem login e URL pública, com o corpo já em cache | Recusados, 400 |
| HTML com MIME de áudio: passa pelo bucket, a função recusa (422), objeto apagado | Aprovado |
| Remoção e limpeza pela função; nada pendente; sons anteriores iguais | Aprovado |
| Estado final | 0 objetos; 1 linha `deleted` e 1 `rejected`, permanentes e fora do catálogo |
| Logs de função e Storage | Sem credencial, e-mail ou nome de som |
| **C2: som removido deixa de ser lido na hora** | **Reprovado: a expectativa estava errada** (abaixo) |

**Causa de C2, comprovada nos logs:** a remoção foi gravada no banco 118 ms antes da leitura. A leitura voltou com `cf_cache_status: HIT`, o corpo completo, 44 ms de origem e nenhum registro no Storage. Ou seja, o Smart CDN respondeu sem consultar o Storage, para o mesmo JWT que já havia lido o arquivo. A política está correta, e a stack local não tem CDN, por isso o ensaio não mostrou isso. A documentação do Supabase informa até 60 s para invalidar o cache depois de uma exclusão.

**O que este teste não cobre:** chamada, `trigger_sound`, reprodução e os 4 casos dos passos 19 a 22 do roteiro.

### Contrato de remoção

Decisão do arquiteto, com base no diagnóstico de C2:

| Momento | Garantia |
|---|---|
| **Na hora, pelo banco** | Remoção lógica; saída do catálogo; recusa de novos disparos (`trigger_sound` exige `available`); nova autorização de leitura no Storage negada |
| **Em seguida, pela função** | Exclusão física do objeto, normalmente em cerca de 1 s no fluxo do dono |
| **Por uma janela, no CDN** | Uma leitura já autorizada para aquela credencial pode continuar sendo respondida. Duração medida nos passos 21 e 22 |
| **Sem garantia** | Bytes já entregues, em cache de aparelho ou de navegador, não podem ser revogados num aparelho hostil. O cliente legítimo limpa o próprio cache |

**Não há promessa de revogação instantânea de bytes.** O comentário da migração `0700`, que diz "deixa de ser lido na hora", vale para a autorização no banco. A migração já está aplicada e não foi alterada. Este contrato prevalece.

## 3A. Advisors depois da 0700

| Advisor | Nível | Medido | Classificação | Ação |
|---|---|---:|---|---|
| `0029` SECURITY DEFINER executável | WARN | 26 | Por desenho: as RPCs são o único acesso, com a verificação no corpo. As 7 novas são as previstas | Nenhuma |
| `0008` RLS sem política | INFO | 12 | Por desenho: tabelas sem acesso direto. As 2 novas seguem a regra | Nenhuma |
| `0001` chave estrangeira sem índice | INFO | 9 | Impacto baixo: `sound_assets.owner_id` e `sound_trigger_state.user_id` só pesam ao excluir conta, com poucas linhas | Rever se o volume crescer |
| `0005` índice não usado | INFO | 1 | Esperado em tabela nova: `sound_assets_room_state_idx` atende catálogo e quota | Rever depois de haver uso |

Nenhum é bloqueador. Regressão seria nível ERROR, função só de `service_role` no `0029` ou tabela com acesso direto.

## 3B. Latência medida

Medição **local**: do clique até `AudioBufferSourceNode.start()`, com 3 contas em voz, na mesma máquina.

| Caminho | n | p50 | p95 | Máximo |
|---|---|---:|---:|---:|
| Remoto, cache quente | 60 | 11 ms | 21 ms | 24 ms |
| Emissor, cache quente | 30 | 12 ms | 22 ms | não registrado |
| Remoto, cache frio | 1 por execução | 267 a 309 ms | não calculado | não calculado |

**O que isso não prova:** não há internet entre cliente e Supabase; a saída de áudio do sistema não entra na conta; e os relógios são da mesma máquina. Sem esses fatores, **este número não atende nem reprova a meta de 300 ms**. Serve só para mostrar que o código não acrescenta atraso relevante.

A sonda de conferência mediu de 5 a 10 ms de ida e volta até a stack local, e diferença de até 90 ms entre os relógios do Docker e do Windows.

## 4. Limites

- **Sem aparelho real:** eco, ruído, percepção de volume, Bluetooth e CPU com jogo aberto não têm evidência.
- **Áudio real:** o microfone é falso, e o analisador prova sinal, não qualidade.
- **MP3 real:** não havia MP3 de codificador real na máquina. O validador foi exercitado com quadros sintéticos.
- **WAV real:** 225 arquivos da máquina passaram pelo validador, sem publicar. 211 aceitos; recusados 2 acima de 10 s e 10 de 6 ou 8 canais, conforme a regra; 2 acima de 2 MiB nem foram lidos.
- **Autoplay:** o navegador de teste libera o áudio sem gesto. O aviso de bloqueio só foi exercitado sem navegador.
- **Produção:** Storage com a chave do servidor foi exercitado no teste controlado. Cota do plano e rede real, ainda não.
- **WebView2 e Safari:** sem evidência.

## 5. Roteiro em aparelhos reais

**Pré-requisitos:** Etapa 7 do checklist concluída e cliente publicado, cada passo com autorização própria. Os passos 19 a 22 usam uma terceira conta, autenticada e fora da sala, e leitura direta do objeto com o JWT da própria sessão, sem registrar o token. Pelo menos 2 aparelhos, de preferência 3, em redes diferentes. Um MP3 e um WAV reais, curtos. Não registrar dados de conta nas evidências.

| # | Passo | Aprovado se |
|---|---|---|
| 1 | Dono publica um MP3 real e um WAV real | Os dois aparecem para todos em até 15 s |
| 2 | Dono tenta um arquivo acima de 10 s, um acima de 2 MiB e um `.txt` renomeado para `.mp3` | Os três são recusados, com motivo claro |
| 3 | Membro abre o painel | Vê e toca os sons; não vê publicar nem remover |
| 4 | Cada pessoa toca um som, um de cada vez | Todos ouvem, **uma vez**, inclusive quem tocou |
| 5 | Latência: filmar dois aparelhos e o clique com um terceiro, 20 vezes | Registrar p50 e p95 do clique ao som. **É esta a medida da meta de 300 ms** |
| 6 | Dois cliques rápidos | O segundo só vale depois de 2 s |
| 7 | Três pessoas tocam ao mesmo tempo | No máximo 2 sons em cada aparelho, sem distorção forte |
| 8 | Ajustar o volume dos sons durante uma conversa | Só os sons mudam; a voz, não |
| 9 | Desativar sons num aparelho | Só ele deixa de ouvir, e a preferência fica depois de recarregar |
| 10 | Durante 5 minutos, conversar e tocar sons | Voz sem cortes; observar eco com fone e com alto-falante |
| 11 | Sair da chamada, voltar | Toca sem novo download; nenhum som antigo toca sozinho |
| 12 | Modo avião por 10 s durante um disparo alheio | Ao voltar, o som atrasado não toca |
| 13 | Aparelho com a hora errada, manual, em alguns minutos | Sons continuam tocando no tempo certo |
| 14 | Mesma conta em dois aparelhos | Só o que está na chamada toca |
| 15 | Dono remove um som | Some para todos em até 15 s, e o botão deixa de tocar |
| 16 | Dono remove um membro durante a chamada | Ele cai e não ouve os sons seguintes; os outros seguem |
| 17 | Página recém-aberta, sem clicar em nada, recebendo um som | Sem som, com aviso claro; depois de um clique, volta a tocar |
| 18 | iPhone com Safari, se disponível | Registrar o comportamento, inclusive em segundo plano. Fora da primeira matriz da arquitetura |
| 19 | **Conta fora da sala:** um membro baixa um som, para aquecer o cache. Na mesma região, a conta de fora tenta ler o objeto | **Sempre recusada, sem nenhum byte.** Qualquer leitura é falha de segurança: interromper |
| 20 | **Membro removido:** o membro baixa um som; o dono o remove da sala, sem remover o som. Ler com o mesmo JWT a cada 5 s, por até 5 min | O painel fecha e novos disparos são recusados na hora. Registrar quanto tempo a leitura direta persiste. **Até 2 min: aceito. Acima disso: decisão do arquiteto** |
| 21 | **Convergência da remoção:** o dono baixa um som e o remove. Ler com o mesmo JWT a cada 5 s, registrando os horários | Sai do catálogo na hora. Registrar o tempo até a primeira recusa e a hora da exclusão física |
| 22 | **Depois da exclusão física:** continuar o passo 21 e seguir lendo por mais 5 min, com um JWT novo incluído | Recusado em **até 2 min** depois da exclusão física e assim permanece. Persistir além disso reprova o passo |

**Janela de 2 min:** os 60 s documentados pelo Supabase, com margem. É uma proposta a confirmar pelo arquiteto com os valores medidos.

**Depois:** rodar `15_sound_orphans.sql` e os advisors, e registrar consumo de Storage. Registrar aqui data, commit, aparelhos, versões, resultados e limitações.

## 6. Decisão

**Pendente.** Só depois do roteiro acima é possível decidir o gate da Etapa 5: "P05 e quotas comprovadas".
