# Oryn — Arquitetura técnica

> **Stay close. Play on.**  
> Identidade: **Midnight**, minimalista, premium e sofisticada.  
> Versão: 0.1 — proposta para revisão. Data: 21 de outubro de 2026.

## 1. Status e finalidade

Este documento propõe a arquitetura do Oryn, um aplicativo privado de comunicação para pessoas que jogam juntas. Define limites do sistema, responsabilidades, contratos, dados, segurança e etapas de implementação.

**Nenhuma POC, teste de desempenho, teste de segurança, integração, instalação ou implantação foi executada para produzir este documento.** As metas são critérios propostos, e não resultados observados. Consulta documental não comprova compatibilidade prática.

São requisitos fornecidos: Windows com Tauri 2/WebView2; web com Vue 3/Vite; Supabase Auth, Postgres, RLS, Realtime e Storage; Vercel; voz WebRTC/Opus com P2P inicial e TURN; avaliação posterior de SFU; soundboard por eventos e cache; marca Oryn/Midnight. As demais escolhas abaixo são propostas reversíveis, sujeitas aos gates do roadmap.

O histórico recuperado confirma nome, slogan e direção visual, mas não disponibiliza o conteúdo das respostas técnicas anteriores. Não se atribuem a esse histórico decisões ou validações adicionais.

## 2. Produto, escopo e premissas

### 2.1 Experiência central

Entrar em um espaço privado, encontrar amigos, conversar por texto e voz e compartilhar sons durante uma partida, com pouca interferência no jogo. A unidade de isolamento será o **espaço** (`space`): comunidade privada com membros, canais e biblioteca de sons.

MVP proposto:

- Conta autenticada, perfil mínimo e entrada por convite.
- Espaços privados com papéis `owner`, `admin` e `member`.
- Canais de texto e voz; todos os membros do espaço acessam seus canais no MVP.
- Mensagens persistentes, histórico paginado e estado de envio explícito.
- Uma sala de voz ativa por usuário, com mute, deafen, volume por participante e seleção de dispositivos quando suportada.
- Soundboard do espaço, volume independente, bloqueio local e cooldown.
- Desktop com bandeja e atalhos globais sujeitos à POC; web com atalhos apenas quando a página puder recebê-los.

Fora do MVP: comunidades públicas, descoberta global, vídeo, compartilhamento de tela, streaming, bots, plugins de terceiros, gravação, transcrição, mobile nativo, overlay sobre jogos e matriz complexa de permissões por canal. Mensagens diretas e amizade independente de espaços ficam para outra decisão de produto.

### 2.2 Limites iniciais propostos

Piloto com até 100 contas, 30 usuários simultâneos e salas de até **4 participantes**. Isso é um envelope de teste, não capacidade comprovada. Testar 2/4/6/8 participantes para determinar o limite real. Cadastro autenticado não concede automaticamente acesso a qualquer espaço.

Windows 11 x64 é a plataforma inicial proposta. Windows 10, ARM64 e outros sistemas dependem de decisão de suporte e testes próprios. Web: versões estáveis recentes de Edge e Chrome na primeira matriz; Firefox e Safari dependem de homologação. Não assumir que recursos desktop e web terão paridade completa.

### 2.3 Midnight na implementação

Centralizar tokens semânticos de superfícies escuras azuladas, texto, bordas, destaque e estados em `packages/ui`. Valores hexadecimais, fonte e logotipo permanecem decisões de design; não são inventados como ativos aprovados.

Priorizar legibilidade, foco visível, navegação por teclado, estados identificáveis sem cor e redução de movimento. Controles de áudio devem permanecer acessíveis durante reconexão. O slogan é assinatura de marca, sem ocupar continuamente a área funcional. Contraste e acessibilidade precisam de avaliação real.

## 3. Estratégia arquitetural

Adotar **monólito modular no código**, backend gerenciado e separação explícita entre três planos:

| Plano | Conteúdo | Transporte e autoridade |
|---|---|---|
| Persistência | Espaços, membros, canais, mensagens, catálogo | HTTPS/Data API/RPC; Postgres e RLS |
| Controle | Presença, admissão em voz, sinalização, eventos de som | HTTPS para comandos; Realtime privado para notificações |
| Mídia | Voz em tempo real | WebRTC entre pares, direto ou via TURN |

Supabase Realtime não transporta o áudio da chamada. Vercel hospeda a aplicação web estática; não recebe responsabilidade por TURN, SFU ou um servidor de mídia persistente. Funções de negócio com segredos ficam inicialmente em Supabase Edge Functions e RPCs transacionais. Evitar duplicar o mesmo backend em Vercel Functions.

O desktop empacota os próprios assets Vue; não carrega a aplicação remota de produção dentro de uma janela com privilégios nativos. Versões web e desktop compartilham código, mas podem ser publicadas em ritmos distintos.

## 4. Visão C4 textual

### C1 — Contexto

- **Jogador:** autentica, aceita convites, envia mensagens e participa de voz/soundboard.
- **Administrador do espaço:** gerencia convites, membros, canais e sons dentro de seu espaço.
- **Operador do Oryn:** mantém ambientes, releases, segredos, recuperação e observabilidade.
- **Oryn:** oferece comunicação privada e coordena autorização e sessões.
- **Sistemas externos:** Supabase, Vercel, provedor TURN, serviço de e-mail transacional e infraestrutura de distribuição desktop. SFU é candidato futuro.

