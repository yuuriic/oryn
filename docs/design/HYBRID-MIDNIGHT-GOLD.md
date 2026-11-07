# Oryn Hybrid Midnight Gold: especificação visual

**Estado em 2026-11-07:**
- **Branch:** implementação local em `feat/hybrid-midnight-gold`, sobre `origin/main` (`01b463d`, PR #21). Não integrada e não publicada.
- **Revisão arquitetural:** composição aprovada.
- **Aprovação:** identidade visual aprovada para a V1. A evolução para uma identidade mais agressiva fica no backlog futuro.
- **Validação final:** [`docs/validation/HYBRID-MIDNIGHT-GOLD-VALIDACAO.md`](../validation/HYBRID-MIDNIGHT-GOLD-VALIDACAO.md), com as capturas locais (não versionadas) em `poc/webrtc-audio-supabase/integration/evidence/hybrid-gold/`.

## 0. Referência aprovada

- **Imagem oficial:** [`referencias/gold-desktop-sala-sons.png`](referencias/gold-desktop-sala-sons.png), em 1671×941. Mostra a sala de voz em chamada com o dono, o painel de sons aberto e o chat à direita.
- **Sem referência de celular:** o layout de celular (seção 2.5) é proposta da implementação, aprovada junto com a composição.
- **Sem ativos externos:** sem fonte externa e sem imagem de terceiros. Os ícones são traços SVG próprios, embutidos como máscaras CSS (`data:`, permitido por `img-src 'self' data:` na CSP). A CSP e a §2.3 da ARCHITECTURE.md continuam valendo.

## 1. Identidade

| Papel | Token | Valor | Uso |
|---|---|---|---|
| Fundo Midnight | `--color-bg` | `#0c0a18` | Página, com dois brilhos radiais discretos (violeta no alto, dourado embaixo) |
| Superfície | `--color-surface` | `#15112a` | Barra lateral, painéis, cartões |
| Elevada | `--color-elevated` | `#211b3c` | Botões de ícone, cartões de som, campos |
| **Violeta** | `--color-accent` | `#9d7bff` | Seleção, foco de marca, avatar |
| Violeta forte | `--color-accent-strong` | `#6d3df2` | Fundo de "Minhas salas" ativo e de "Entrar na chamada", com texto branco |
| Violeta suave | `--color-accent-soft` | `#2a1f55` | Fundos de seleção e mensagens próprias |
| **Dourado** | `--color-gold` | `#f2b544` | Dono, sala selecionada, microfone ligado, Sons, "Criar sala", painel de sons |
| Dourado suave | `--color-gold-soft` | `#33270f` | Fundo dos botões dourados e do selo "Dono" |
| **Verde** | `--color-success` | `#5ee0a5` | Participante conectado, sala da chamada, "Na chamada" |
| **Vermelho** | `--color-error` | `#ff8a96` | Mudo, remover, revogar, encerrar, erros |
| Vermelho forte | `--color-danger-strong` | `#d42a4a` | Fundo de "Sair da chamada", com texto branco |
| Texto | `--color-text` | `#f5f3ff` | Texto principal |
| Texto secundário | `--color-text-secondary` | `#aca6cc` | Metadados |

**Regras:**
- **Contraste:** todo texto tem pelo menos 4,5:1; borda de controle e foco, pelo menos 3:1. O teste `web-design-system` confere.
- **Brilho:** sombra dourada ou violeta só em bordas de destaque (`--glow-gold`, `--glow-accent`), nunca em grandes áreas.
- **Estado nunca só por cor:**
  - Dono: selo "Dono" e coroa.
  - Conectado: texto "conectado".
  - Mudo: o botão passa a "Reativar microfone", o cartão diz "Microfone desligado".
  - Painel aberto: "Chat aberto" ou "Membros abertos".
  - Sala em chamada: "na chamada".
  - Indisponível: selo "Em breve".

## 2. Composição

### 2.1 Barra lateral
- Logo com "Stay close. Play on.", "Minhas salas" (violeta quando ativo) e a seção **Salas ativas**, só com salas abertas.
- **Sala selecionada:** borda dourada com brilho. **Sala da chamada:** ponto verde no avatar e "na chamada · n/m".
- **"+ Criar sala":** pílula dourada no rodapé. A criação continua sob demanda.
- **Conta:** avatar, e-mail, "Conectado" e "Sair da conta".

### 2.2 Cabeçalho da sala
- Ícone da sala, nome e "● Em chamada · n/m membros" (ou o papel e a lotação sem chamada).
- **Ações em pílulas compactas:** Entrar na chamada (ou o selo verde "Na chamada"), Chat e Membros.
- **Administração:** Convidar, Revogar convites e Encerrar ficam no menu **⋮** ("Gerenciar sala").
- **Atualizar lista:** botão de ícone.
- Sem espaço na linha, as ações descem e o nome nunca é espremido.

### 2.3 Palco da chamada (centro)
- **Cartões grandes:** o próprio ("Você", estado real do microfone), os participantes (nome e estado da conexão) e uma vaga tracejada "Aguardando participantes · Até N vagas disponíveis", calculada pela lotação real.
- **Dono:** cartão com borda dourada, coroa e selo "Dono". **Conectado:** anel verde no avatar.
- **Grade:** depende da largura do palco (container query), não da janela.

| Largura do palco | Cartões | Colunas | Tamanho do cartão |
|---|---|---|---|
| 960 px ou mais | 3 ou 4 | uma linha | normal (avatar 132 px) |
| qualquer | 2 | 2, até 460 px cada | normal |
| até 719 px, ou até 959 px com janela de até 860 px de altura | 2 a 4 | 2 | compacto (avatar 96 px) |
| até 400 px (celular) | 2 a 4 | 2 | compacto (avatar 64 px) |

- **Conferido:** 2, 3 e 4 cartões; janelas de 1671, 1280, 1024, 768, 390 e 360 px; com e sem chat.
  - Proporção de 0,8 a 1,9.
  - Sem rolagem horizontal.
  - A grade termina acima da barra da chamada em todas as combinações.
- **Sala sem chamada:** palco vazio tracejado, com o texto de entrada.

### 2.4 Chat e membros (direita)
- Em 1200 px ou mais, o painel ocupa a coluna da direita, da altura da janela, acima da barra da chamada.
- O chat tem estado vazio ilustrado ("Nenhuma mensagem ainda." e a dica) e campo em pílula com o botão de enviar.
- Com o chat fechado, o painel de membros ocupa essa coluna. Ao trocar de sala, o chat aberto acompanha a sala.
- Abaixo de 1200 px, os painéis ficam embaixo do palco.

### 2.5 Barra da chamada e celular
- **Barra flutuante:** sala e fase à esquerda. No centro, botões redondos:
  - microfone, com anel dourado ligado e vermelho mutado;
  - Ouvir, só se o navegador bloquear o áudio;
  - Sons;
  - os controles futuros.
- **Sair da chamada:** pílula vermelha à direita.
- **Celular:** a barra tem duas linhas e "Sair" vira o botão redondo com telefone, com o nome no texto do botão.
  - O menu lateral abre sobre um backdrop. Conteúdo, barra e sons ficam `inert`, e o Tab não sai da navegação.
  - Tocar no backdrop ou usar Esc fecha o menu e devolve o foco ao botão Menu.

## 3. Soundboard
- **Abertura:** pelo botão **Sons** da barra (`aria-expanded`, `aria-controls`), com o painel flutuante de borda dourada acima da barra. Fecha por ×, Esc ou o próprio botão, e o foco volta.
- **Grade:** cartões compactos com o botão de tocar dourado, o nome e a duração (ou "carregando", "em validação", "falha ao carregar").
- **Ações secundárias:** "Publicar som" (recolhido, só o dono) e remover ("×" no canto, nome acessível "Remover <som>", só o dono).
- **Rodapé do painel:** volume e "Desativar sons neste aparelho".
- **Sem mudança** em `SoundboardController`, `sound-bus`, cache, limites, permissões, contratos ou eventos.

## 4. Controles futuros
- "Transmitir tela" e "Configurações avançadas de áudio" são botões redondos na barra da chamada, com o selo "Em breve", `aria-disabled="true"` e a explicação associada por `aria-describedby`.
- Sem ouvinte, sem pedido de permissão e sem estado novo. Testado em `web-design-system.test.ts`.

## 5. Desvios aceitos em relação à referência

| # | Referência | Implementação | Motivo |
|---|---|---|---|
| 1 | Foto no avatar | Iniciais ("Eu" no próprio cartão) | Não existe envio de imagem de perfil |
| 2 | Barras de nível de áudio | Sem barras | Exigiriam medir a fala; nada de fala simulada |
| 3 | "Convites" com contador na barra lateral | Ausente | A tela não existe no produto |
| 4 | Abas Chat, Membros e Sons no painel direito | Chat e Membros pelas pílulas do cabeçalho; Sons pela barra | As abas mudariam como os painéis abrem e fecham |
| 5 | "Meus sons (n)" e cartão "Adicionar" na grade | "Publicar som" no topo do painel | Mesmo formulário, sem mudar o fluxo |
| 6 | Ícones separados de convidar e link no cabeçalho | Dentro do menu ⋮ | A administração fica fora das ações principais |
| 7 | Engrenagem de configurações no rodapé | Ausente | Não existe tela de configurações |
| 8 | Logotipo da marca | "V" vetorial provisório | Ver a pendência na seção 6 |
| 9 | Sem referência de celular | Layout proposto na seção 2.5 | Aprovado junto com a composição |

## 6. Pendências visuais não bloqueantes
- **Logotipo:** o "V" de `.brand-mark` (`--icon-logo` em `tokens.css`) é provisório. Precisa da arte oficial em SVG, sem dependência externa, para substituir a máscara. Não bloqueia a integração.

## 7. Fora do escopo
- **Capacidade de 8:** em avaliação (`docs/validation/CAPACIDADE-8-AVALIACAO.md`). O limite segue em 4.
- **Sem mudança de comportamento:** WebRTC, Supabase, migrações, autenticação, convites, chat e soundboard.

## 8. Onde está no código
- **Tokens e ícones:** `src/web/styles/tokens.css`, com o contraste conferido em `tests/web-design-system.test.ts`.
- **Composição Gold:** `src/web/styles/gold.css`, importado por último em `style.css`. Só apresentação: a visibilidade das seções segue com o atributo `hidden`.
- **Coluna da direita:** `src/web/styles/shell.css`, a partir de 1200 px.
- **Futuros:** `src/web/styles/voice.css`.
- **Palco:** `renderParticipants` com `ParticipantStage` (`src/web/members-view.ts`), e `drawParticipants` em `src/web/main.ts`. Papel e lotação vêm da lista de salas, e o mudo vem da chamada.
- **Ações no cabeçalho:** `renderRooms` move `#rooms-block` para `#context-actions` na sala selecionada. As classes `room-join`, `room-chat`, `room-members` e `room-invite` estão em `src/web/rooms-view.ts`.
- **Detalhe "Em chamada":** `roomContext(state, selected, activeRoomId)` em `src/web/rooms-view.ts`.
- **Sons:** `#sound-toggle-btn` e `.sound-popover` em `index.html`. O abrir e fechar está em `setSoundsOpen` e `renderSoundboardPanel`, em `main.ts`.
- **Criação sob demanda:** `createOpen` e `#create-cancel-btn`, em `main.ts` e `index.html`.
