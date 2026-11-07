# Interface Midnight: checklist de integração

**Estado em 2026-11-07: implementada e validada localmente; não integrada e não publicada.** Aprovada só para preparar a integração. Atualizar este estado ao integrar.

| Estado | Situação | Evidência |
|---|---|---|
| Implementação | Concluída | 5 commits na branch `feat/midnight-ui` |
| Validação local | Concluída | Tabela abaixo. Stack local, microfone falso, mesma máquina |
| Integração à `main` | **Não feita** | Sem PR |
| Publicação em produção | **Não feita** | Produção segue no cliente do PR #20 |
| Validação em produção | **Não feita** | Depende da publicação |

## 1. Condições já atendidas

| Condição | Resultado |
|---|---|
| Branch sobre o `origin/main` atual | 0 commits atrás; simulação de merge sem conflito |
| Escopo do código | Só frontend e testes: sem `supabase/`, `package.json`, lockfile, `vercel.json`, contratos ou módulos de WebRTC |
| Backend | Nenhuma migração ou função nova é necessária |
| `pnpm test`, TypeScript, build, `pnpm audit --prod` | 1275 aprovados, 18 `todo`, 0 reprovados; sem erros nem vulnerabilidades |
| Chrome: login, interface, voz, painéis | 24/24, 76/76, 65/65, 23/23 |
| Chrome: convites, chat, sons, grupo | 98/98, 58/58, 81/81, 75/75 |
| Edge: login e interface | 24/24, 76/76 |
| Auditoria em 18 estados de tela, desktop e 360 px | 0 achados de contraste, nomes acessíveis, alvos, `hidden` e rolagem |

Roteiros de navegador: fora do repositório e do CI. Resultado do commit `099f393`.

## 2. Pendências obrigatórias antes do merge

- [ ] **Autorização** do push da branch e da abertura do PR.
- [ ] **CI aprovado** no commit final do PR: POC-02B CI e POC-02C CI. A regra da `main` não obriga isso (seção 6): conferir à mão.
- [ ] **Revisão do diff** e conversas do PR resolvidas.
- [ ] **Revisão visual pelo responsável**, usando as capturas locais, porque a prévia não serve (seção 6).
- [ ] **Autorização específica do merge**, porque ele publica.
- [ ] **Id do deployment de produção atual anotado**, como destino de rollback.

Não há nova regressão completa nesta lista: só com mudança funcional ou evidência de regressão. Commits só de documentação não a exigem.

## 3. Riscos aceitos para integrar

| Risco | Situação |
|---|---|
| Layout depende de `:has()` | Suporte em Chromium, Safari 15.4+ e Firefox 121+. **Safari e Firefox não testados.** Sem suporte, a página fica sem a composição |
| WebView2 sem evidência | O Edge cobriu login e interface, mas não é o mesmo ambiente. Bloqueia o desktop do piloto, não esta integração web |
| Áudio só com microfone falso, em uma máquina | Qualidade, eco e rede real não avaliados. A lógica de voz não mudou |
| "Ouvir" testado com bloqueio simulado | Política real de autoplay não exercitada |
| `C-mudo-silencia` instável no roteiro original | Mede logo após o clique. Com espera de 800 ms, passou em todas as rodadas |
| Erro de criação de sala persiste ao navegar | Vem do controlador, inalterado. Some na próxima ação |
| Sem cobertura de navegador no CI | Roteiros seguem locais |
| Riscos da P05 | Ver `P05-SOUNDBOARD.md`, seção 6 |

## 4. Operações que exigem autorização explícita

| Operação | Efeito |
|---|---|
| Push de `feat/midnight-ui` | Cria uma prévia automática na Vercel. Sem efeito em produção |
| Abrir o PR | Dispara o CI. Sem efeito em produção |
| Merge do PR | **Publica em produção, sozinho e em seguida** |
| Rollback na Vercel ou revert | Muda o que está no ar |
| Alterar variáveis, secrets ou regras | Vercel, Supabase ou GitHub. Nada disso é necessário aqui |
| Baselines S2, S3 e S4 | Exigem medição em produção e commit próprio. Não dependem desta integração |