Fronteiras de confiança: dispositivo do jogador; internet; plataforma Supabase; infraestrutura de mídia; pipeline de distribuição. Um cliente modificado deve ser tratado como hostil, mesmo após login.

### C2 — Contêineres

| Contêiner | Tecnologia proposta | Responsabilidade |
|---|---|---|
| Cliente web | Vue 3, TypeScript, Vite | Interface, estado, áudio e adaptadores web |
| Cliente desktop | Mesma aplicação + Tauri 2 + WebView2 | Experiência Windows e integrações nativas limitadas |
| Host nativo | Rust/Tauri | Bandeja, atalhos, cache e armazenamento de sessão protegido |
| Frontend/CDN | Vercel | HTTPS, assets versionados e fallback de rotas SPA |
| Identidade | Supabase Auth | Login, renovação de sessão e recuperação de conta |
| API e banco | Supabase Data API/RPC/Postgres | Dados autoritativos, transações e isolamento por espaço |
| Backend de controle | Supabase Edge Functions | Comandos privilegiados, validação, quotas e credenciais TURN |
| Eventos | Supabase Realtime | Notificações privadas e presença efêmera |
| Objetos | Supabase Storage privado | Avatares e arquivos de soundboard |
| Relay de mídia | TURN dedicado ou gerenciado | Travessia de redes quando conexão direta falhar |
| Encaminhamento futuro | SFU, fornecedor não escolhido | Admissão e encaminhamento centralizado de mídia |

Relações: clientes → Vercel por HTTPS para assets web; clientes → Auth/API/Storage por HTTPS; clientes ↔ Realtime por WSS; cliente ↔ cliente por WebRTC/DTLS-SRTP, possivelmente mediado por TURN. Funções → Postgres para autorização/transação; funções → Realtime para eventos autoritativos; funções → serviço TURN para emissão de credenciais conforme integração escolhida.

### C3 — Componentes

No cliente, `AppShell` compõe os módulos; casos de uso dependem de interfaces, implementadas por adaptadores Supabase, WebRTC e plataforma. A UI não chama comandos Rust nem manipula SDP diretamente.

No backend, componentes separados tratam `IdentityGuard`, `MembershipPolicy`, `InviteService`, `MessageService`, `VoiceAdmission`, `SignalRelay`, `SoundTrigger`, `UploadPolicy` e `AuditWriter`. Operações com múltiplas escritas usam uma única transação no banco; várias chamadas HTTP encadeadas não são consideradas uma transação.

### C4 — Organização de código

Contratos TypeScript descrevem comandos, eventos e erros; schemas validam entradas em execução. Tipos gerados do banco apoiam adaptadores, sem substituir regras de domínio. Interfaces centrais: `IdentityPort`, `MessageRepository`, `RealtimePort`, `VoiceTransport`, `AudioDevicePort`, `SoundCache`, `SecureSessionStore` e `DesktopIntegration`.

## 5. Monorepo pnpm e dependências

```text
oryn/
  apps/
    web/                    # entrada Vite e composição web
    desktop/                # entrada Vite desktop e src-tauri/
  packages/
    app/                    # telas, rotas e composição compartilhadas
    ui/                     # componentes e tokens Midnight
    domain/                 # regras e entidades sem SDK de infraestrutura
    contracts/              # DTOs, schemas, eventos versionados e erros
    data-supabase/          # consultas, RPCs e tipos gerados
    realtime/               # assinaturas, reconexão e reconciliação
    voice/                  # estado da chamada e transporte P2P
    audio/                  # dispositivos, reprodução e volumes
    soundboard/             # catálogo, eventos e cache
    platform/               # interfaces e adaptadores web/desktop
    observability/          # métricas e remoção de dados sensíveis
    config/                 # configuração compartilhada de ferramentas
  supabase/
    migrations/             # alterações versionadas, incluindo RLS
    functions/              # comandos e integração TURN
    tests/                  # autorização e transações
    seed.sql                # apenas dados sintéticos
  tests/                    # integração, E2E e cenários de rede
  docs/adr/                 # evolução dos ADRs deste documento
  pnpm-workspace.yaml
  pnpm-lock.yaml
  ARCHITECTURE.md
```

Dependências: `apps → app → módulos → domain/contracts`; adaptadores implementam portas e são injetados na composição. `domain` não importa Vue, Tauri ou Supabase. O build web não inclui imports nativos; evitar detecção dispersa de plataforma por condicionais.

Propostas adicionais: Vue Router para navegação; Pinia para estado de sessão/UI; cache de consultas encapsulado na camada de dados, sem duas fontes concorrentes de verdade. TypeScript estrito; Rust com formatação e lint; versões fixadas e lockfiles de pnpm/Cargo versionados. Selecionar versões exatas no bootstrap após checar compatibilidade. O runtime de Edge Functions precisa de configuração própria; não presumir que todo pacote pnpm funciona nele sem adaptação.

## 6. Módulos e propriedade do estado

