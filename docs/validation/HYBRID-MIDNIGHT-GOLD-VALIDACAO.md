# Hybrid Midnight Gold: validação da V1

**Data:** 2026-11-07.
**Branch:** `feat/hybrid-midnight-gold`, sobre `origin/main` (`01b463d`, PR #21).
**Decisão:** identidade visual aprovada para a V1. A evolução para uma identidade mais agressiva fica no backlog e não bloqueia esta entrega.
**Especificação:** [`docs/design/HYBRID-MIDNIGHT-GOLD.md`](../design/HYBRID-MIDNIGHT-GOLD.md). Referência aprovada: [`docs/design/referencias/gold-desktop-sala-sons.png`](../design/referencias/gold-desktop-sala-sons.png).

## 1. Escopo validado

- **Só apresentação:** HTML, CSS, tokens e o TypeScript de apresentação (`main.ts`, `members-view.ts`, `rooms-view.ts`, `chat-view.ts`).
- **Sem mudança:** WebRTC, Supabase, migrações, RLS, funções, contratos e o limite de 4 participantes.
- **Ambiente:** stack Supabase local descartável (`oryn-e2e-local`, API em `127.0.0.1:54321`). Cliente de produção compilado com as variáveis da stack local, conferido pelo `connect-src` do `index.html`. Chrome e Edge sem interface, com dispositivo de mídia falso.

## 2. Testes automatizados

| Verificação | Resultado |
|---|---|
| `vitest run` | 1297 aprovados, 0 falhas, 18 `todo` |
| `tsc --noEmit` | sem erros |
| `vite build` | sem erros |
| `pnpm audit --prod` | nenhuma vulnerabilidade conhecida |

**Testes atualizados por decisão aprovada:**
- paleta;
- ícones embutidos, só SVG em `data:` e sem endereço de rede;
- 6 botões na barra, 4 que funcionam e 2 "Em breve";
- ações da sala no cabeçalho.

**Testes novos:**
- cartão "Você" com papel e mudo;
- vagas livres, no singular e no plural;
- `data-count` da grade;
- o próprio cartão e a vaga não contam como "conectado";
- "Em chamada" no cabeçalho.

## 3. Regressão consolidada (navegador)

Roteiros executados um de cada vez, sobre o build final.

| Roteiro | Resultado | Observação |
|---|---|---|
| Login, Chrome | 24/24 | |
| Interface e navegação, Chrome | 76/76 | |
| Voz | 65/65 | Na terceira execução; ver a seção 4 |
| Painéis | 23/23 | |
| Convites | 98/98 | rc=1 por `EPERM` na limpeza do perfil temporário, depois de todas as checagens |
| Chat | 58/58 | |
| Sons | 81/81 | |
| Grupo (4 pessoas) | 75/75 | |
| Estabilização de grupo | 75/75 | |
| Login, Edge | 24/24 | |
| Interface e navegação, Edge | 76/76 | |
| Fidelidade visual (capturas) | 7/7 | Sem erro de página |
| Grade e menu no celular | 9/9, mais 36 combinações de layout | Seção 5 |

**Adaptações dos roteiros:** cada troca corresponde a uma decisão aprovada. O resto de cada roteiro ficou igual. As trocas:
- cores da paleta aprovada;
- barra lateral com 288 px, e 80 px recolhida;
- seleção da sala por borda dourada;
- barra da chamada flutuante, a 24 px das bordas no desktop e a 8 px no celular;
- o primeiro cartão do palco passou a ser "Você", e o participante remoto é o que tem `data-state`.
- **Correção de corrida no próprio roteiro:** espera pela lista de salas recarregada depois de sair da chamada, antes de "Encerrar sala". Não é falha da aplicação: na outra execução, o mesmo ponto passou sem a espera.

**Não repetido:** o roteiro Gold anterior, de 43 checagens. Ele conferia decisões substituídas pela composição aprovada. A revisão de grade e o roteiro de fidelidade ficam no lugar dele.

## 4. Instabilidade intermitente da medição de áudio

- **Onde:** `ui-voice`. As checagens "o som volta" e "áudio intacto depois de toda a navegação" medem a energia do áudio recebido numa janela de cerca de 2,5 s, com o dispositivo de mídia falso do Chrome.

| Execução | Resultado | Medida |
|---|---|---|
| 1 | "o som volta" falhou, lado B recebendo A | 129 pacotes, energia 0,0007 (exige > 0,01) |
| 2 | "o som volta" passou | energia 0,3872 |
| 2 | "áudio intacto" falhou, lado A recebendo B | 129 pacotes, energia 0,0018 |
| 3 | as duas passaram, 65/65 | energias 0,4506 e 0,3905 |

- **Por que não é defeito da entrega:**
  - Os pacotes chegaram em todas as medições, com a conexão viva e um único `RTCPeerConnection`.
  - A queda caiu em checagens diferentes e em lados diferentes, e não se repetiu.
  - Nenhum código de captura, mudo, malha ou reprodução mudou nesta entrega. O botão de mudo ganhou só `data-muted` e o redesenho do cartão próprio.
  - O mudo real foi conferido na mesma execução ("o outro lado recebe silêncio", energia 0) e nos roteiros de grupo e estabilização (75/75 cada).
- **Relação:** é a mesma classe de instabilidade já registrada em `C-mudo-silencia-para-cada-um-dos-outros` (`group-e2e`), que mede logo depois do clique.
- **Tratamento:** registrada como instabilidade da medição. Não bloqueia. Se voltar a aparecer, o caminho é uma janela de medição maior ou uma espera curta pelo quadro com energia, nunca baixar o limite.

## 5. Revisão pontual de layout

**Grade de participantes.**
- **Combinações medidas:** 2, 3 e 4 cartões, em 1671×941, 1280×800, 1024×768, 768×1024, 390×844 e 360×780, com e sem chat. São 36 combinações.
- **Corrigido nesta revisão:**
  - cartões altos e estreitos, com proporção de até 0,53;
  - segunda linha sob a barra da chamada a 1280 e a 1024 px e no celular;
  - nome da sala espremido pelas ações entre 769 e 1199 px;
  - "Sair da chamada" sobre os controles a 1024 px.
- **Resultado:** proporção de 0,8 a 1,9, sem rolagem horizontal, e a grade termina acima da barra em todas as combinações.

**Menu lateral no celular**, sem mudança necessária:
- o backdrop cobre o conteúdo, o cabeçalho e a barra;
- `#shell-main`, `#call-bar` e `#soundboard` ficam `inert`;
- 14 Tabs seguidos ficam dentro da navegação;
- tocar no backdrop fecha sem acionar o botão de baixo e devolve o foco ao botão Menu;
- Esc fecha;
- a chamada continua.

## 6. Infraestrutura (separada da aplicação)

- **`EPERM`:** com rc=1 sem nenhuma reprovação, vem da limpeza do perfil temporário do navegador no Windows.
- **Build apontado para produção:** durante o desenvolvimento, um `vite build` sem as variáveis da stack local gerou um cliente apontado para produção, servido alguns minutos só pela prévia local. Foi refeito logo depois; nenhuma captura ou roteiro usou esse build, e não houve chamada a produção nem deploy.
- **Edge Functions:** o servidor local seguiu respondendo, com `signal` e `sound-media` dando 401 sem login, durante toda a regressão.

## 7. Pendências não bloqueantes

- **Logotipo:** o "V" vetorial é provisório e precisa da arte oficial em SVG. Ver a seção 6 da especificação.
- **Identidade mais agressiva:** backlog futuro.
- **Medição de áudio do `ui-voice`:** seção 4.

## 8. Evidências

Capturas **locais, não versionadas**, em `poc/webrtc-audio-supabase/integration/evidence/hybrid-gold/`. A pasta está no `.gitignore` pela regra da POC-02C.1B: evidências locais nunca entram no repositório. Para revisar, peça as capturas ao responsável ou gere de novo com a stack local. Versionada fica só a referência aprovada, em `docs/design/referencias/`.
- **`F05-sons-dono.png`:** o mesmo estado da referência, em 1671×941.
- **Desktop:**
  - `F06-chamada-com-mensagens.png`, chamada com chat;
  - `F07-chamada-mutado.png`, mudo;
  - `F02-sala-sem-chamada.png`, sala sem chamada;
  - `F03-gerenciar-sala.png`, menu ⋮;
  - `F01-visao-geral.png`, visão geral;
  - `F08-membro-1280-sons.png`, sons vistos pelo membro, a 1280 px;
  - `F09-1280-chamada.png`, chamada a 1280 px.
- **Celular, 360 px:**
  - `F10-celular-chamada.png`, chamada;
  - `F12-celular-sons.png`, sons;
  - `F13-celular-menu.png`, menu.
- **`grade/`:** 4 cartões a 1671, 1280, 1024 e 360 px, com e sem chat, e o menu lateral aberto no celular.
