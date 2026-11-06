# P05 — Soundboard

**Estado: testes locais executados; homologação em aparelhos reais pendente. A P05 não está aprovada, e a Etapa Macro 5 não está encerrada.**

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
| Isolamento | Membro, estranho, sem login e URL pública recusados no Storage real; quarentena não é lida; removido perde a leitura | Aprovado |
| Simultaneidade | 3 sons disparados: no máximo 2 ativos em cada cliente | Aprovado |
| Pico | 3 disparos de onda em escala cheia: pico de 0,84 depois do limitador, sem estouro | Aprovado no analisador |
| Mistura e voz | Pacotes e energia de voz seguem durante os sons; 1 faixa enviada por conexão; 1 captura de microfone | Aprovado no transporte |
| Volume e desativação | Volume 0 silencia só os sons; desativar não afeta os outros | Aprovado |
| Limpeza de cache | Sai ao remover o som, ao ser removido da sala e ao sair da conta; sem credencial guardada | Aprovado |
| Sessão em espera | A segunda sessão da conta não toca; a principal toca | Aprovado |

**Totais:** roteiro de sons em Chrome, 81 de 81. Regressão no mesmo build: grupo 75 de 75, voz 47 de 47 e chat 58 de 58. Suítes automatizadas: `pnpm test` com 1201 aprovados, 18 `todo` e 0 reprovados (24 deles, do script de publicação, num clone descartável, porque o script exige `supabase/` sem mudanças); `pnpm test:pg` com 55 de 55.

## 3. Latência medida

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
- **Produção:** Storage com a chave do servidor, cota do plano e rede real ainda não foram exercitados.
- **WebView2 e Safari:** sem evidência.

## 5. Roteiro em aparelhos reais

**Pré-requisitos:** Etapa 7 do checklist concluída e cliente publicado, cada passo com autorização própria. Pelo menos 2 aparelhos, de preferência 3, em redes diferentes. Um MP3 e um WAV reais, curtos. Não registrar dados de conta nas evidências.

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

**Depois:** rodar `15_sound_orphans.sql` e os advisors, e registrar consumo de Storage. Registrar aqui data, commit, aparelhos, versões, resultados e limitações.

## 6. Decisão

**Pendente.** Só depois do roteiro acima é possível decidir o gate da Etapa 5: "P05 e quotas comprovadas".