| Módulo | Estado autoritativo | Responsabilidades |
|---|---|---|
| Identidade | Auth + perfil no banco | Sessão, recuperação, logout e vínculo de dispositivo |
| Espaços/acesso | Postgres | Convites, associação, papéis e remoção |
| Canais | Postgres | Metadados e tipo texto/voz |
| Chat | Postgres | Envio idempotente, histórico, edição e exclusão |
| Presença | Efêmero | Disponibilidade aproximada; nunca autorização |
| Voz | Admissão no banco; transporte local | Entrada, saída, negociação e reconexão |
| Áudio | Dispositivo local | Captura, mute/deafen, volumes e indicadores |
| Soundboard | Catálogo no banco; reprodução local | Seleção, evento validado, cache e mixagem de saída |
| Preferências | Local; subconjunto sincronizável | Tema, volumes, dispositivos e atalhos |
| Plataforma | Sistema operacional | Bandeja, atualização e armazenamento protegido |

Não persistir SDP, ICE, áudio ou indicadores instantâneos de fala como histórico de produto. Preferências de dispositivo e atalhos são locais: identificadores de áudio não são portáveis entre máquinas.

## 7. Modelo de dados proposto

Identificadores UUID, datas `timestamptz` em UTC e limites de texto no banco. `space_id` é a chave de isolamento. Chaves estrangeiras compostas devem impedir referências cruzadas entre espaços; um `channel_id` válido isoladamente não basta.

| Entidade | Campos e restrições principais |
|---|---|
| `profiles` | `user_id` PK/FK de Auth, `display_name`, `avatar_object_key`, timestamps; sem e-mail público |
| `spaces` | `id`, `name`, `created_by`, timestamps |
| `space_members` | PK `(space_id,user_id)`, `role`, `status`, `joined_at`; índice por usuário/status |
| `channels` | `id`, `space_id`, `name`, `kind`, `position`, `archived_at`; UNIQUE `(space_id,id)` |
| `messages` | `id`, `space_id`, `channel_id`, `author_id`, `client_nonce`, `body`, `revision`, timestamps e `deleted_at` |
| `invites` | `id`, `space_id`, hash do token, validade, limite/contador de usos, emissor, revogação |
| `sound_assets` | `id`, `space_id`, proprietário, nome, versão, hash, chave de objeto, MIME, tamanho, duração, estado |
| `voice_sessions` | `id`, `space_id`, `channel_id`, `epoch`, estado e timestamps |
| `voice_participants` | sessão, usuário, conexão, lease, estado; uma participação ativa por usuário |
| `user_preferences` | usuário, versão do schema e preferências permitidas para sincronização |
| `audit_events` | espaço, ator, ação, alvo, instante e metadados mínimos; escrita somente backend |
| `event_outbox` | evento, destinatário/tópico, tentativa, prazo, entrega; schema privado |

`messages`: UNIQUE `(author_id,client_nonce)` para repetição segura; índice `(channel_id,created_at,id)` para paginação por cursor. Limite inicial proposto de 4.000 caracteres por mensagem. Edição usa revisão esperada para detectar conflitos; não aceitar alteração de autor ou espaço.

Convites usam tokens aleatórios de alta entropia; persistir apenas hash. Resgate verifica validade, revogação e quota sob lock/transação, com associação idempotente. Transferência de propriedade não pode deixar um espaço sem owner; impedir remoção do último owner sem transferência ou exclusão explícita.

Dados efêmeros: presença e sinalização não são histórico. Leases de voz persistem somente o necessário para admissão e limpeza; registro proposto de heartbeat a cada 15 s e expiração após 45 s. Dimensionar custo antes de ampliar o piloto.

### 7.1 Retenção e ciclo de vida

Proposta: mensagens permanecem até exclusão ou encerramento do espaço; tombstones técnicos por 30 dias; auditoria mínima por 90 dias; telemetria detalhada por até 14 dias. Convites expirados e leases antigos recebem limpeza periódica. Prazos dependem de aprovação de produto e política de privacidade.

Exclusão de conta requer regra explícita para mensagens, autoria e transferência de espaços. Exclusão de objeto e alteração SQL não são atômicas entre serviços: usar estado `pending_delete`, worker idempotente e reconciliação de órfãos. Backups podem manter dados até seu ciclo de expiração; não prometer apagamento instantâneo universal.

## 8. Segurança e autorização

### 8.1 Identidade e sessões

Proposta inicial: e-mail/senha com confirmação e recuperação pelo Supabase Auth; acesso ao conteúdo exige convite. OAuth com PKCE pode ser adicionado após POC de callback no desktop. Links de recuperação/callback têm allowlist de origens e rotas, sem redirecionamento arbitrário.

No desktop, refresh token em armazenamento protegido pelo Windows, acessível por comandos estreitos; token de acesso de curta duração em memória. No web, persistência de sessão é decisão explícita: começar sem persistência durável, aceitando novo login após recarregar. “Lembrar de mim” exige ADR sobre exposição a XSS ou adoção de BFF/cookie HttpOnly; uma SPA não consegue tornar seu próprio token HttpOnly.

Nunca embutir chave secreta/service role, segredo TURN ou chave de assinatura no bundle. Chave publicável não substitui RLS. Validar JWT no backend e consultar associação atual para ações sensíveis; não confiar em `user_metadata`, papel enviado pelo cliente ou apenas em claims potencialmente desatualizadas.