## 5. Sequência recomendada

1. **Push** da branch, sem force, com autorização.
2. **PR em rascunho** contra `main`, com aviso de não fazer merge.
3. **CI** no commit final; **revisão** do diff e das capturas.
4. **Pré-merge:** PR sem conflitos, sem novos commits em `main` que mudem a análise, e id de rollback anotado.
5. **Merge**, com autorização, por squash, única opção permitida. Escolher um momento sem chamadas em andamento.
6. **Conferência:** deployment `READY`, com o commit do merge, e checagem manual da seção 7.
7. **Registro:** atualizar o estado deste documento e do README em commit próprio.

## 6. Como funciona a publicação

**O que dispara o quê**, conforme o histórico do projeto e os workflows:

| Evento | CI (GitHub Actions) | Vercel |
|---|---|---|
| Push em branch | Não, exceto as branches próprias das POCs | Prévia automática |
| PR aberto ou atualizado contra `main` | Sim | Prévia do novo commit |
| Merge na `main` | Não há workflow em push na `main` | **Produção automática** |

Os workflows não publicam: não têm passo de deploy. Quem publica é a integração Git da Vercel. **Abrir um PR não publica o cliente.**

**Regras ativas na `main`** (conjunto "Protect main", leitura pública da API):
- Exigem PR, com merge só por squash e conversas resolvidas.
- Exigem assinatura e histórico linear, e impedem exclusão e force-push.
- Pedem **0 aprovações**: o autor consegue fazer o merge sozinho.
- **Não exigem status do CI:** o merge é possível com CI vermelho ou ainda em execução.

**Não verificado** (exige acesso autenticado): quem pode ignorar as regras, opção "Ignored Build Step" e a branch de produção no painel. O histórico mostra produção só a partir da `main`.

**Limites da prévia da Vercel:**
- As variáveis `VITE_SUPABASE_*` valem só para o ambiente de produção. Numa prévia existente, o build saiu sem URL nem chave (`connect-src 'self'`).
- Pelo código, a página mostra "Configuração inválida" e **não oferece login**. Não abri em navegador; a conclusão vem do build publicado e de `config.ts`.
- A origem da prévia recebe 403 nas Edge Functions, por não estar em `ORYN_ALLOWED_ORIGINS`.
- **Logo, a prévia não valida login, salas, chat, voz nem sons.** Prova só que o build passa e entrega a página. Isso não deve mudar sem decisão própria: variáveis de produção nas prévias apontariam prévias para o banco real.

**Validação antes do merge:** stack local e CI. Voz real só depois da publicação.

## 7. Conferência depois da publicação e reversão

**Checagem manual, sem bateria remota, em uma sala de teste:**
- [ ] Login e saída da conta.
- [ ] Barra lateral, abrir sala e criar ou convidar, se necessário.
- [ ] Dois participantes em chamada: ouvem-se, mudo funciona e a barra acompanha a navegação.
- [ ] Chat e membros abrem; sons tocam.
- [ ] Em 360 px: menu e barra da chamada utilizáveis.

**Critério para reverter:** não conseguir entrar, chamada ou áudio quebrados, ou página sem iniciar.

**Reversão, com autorização, sem mudança de backend:**
1. **Imediata:** rollback da Vercel para o deployment anterior, pelo painel ou `vercel rollback`. Só troca o que está no ar. Atenção: a documentação indica que a atribuição automática de domínio fica desligada depois; **um merge seguinte não entra no ar até um `vercel promote`**. Em plano Hobby, só para o deployment imediatamente anterior.
2. **Definitiva:** PR de revert do squash na `main`, sem force-push. O merge dele publica de novo.

Um build em andamento pode ser cancelado no painel, antes de entrar no ar.