### 8.2 Matriz de autorização proposta

| Recurso/ação | Regra |
|---|---|
| Ler espaço, canais e mensagens | Membro ativo do espaço |
| Enviar mensagem | Membro ativo; canal de texto não arquivado; autor derivado da sessão |
| Editar mensagem | Próprio autor, membro ativo e revisão esperada |
| Apagar mensagem | Autor ou admin/owner, com auditoria de moderação |
| Criar canal/convite ou moderar | Admin/owner; hierarquia de papéis respeitada |
| Transferir propriedade/excluir espaço | Owner, transação e confirmação na experiência do produto |
| Ler/reproduzir som | Membro ativo e asset disponível no mesmo espaço |
| Publicar/remover som | Admin/owner inicialmente |
| Entrar em voz | Membro ativo, canal correto, capacidade e lease válidos |
| Atualizar preferências | Próprio usuário |

Aplicar RLS a toda tabela exposta e grants mínimos de tabela, coluna e função. RLS de atualização inclui condições de leitura/escrita; campos imutáveis exigem privilégios de coluna, triggers ou RPCs. Views expostas devem respeitar o chamador. Funções privilegiadas são exceções revisadas, com `search_path` fixo, `EXECUTE` restrito e validação interna. Referência: [RLS no Supabase](https://supabase.com/docs/guides/database/postgres/row-level-security).

Não criar políticas recursivas de associação sem avaliação. Caso um helper privilegiado seja necessário para consultar memberships, colocá-lo em schema privado e limitar seus argumentos e retorno. Cobrir usuários de outros espaços e tentativas de elevação de papel nos testes.

### 8.3 Realtime e revogação

Usar canais privados, políticas específicas em `realtime.messages` e acesso público desabilitado. Autorizar recepção por usuário/espaço; clientes não publicam eventos autoritativos de sinalização ou soundboard diretamente. A autorização de canais pode ficar em cache durante a conexão: alteração de membership não equivale a expulsão instantânea. Referência: [Realtime Authorization](https://supabase.com/docs/guides/realtime/authorization).

Proposta para o piloto: funções verificam associação a cada comando e fazem fan-out para tópicos privados por conexão destinatária, resolvidos no servidor. Somente o backend publica nesses tópicos; assinatura exclusiva do destinatário. Assim, uma conexão antiga não recebe novos eventos apenas por continuar inscrita em um tópico compartilhado. Presença compartilhada contém apenas dados mínimos e não é controle de acesso.

Ao remover alguém: negar novos comandos, invalidar lease, emitir saída aos participantes e orientar clientes legítimos a fechar as conexões com o removido. **P2P não permite garantir que dois clientes modificados interrompam uma conexão já estabelecida.** Expiração de JWT ou credencial TURN também não deve ser tratada como encerramento imediato de mídia existente. Se expulsão central obrigatória for requisito, SFU com controle de admissão torna-se gate antes do lançamento.

### 8.4 Arquivos e host desktop

Buckets privados; autorização sobre `storage.objects` vinculada ao espaço e ao catálogo. URL assinada é credencial temporária de leitura, não deve entrar em logs. Não usar só o nome da pasta como prova de permissão. Referência: [Storage Access Control](https://supabase.com/docs/guides/storage/security/access-control).

Uploads ficam em quarentena até validação real de conteúdo, duração e tamanho; MIME declarado pelo cliente não é prova. Um job isolado de mídia é necessário se o runtime de funções não suportar validação/transcodificação com limites adequados. Não executar arquivos nem permitir SVG/HTML ativos como avatar.

Tauri: capabilities mínimas por janela, comandos tipados, validação de argumentos, caminhos restritos ao diretório do aplicativo e sem shell genérico. CSP restritiva; HTML de mensagens nunca renderizado livremente. Links externos abrem no navegador após validar esquema. Referência: [Capabilities do Tauri](https://v2.tauri.app/security/capabilities/).

### 8.5 Privacidade

“Privado” significa acesso restrito por associação; não significa anonimato ou E2EE de todo o produto. Texto e arquivos ficam acessíveis à infraestrutura autorizada. WebRTC protege o transporte da mídia, mas não impede gravação por um participante. P2P direto pode revelar endereços de rede aos pares; oferecer modo somente relay depende de testes e custo. Uma futura SFU altera a fronteira de confiança e exige nova decisão sobre E2EE.

## 9. Voz WebRTC, Opus e TURN

### 9.1 Transporte inicial

Uma captura local de microfone e uma `RTCPeerConnection` por par. Mesh com N participantes cria N(N−1)/2 conexões no grupo; cada cliente envia a N−1 pares. Usar `VoiceTransport` para permitir substituição por SFU sem acoplar telas à topologia.

Preferir Opus mono para fala, com bitrate inicial experimental de 24–40 kbit/s por destino; não confundir bitrate do codec com banda total. Negociação, DTX/FEC e processamento de áudio dependem do runtime e devem ser medidos. Estimativa teórica: 4 pessoas a 32 kbit/s geram aproximadamente 96 kbit/s de payload enviado por cliente, antes de overhead e tráfego auxiliar. Referências: [WebRTC W3C](https://www.w3.org/TR/webrtc/) e [Opus RTP RFC 7587](https://www.rfc-editor.org/info/rfc7587/).

STUN auxilia descoberta de conectividade; TURN faz relay quando necessário. Provisionar TURN antes do piloto externo, incluindo testes com UDP bloqueado e fallback TCP/TLS. Credenciais temporárias são emitidas somente a participantes autorizados, com TTL e quotas. A combinação de portas e transportes depende do provedor e deve ser comprovada; TURN não garante funcionamento em qualquer rede.

### 9.2 Estado, sinalização e dispositivos

Máquina de estados: `idle → requesting_permission → joining → negotiating → connected → reconnecting → leaving → idle`, com estado de erro e cancelamento em cada operação assíncrona.

O backend resolve o remetente autenticado, destino permitido e sessão ativa antes de encaminhar offer/answer/ICE. Envelope contém versão, `event_id`, `session_id`, `epoch`, conexão de origem/destino, sequência e expiração. Não confiar em `sender_id` no corpo do cliente. Impor limites de tamanho e frequência; agrupar candidatos quando necessário.

Definir par educado/não educado para colisões de oferta; enfileirar ICE até descrição remota; ignorar epochs antigos; timeout de negociação; ICE restart limitado e com backoff. Ao trocar de sala, fechar conexões antigas antes de liberar captura/estado. Não registrar SDP ou candidatos em telemetria comum.

Mute desativa envio de voz; deafen silencia saídas e, por proposta de UX, também ativa mute. Indicadores devem refletir estado efetivo. Push-to-talk global depende do host Windows e de teste com jogos; perda de foco, keyup ausente, bloqueio de sessão e suspensão devem retornar ao estado sem transmissão. Ao sair, parar tracks e liberar dispositivos.

Testar autoplay, retomada de `AudioContext`, troca/remoção de headset, Bluetooth, cancelamento de eco, redução de ruído, seleção de saída e comportamento minimizado. Recursos disponíveis em navegador não comprovam equivalência no WebView2.

### 9.3 Critérios de avaliação SFU

Comparar implementação baseada em LiveKit, mediasoup ou outro candidato apenas após definir requisitos; fornecedor e hospedagem não estão escolhidos. Avaliar 4/6/8 participantes, CPU durante jogo, uplink, latência, custo de relay, operação, licenciamento, E2EE e moderação.

Abrir ADR de migração se houver necessidade de salas maiores que o limite homologado, se mais de 5% das sessões do piloto ultrapassarem o orçamento de áudio, ou se expulsão central verificável se tornar obrigatória. Não esperar um número arbitrário de usuários para resolver um requisito de segurança incompatível com P2P.

## 10. Soundboard por eventos e cache

O clique envia um comando; cada destinatário reproduz localmente o mesmo asset. O arquivo não é retransmitido pelo microfone nem enviado pelo Realtime. Separar barramentos de saída de voz, soundboard e interface; prevenir loops e dupla reprodução no emissor.

Fluxo proposto:

1. Admin solicita upload, com limite inicial de 2 MiB e 10 s por som.
2. Backend autoriza caminho privado; arquivo recebe estado de quarentena.
3. Validação/normalização aprova uma versão imutável e registra hash, duração e tamanho reais.
4. Ao entrar na sala, clientes buscam o catálogo autorizado e pré-carregam favoritos dentro do orçamento.
5. `trigger_sound` valida membro, lease, asset, quota e cooldown no servidor.
6. Backend distribui evento com identidade autenticada, asset/versão/hash, `event_id` e prazo.
7. Cliente deduplica, verifica sessão e prazo e reproduz o cache; se precisar baixar, só toca dentro da janela válida.

Limites iniciais propostos: um disparo por usuário a cada 2 s, máximo de dois sons simultâneos por cliente e teto por sala. Esses limites são transacionais ou centralizados; estado em memória de uma função isolada não implementa quota global.

Cache: chave por conta/espaço/asset/versão/hash, LRU e teto inicial de 100 MiB. Web usa armazenamento de blobs via IndexedDB/Cache API; desktop usa diretório próprio por adaptador. Hash verifica integridade, não autorização. Arquivo é baixado apenas após autorização atual; não usar URL assinada como identidade estável do cache.

Eventos expiram após 2 s por proposta. Sem cache e sem download a tempo, descartar com indicador discreto; não tocar sons atrasados depois de reconectar. MVP oferece reprodução próxima no tempo, sem garantia de sincronização sample-accurate. Medir diferença entre participantes antes de adicionar relógio sincronizado e agendamento futuro.

Logout, remoção de espaço e exclusão de asset limpam referências e cache no cliente legítimo. Cópias já baixadas não podem ser revogadas de dispositivos hostis. Autoplay exige interação inicial do usuário. Volume, desativação local e normalização devem evitar picos desagradáveis, com testes de áudio ainda pendentes.

## 11. Fluxos principais e consistência

### 11.1 Login e convite

Cliente autentica → obtém sessão → lê apenas espaços permitidos → apresenta convite → RPC valida hash/validade/limite e cria associação atomicamente → cliente refaz consulta autorizada. Erros não revelam existência de espaços a terceiros. Dados anteriores são limpos ao trocar de conta.

### 11.2 Envio e reconciliação de chat

Cliente cria `client_nonce` e estado pendente → comando/RPC valida e persiste → resposta confirma ID/revisão → evento informa mudança → destinatário busca/atualiza dado autorizado. Timeout permite repetir o mesmo nonce sem duplicar mensagem. Falha permanece visível com opção de repetir.

Para evitar lacunas, assinar e armazenar eventos durante a busca do snapshot, depois mesclar por ID/revisão. Reconexão sempre refaz consulta; eventos são avisos, não a única fonte de verdade. Paginação usa `(created_at,id)`; timestamps isolados não garantem ordem total. Exclusões precisam de tombstone ou invalidação explícita da consulta.

### 11.3 Entrada e saída de voz

Gesto do usuário → solicitar microfone → admissão transacional checa capacidade e participação única → emitir lease/epoch e credenciais TURN → assinar tópico privado → obter roster → negociar com pares. Entrada concorrente não pode exceder capacidade; usar lock no recurso de sala. Política para segunda sessão: rejeitar e oferecer transferência explícita.

Heartbeat renova lease após validar membership. Falha de controle dispara aviso; ao expirar lease, cliente legítimo encerra mídia. Saída voluntária revoga participação e fecha transporte. Crash é reconciliado por expiração. Suspensão/retomada revalida sessão em vez de reutilizar estado antigo.

### 11.4 Garantias de eventos

Assumir perda, repetição e reordenação. Eventos versionados usam IDs e epochs; handlers são idempotentes. Mensagens e alterações duráveis podem gerar outbox na mesma transação, com worker de retry e reconciliação. Confirmar aceitação no serviço de eventos não prova entrega a cada cliente.

Sinalização e soundboard são efêmeros: expiração curta e nenhuma reprodução histórica. Retries de sinalização são limitados à negociação atual; retries de som mantêm o mesmo ID. `event_outbox` durável não deve transformar áudio atrasado em fila de reprodução.

## 12. Requisitos não funcionais propostos

Todas as metas abaixo estão **não medidas**. Baseline proposto: Windows 11 x64, 4 núcleos, 8 GiB RAM, SSD, headset e partida representativa em execução; especificar CPU/jogo reais no relatório da POC. Rede nominal de teste: RTT até 80 ms, perda até 1% e uplink disponível de 5 Mbit/s; testar degradação separadamente.

| Área | Meta inicial / critério de avaliação |
|---|---|
| Voz | Latência boca-ouvido p95 ≤ 200 ms em cenário nominal, medição externa; RTT não substitui esse valor |
| Entrada em sala | p95 ≤ 5 s após permissão de microfone, incluindo negociação |
| Reconexão | p95 ≤ 10 s após restabelecer rede; estados de erro compreensíveis |
| Chat | Confirmação persistida p95 ≤ 800 ms em região de referência |
| Soundboard | Clique até reprodução remota em cache p95 ≤ 300 ms; medir assimetria entre clientes |
| CPU desktop | Média ≤ 5% da CPU total ocioso e ≤ 10% em chamada de 4; comparar também FPS/frame time do jogo |
| Memória desktop | Working set agregado do host e processos WebView2 ≤ 300 MiB ocioso e ≤ 450 MiB em voz |
| Inicialização | Janela utilizável p95 ≤ 3 s, separando inicialização fria/quente |
| Disponibilidade | Objetivo futuro de 99,5% mensal do fluxo de texto/login; medir voz separadamente |
| Recuperação | RPO proposto ≤ 24 h e RTO ≤ 4 h, dependentes do plano e ensaio de restauração |
| Acessibilidade | Fluxos centrais por teclado, contraste WCAG AA e foco legível; auditoria pendente |
| Compatibilidade | Matriz Windows/WebView2 e navegadores com versões registradas por release |

Não prometer menor consumo que Discord sem comparação controlada. Atingir a meta em máquina isolada não prova comportamento enquanto um jogo disputa CPU, GPU e áudio.

## 13. Implantação, operação e custos

Ambientes separados: desenvolvimento, staging e produção, com projetos Supabase e credenciais distintos. Previews Vercel usam dados sintéticos/staging restrito, nunca produção por padrão. Região do banco e TURN é decisão baseada na localização do piloto; não assumir proximidade apenas pelo nome da região.

Web: build estático Vite, rotas SPA com fallback e assets com hash; HTML com política que permita atualização. Sem segredos em variáveis `VITE_*`. Rever quotas atuais antes da implantação, conforme [limites da Vercel](https://vercel.com/docs/limits).

Desktop: pipeline Windows gera instalador, testa instalação/remoção e assina executável/instalador; assinatura do updater é adicional e distinta. Proposta de WebView2 Evergreen, com detecção e tratamento da ausência do runtime, sujeita à POC. Referência: [Windows Installer do Tauri](https://v2.tauri.app/distribute/windows-installer/).

Publicação desktop em canal interno antes do estável. Chaves de assinatura ficam no cofre do CI, com acesso mínimo. Atualizações verificam assinatura, permitem adiamento durante chamada e possuem plano de recuperação. Hospedagem dos binários e manifesto será escolhida após verificar custo e limites; não faz parte automaticamente do deploy da SPA.

Migrações seguem expandir → publicar clientes compatíveis → migrar dados → remover legado. Suportar versão atual e anterior do contrato durante janela definida, inicialmente 30 dias. Protocolos incompatíveis retornam solicitação de atualização; não quebrar silenciosamente clientes desktop antigos. Rollback de frontend não desfaz banco; alterações destrutivas exigem plano próprio.

Backups cobrem banco **e objetos**; não presumir que backup do Postgres contém os arquivos do Storage. Definir inventário, credenciais de restauração e teste em ambiente isolado. Runbooks necessários: indisponibilidade Auth/Realtime/TURN, migração falha, rotação de chaves, restauração e release desktop defeituoso.

Observabilidade: tempo de entrada, falhas de ICE, uso de relay, perda/jitter, duração de chamadas, desconexões, falhas de cache e latência de comandos. Amostrar `getStats` e registrar apenas agregados; remover tokens, e-mails, conteúdo de mensagens, SDP, IPs e URLs assinadas. IDs pseudônimos e retenção curta. Erros de RLS devem ser diagnosticáveis sem expor dados.

Custo mensal = plataforma/base + banco/Auth/Realtime + Storage/egress + TURN + distribuição/observabilidade. TURN depende de volume retransmitido, bitrate, duração, participantes e unidade de cobrança do fornecedor. Medir bytes efetivos; não usar a estimativa de payload como fatura. Criar alertas em 50/80/100% de um orçamento ainda a definir; controlar uploads e novas admissões sem interromper chamadas abruptamente.

## 14. Estratégia de testes e POCs — todas não executadas

Testes planejados: unitários para regras e máquinas de estados; integração Postgres para RLS/transações; contratos entre clientes e funções; E2E web para fluxos; testes nativos Windows para permissões, atalhos, áudio e atualizações. E2E de navegador não substitui teste do aplicativo Tauri empacotado.

| POC | Experimento e evidência exigida | Gate |
|---|---|---|
| P01 — Áudio WebView2 | Captura, Opus, autoplay, saída, Bluetooth, remoção de headset, minimização e suspensão; matriz/versionamento | Sem captura e recuperação estáveis, rever camada de áudio antes do MVP |
| P02 — Mesh/TURN | 2/4/6/8 pares em LAN, CGNAT, VPN, UDP bloqueado, perda/jitter; estatísticas e medição boca-ouvido | Homologar limite de sala e fornecedor TURN |
| P03 — RLS e isolamento | Dois espaços, papéis, usuário removido, acesso direto à API, views/RPC/Storage e corrida no convite | Zero acesso indevido nos casos definidos antes do piloto |
| P04 — Controle/revogação | Spoofing de remetente, tópicos antigos, expiração de lease, reconexão, cliente alterado e flood | Documentar limites P2P; decidir se SFU é requisito imediato |
| P05 — Soundboard | Cache frio/quente, eventos duplicados/atrasados, arquivo inválido, quotas e mistura de áudio | Sem duplicação ou reprodução fora do prazo; medir latência |
| P06 — Desktop | Sessão protegida, callback se adotado, atalhos em jogo, instalador, updater e assinatura inválida | Liberar apenas integrações comprovadas |
| P07 — Carga/custo | Envelope do piloto, fan-out, consultas RLS, leases e relay; relatório de CPU/memória/egress | Ajustar metas, quotas e orçamento antes de ampliar |
| P08 — Recuperação | Queda de Realtime/TURN, restore de banco/objetos, rollback web e cliente antigo | Runbooks e RPO/RTO medidos antes de produção |
| P09 — SFU | Comparação mesh/SFU sob mesma carga, admissão, moderação, privacidade e custo | ADR com evidências antes de migrar |

Cada relatório deverá conter data, commit, ambiente, versões, método, amostra, resultados, limitações e decisão. Responsável técnico e revisor ainda serão designados. Nenhuma linha desta tabela significa aprovação ou execução.

## 15. Riscos e mitigação

| Risco | Impacto | Tratamento proposto |
|---|---|---|
| Diferenças WebView2/navegador | Áudio ou dispositivos falham no desktop | P01 como primeiro gate; não assumir paridade |
| Mesh compete com jogo | CPU/uplink e qualidade degradados | Limite baixo, telemetria e P02/P09 |
| TURN insuficiente ou caro | Chamadas falham ou orçamento estoura | Relay provisionado desde piloto; P02/P07 |
| Revogação parcial P2P | Participante mantém conexão com cliente cúmplice | Limitação explícita; SFU quando controle central for obrigatório |
| RLS incorreta ou recursiva | Vazamento ou indisponibilidade | Matriz de autorização e testes negativos P03 |
| Identidade/eventos falsificados | Abuso de som ou negociação | Backend deriva ator/destino, quotas e validação P04 |
| Cache privado permanece no disco | Conteúdo acessível após remoção | Limpeza, partição por conta e limitação documentada |
| Upload malformado | Abuso de parser e recursos | Quarentena, limites e processamento isolado |
| XSS no cliente | Roubo de sessão e abuso de IPC | CSP, sanitização, tokens mínimos e capabilities restritas |
| Anticheat/atalhos incompatíveis | PTT falha ou interfere no jogo | Sem injeção/overlay; matriz real e fallback local |
| Clientes desktop desatualizados | Incompatibilidade com API/schema | Contratos versionados e migrações compatíveis |
| Dependência de fornecedores | Mudanças de API/quotas/custo | Adaptadores, exportação de dados e revisão antes de releases |

## 16. ADRs propostos

Todos os registros abaixo têm status **Proposto**. Tecnologias exigidas pelo briefing são restrições de entrada, mas sua implementação não está homologada.

| ADR | Decisão proposta e razão | Alternativas e consequência | Revisão/gate |
|---|---|---|---|
| 001 | Vue 3/Vite compartilhado entre web e desktop para reduzir duplicação | Dois frontends independentes aumentariam manutenção; diferenças ficam em adaptadores | Bootstrap e P01 |
| 002 | Tauri 2/WebView2 para Windows, Rust restrito ao necessário | Electron ou UI nativa são alternativas se áudio/integrações falharem; consumo ainda não comparado | P01/P06 |
| 003 | Supabase gerenciado para identidade, dados e eventos | Backend próprio dá controle, mas aumenta operação; manter contratos e migrações exportáveis | P03/P07 |
| 004 | Vercel para frontend estático; backend de controle em Supabase | API duplicada em duas plataformas cria responsabilidade ambígua | Revisar se surgir necessidade concreta de BFF |
| 005 | Mesh WebRTC/Opus com TURN para piloto pequeno | SFU reduz uplink e centraliza admissão, com custo/operação adicionais | P02/P04/P09 |
| 006 | Soundboard por evento e asset em cache | Mixar no microfone piora controle local e pode duplicar som; evento exige download e expiração | P05 |
| 007 | Comandos sensíveis no backend; eventos autoritativos sem escrita direta do cliente | Broadcast direto reduz latência, mas exige outra prova de identidade e controle de abuso | P04/P07 |
| 008 | Postgres é fonte durável; Realtime é notificação | Event sourcing completo adiciona complexidade sem necessidade inicial | Testes de reconciliação |
| 009 | Espaço privado como tenant e permissões simples | ACL por canal aumenta custo de políticas e UX; fora do MVP | Nova necessidade de produto |
| 010 | Monorepo pnpm com domínio e adaptadores separados | Repositórios separados dificultam contratos compartilhados; monorepo exige limites de importação | CI inicial |
| 011 | Tokens desktop protegidos; web sem persistência durável inicial | LocalStorage aumenta persistência e exposição; BFF/cookie adiciona backend | P06 e avaliação de UX |
| 012 | Sem gravação e sem promessa de E2EE para texto/arquivos | E2EE de conteúdo demanda chaves, recuperação e busca distintas | Requisito explícito de privacidade |

Ao aceitar um ADR, registrar aprovador, data, evidência e consequências; mudanças futuras o substituem por novo registro em vez de apagar a justificativa anterior.

## 17. Roadmap por gates, sem prazos prometidos

| Etapa | Entrega pretendida | Dependência / saída |
|---|---|---|
| 0 — Revisão arquitetural | Escopo, limites, privacidade, papéis, orçamento e responsáveis acordados | Registrar decisões ainda abertas |
| 1 — Viabilidade | P01/P02/P03/P04, protótipo descartável de voz e autorização | Decidir viabilidade Tauri/P2P e necessidade imediata de SFU |
| 2 — Fundação | Monorepo, CI, tokens Midnight, ambientes, schema/RLS e contratos | Build reproduzível e testes de isolamento passando |
| 3 — Comunicação persistente | Login, convites, espaços, canais e chat reconciliável | Fluxos ponta a ponta e concorrência cobertos |
| 4 — Voz privada | Admissão, leases, TURN, dispositivos e estados de erro | Metas do envelope inicial medidas |
| 5 — Soundboard | Upload validado, catálogo, cache e eventos | P05 e quotas comprovadas |
| 6 — Piloto Windows/web | Instalador assinado, atualizações, métricas e runbooks | P06/P07/P08 e limitações comunicadas |
| 7 — Evolução | SFU se indicada, expansão de salas/plataformas e funcionalidades | P09/ADR e evidências do piloto |

O roadmap é sequencial por dependências, não estimativa de calendário. Uma POC reprovada pode alterar arquitetura e escopo; não deve ser mascarada como tarefa concluída.

## 18. Decisões abertas e manutenção

Antes do piloto, definir: público/região inicial; orçamento mensal; provedor TURN; limite de sala homologado; exigência de expulsão central; formato final dos sons; política de retenção; distribuição desktop; matriz Windows/navegadores; persistência de login web; responsáveis por operação e incidentes.

Referências técnicas consultadas orientam a proposta, não são certificação do Oryn. O [changelog do Supabase](https://supabase.com/changelog) deve ser revisto no bootstrap, especialmente exposição explícita de tabelas na Data API e restrições ao schema Realtime. Manter grants/políticas versionados e não criar objetos próprios no schema gerenciado `realtime`.

Revisar este documento quando um gate produzir evidência, um ADR mudar ou um requisito alterar fronteiras de confiança. A próxima ação técnica proposta é executar P01–P04 em ambiente isolado; essa execução não foi realizada como parte desta entrega.
