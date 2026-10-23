# Cloudflare Tunnel + Access + TURN: runbook da POC-02B (02B.3B, 02B.4, 02B.5)

> **Estado:** preparação offline. **Nada aqui autoriza ativar o túnel, criar DNS ou expor o servidor.**
> A ativação depende de aprovação explícita (`docs/validation/POC-02B.md` §11.8 e §13.5). Nenhum resultado das
> ferramentas (`preflight:cloudflare`, `diagnose`, `readiness`) autoriza a ativação.

## 1. Arquitetura

```text
 Navegador (Chrome PC / Safari iPhone)
   │ HTTPS/WSS  https://<HOSTNAME>   (cookie CF_Authorization, HttpOnly)
   ▼
 Borda Cloudflare ── Access: aplicação self-hosted do <HOSTNAME> inteiro, política por e-mails explícitos
   │ injeta Cf-Access-Jwt-Assertion
   ▼
 cloudflared (túnel NOMEADO, gerenciado localmente, config.yml fora do repo)
   │ valida o JWT de novo (originRequest.access); Host público preservado (sem httpHostHeader)
   │ única regra: <HOSTNAME> → http://127.0.0.1:5280 ; catch-all → http_status:404
   ▼
 Node :5280 (sinalização) ── valida o JWT de novo (02B.3A), Host/Origin, convite, limites
 Node :5281 (administrativo) ── NUNCA no túnel; só o operador neste PC (pareamento 02B.2C)
```

O JWT é validado três vezes:
1. na borda, que exige login;
2. no `cloudflared`, por `access.required`;
3. na origem Node, com JWKS e todas as claims.

O convite e o pareamento administrativo continuam como camadas independentes.

## 2. Por que túnel nomeado gerenciado localmente

| Opção | Decisão | Motivo |
|---|---|---|
| **Túnel nomeado, gerenciado localmente** (`config.yml` + arquivo de credenciais) | **Adotada** | A configuração é um arquivo que pode ser **validado offline** (`pnpm preflight:cloudflare`, `cloudflared tunnel ingress validate/rule`); nenhum token na linha de comando; suporta `originRequest.access` |
| Túnel gerenciado remotamente (painel + token) | Recusada | O ingress fica no painel, sem validação offline. `--token` aparece na linha de comando e no histórico; `--token-file` evitaria isso, mas o primeiro problema continua |
| Quick Tunnel (`trycloudflare.com`) | **Proibida** | Sem Access, com URL aleatória; não substitui a autenticação. A pré-validação recusa |

## 3. Dependências que exigem você (nenhuma foi feita)

1. Conta Cloudflare com um **domínio próprio** ativo na Cloudflare (DNS gerenciado por ela).
2. Organização **Cloudflare Zero Trust** (nome da equipe → `<equipe>.cloudflareaccess.com`).
3. `cloudflared` instalado no PC (versão atual; registrar `cloudflared --version`).
4. E-mails do operador e do convidado que entrarão na política.
5. Aprovação arquitetural para cada passo marcado **[ATIVAÇÃO]**.

## 4. Checklist de configuração

Cada item tem uma verificação. Qualquer "não" **bloqueia** a ativação.

### 4.1 Access (painel Zero Trust): só depois de aprovado

| # | Item | Verificação |
|---|---|---|
| A1 | Aplicação **Self-hosted** com o domínio = `<HOSTNAME>` exato, **sem path** (cobre `/` e `/ws`) | Print da tela da aplicação |
| A2 | Política **Allow** com **Include → Emails** listando só os e-mails autorizados. Nada de *Everyone*, domínio de e-mail ou grupos amplos | Print da política |
| A3 | Provedor de identidade: **One-time PIN** (ou outro aprovado) | Print |
| A4 | Duração da sessão **maior que a janela de teste** (ex.: 2 h) e menor que 24 h | Print |
| A5 | Cookies: **HttpOnly ligado**, **SameSite Lax**, **Binding Cookie ligado** | Print. Se o WebSocket falhar só com o Binding Cookie, registrar e decidir |
| A6 | Copiar a **Application Audience (AUD) Tag** para o arquivo de ambiente do servidor (§4.3) | A pré-validação confere com o `config.yml` |
| A7 | **WebSockets** habilitado na zona (Network → WebSockets) | Print |

### 4.2 Túnel (`cloudflared`)

| # | Item | Verificação |
|---|---|---|
| T1 | **[ATIVAÇÃO]** `cloudflared tunnel login` (gera `cert.pem` em `%USERPROFILE%\.cloudflared\`) | Arquivo fora do repositório |
| T2 | **[ATIVAÇÃO]** `cloudflared tunnel create oryn-poc-02b` (gera `<UUID>.json`, **secreto**) | UUID anotado; arquivo fora do repositório |
| T3 | Copiar `cloudflare/config.example.yml` para `%USERPROFILE%\.cloudflared\config.yml` e trocar **todos** os valores de exemplo (UUID, caminho das credenciais, hostname, `teamName`, `audTag`) | `pnpm preflight:cloudflare` (§4.4) |
| T4 | `cloudflared tunnel --config <config.yml> ingress validate` (offline) | "OK" |
| T5 | `cloudflared tunnel --config <config.yml> ingress rule https://<HOSTNAME>/ws` | Casa a regra 0 → `http://127.0.0.1:5280` |
| T6 | `cloudflared tunnel --config <config.yml> ingress rule https://outro.<DOMÍNIO>/` | Casa o catch-all → `http_status:404` |
| T7 | **[ATIVAÇÃO]** `cloudflared tunnel route dns oryn-poc-02b <HOSTNAME>`. Cria o DNS **público**; só na janela aprovada | Registro CNAME no painel |

### 4.3 Servidor Oryn

| # | Item | Verificação |
|---|---|---|
| S1 | Copiar `cloudflare/server.env.example` para um arquivo **fora do repositório** (ou `poc/webrtc-audio-wan/.env`, ignorado pelo git) e preencher | `git status` sem o arquivo |
| S2 | `ORYN_PUBLIC_HOSTNAMES=<HOSTNAME>` (um só, exato) | Pré-validação |
| S3 | `ORYN_ACCESS_MODE=required`, `ORYN_ACCESS_TEAM_DOMAIN=<equipe>.cloudflareaccess.com`, `ORYN_ACCESS_AUD=<AUD>` | Pré-validação; banner "Cloudflare Access (sinalização): OBRIGATÓRIO" |
| S4 | Iniciar com `node --env-file=<arquivo> server/index.ts` (nenhum valor na linha de comando) | Banner com o hostname e o Access |

### 4.4 Pré-validação offline (obrigatória, sem rede)

```powershell
cd "C:\Dev\Projeto - Oryn\poc\webrtc-audio-wan"
pnpm preflight:cloudflare -- --config="$env:USERPROFILE\.cloudflared\config.yml" --env-file="<arquivo de ambiente>"
```

Saída 0 = "OK". Qualquer violação lista o código da regra e **não** imprime segredos: a AUD aparece mascarada e
o segredo do túnel nunca. O validador recusa, entre outros:
- referência à porta 5281 em qualquer campo;
- regra extra ou com `path`;
- catch-all diferente de `http_status:404`;
- serviço diferente de `http://127.0.0.1:5280`;
- `httpHostHeader`, `noTLSVerify`, `proxyType`;
- `access` ausente ou com equipe/AUD divergentes;
- `loglevel` `debug`/`trace` (registrariam o JWT);
- `metrics` fora do loopback, `warp-routing`, `token`, Quick Tunnel;
- credenciais dentro do repositório ou de outro túnel;
- valores de exemplo;
- Access desligado, hostname reservado e arquivos reais versionados.

### 4.5 Prontidão consolidada (02B.5, obrigatória, sem rede)

```powershell
pnpm readiness -- --config="$env:USERPROFILE\.cloudflared\config.yml" --env-file="<arquivo de ambiente>" --json="<pasta fora do repo>\readiness.json"
```

A ferramenta junta a pré-validação (§4.4, agora com TURN), o diagnóstico local simulado (`pnpm diagnose`) e a
busca de segredos reais versionados. Os segredos vão ao `git grep` pela entrada padrão, nunca em argumentos. Os
itens do operador ficam **NOT VERIFIED**.

- **Exige:** zero FAIL.
- **NOT VERIFIED nunca vira PASS:** cada item é conferido manualmente com a evidência indicada.
- **Critérios de ativação:** checklist de 10 itens em `POC-02B.md` §13.5.

## 5. Ativação: somente após aprovação

1. §4 completo, pré-validação "OK", prontidão sem FAIL e checklist de `POC-02B.md` §13.5 assinado pelo usuário.
2. Iniciar o servidor (S4) e conferir o banner.
3. Iniciar o túnel **sem token na linha de comando**:
   `cloudflared tunnel --config "$env:USERPROFILE\.cloudflared\config.yml" run oryn-poc-02b`
   (`loglevel` `info`; nunca `--loglevel debug`).
4. Executar o protocolo do §6 **antes** de enviar qualquer convite.

## 6. Protocolo de teste real (HTTP/WebSocket)

Regras:
- **nunca** copiar, colar, fotografar ou registrar o JWT ou o cookie `CF_Authorization`;
- no DevTools, não exportar HAR nem copiar cabeçalhos;
- a evidência do handshake vem das linhas do log do servidor, que mostram só o prefixo do `kid`.

| # | Passo | Resultado esperado | Evidência |
|---|---|---|---|
| P1 | Janela anônima no PC: abrir `https://<HOSTNAME>/` | Página de login do Access, **não** a página da POC | Print |
| P2 | Fora da política: tentar logar com e-mail não autorizado | Acesso negado pelo Access | Print |
| P3 | Sem sessão: `curl -s -o NUL -w "%{http_code}" https://<HOSTNAME>/` | `302` para o login do Access (ou `403`); nunca `200` | Código |
| P4 | Sem sessão, upgrade WebSocket: `curl -s -o NUL -w "%{http_code}" -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGVzdGVvcnluMDJiMw==" -H "Origin: https://<HOSTNAME>" https://<HOSTNAME>/ws` | Nunca `101` | Código |
| P5 | Chrome (PC), e-mail autorizado: login e página carregada | Página da POC; servidor sem `access (http): …` | Log do servidor |
| P6 | Chrome: operador cria a sessão no `http://localhost:5281`; convidado no Chrome **pelo hostname** cola o convite e entra | Servidor registra `[access] upgrade WebSocket autenticado (kid …)`; chamada conecta | Linha do log (sem JWT) |
| P7 | Se P6 falhar: procurar `access (upgrade): missing` no log | Se aparecer, a borda **não** injetou o JWT no upgrade. **Parar** e decidir entre as alternativas (POC-02B §10.3). Não implementar fallback por cookie sem aprovação | Linha do log |
| P8 | iPhone (Safari, rede móvel): login no Access, entrar com **novo** convite | Mesmo resultado de P6 | Log + relato |
| P9 | Convite reutilizado ou inválido pelo hostname | "Convite inválido" | Print |
| P10 | `https://<HOSTNAME>/admin/pair` (POST pelo DevTools ou curl com sessão) | `405`; nada administrativo pelo túnel | Código |
| P11 | Logs: buscar `eyJ` (início de JWT) e e-mails nos logs do servidor e do `cloudflared` | Nenhuma ocorrência | Resultado da busca |
| P12 | Encerrar o túnel (Ctrl+C) e repetir P3 | Erro da Cloudflare (túnel indisponível), nunca a página | Código |

### 6.1 Matriz WAN R1–R8 e evidências (02B.5)

A matriz completa, com critérios objetivos, está em `docs/validation/POC-02B.md` §13.1. Para cada cenário:
1. Em cada participante, ao fim do cenário (antes ou depois de "Encerrar"), clicar em **"Copiar evidência
   (sanitizada)"** e salvar o JSON **fora do repositório**. Ex.: `R5-pc.json`, `R5-iphone.json`.
2. Preencher `audio.bidirecional` e `seguranca` (aprovado, reprovado ou não se aplica) depois de ouvir os dois
   lados e cumprir o roteiro de segurança do cenário.
3. Validar: `pnpm evidence:check -- R5-pc.json R5-iphone.json`. A saída deve ser 0, com "mesma sessão, os dois
   papéis presentes".
4. Registrar no `POC-02B.md` o status (APROVADO, REPROVADO ou INCONCLUSIVO) segundo o critério da matriz.
   **relay e TLS só são comprovados pelo par selecionado**; dados `indisponível` não contam como aprovação.

**R7 (UDP restrito):** método, prova independente e remoção das regras de firewall em `POC-02B.md` §13.6. Exige
autorização do usuário por alterar o sistema.

## 7. Rollback

**Gatilhos (qualquer um → rollback imediato):**
- página da POC servida sem login;
- qualquer operação administrativa pelo hostname;
- JWT ou e-mail em logs;
- acesso de identidade não esperada nos logs do Access;
- comportamento não previsto no §6.

| Passo | Ação | Efeito |
|---|---|---|
| R1 | Ctrl+C no `cloudflared` | **Exposição encerrada** (o hostname deixa de alcançar o PC) |
| R2 | Ctrl+C no servidor | Sessões, convites e token administrativo revogados (nada persiste) |
| R3 | Painel Zero Trust: revogar as sessões dos usuários | Cookies do Access invalidados |
| R4 | Painel DNS: remover o CNAME de `<HOSTNAME>` | Hostname deixa de existir |
| R5 | Se as credenciais vazaram: `cloudflared tunnel delete oryn-poc-02b` e apagar `<UUID>.json` | Credenciais inutilizadas |
| R6 | Registrar o ocorrido em `POC-02B.md` | Evidência |

### 7.1 Incidentes (02B.5)

Procedimento completo em `POC-02B.md` §13.7. Pontos essenciais:
- **Ordem:** Ctrl+C no `cloudflared` → "Encerrar" nas páginas e Ctrl+C no servidor → revogar sessões do Access →
  remover o DNS.
- **Revogar uma credencial TURN não encerra instantaneamente uma chamada já estabelecida:** encerre as chamadas e
  o servidor.
- **Suspeita de exposição de segredo:** identificar qual, sem copiá-lo para lugar nenhum. Depois **rotacionar**:
  - chave TURN;
  - túnel (excluir e recriar);
  - sessões do Access.

  Segredo que chegou a ser versionado é tratado como comprometido. Confirme com `pnpm readiness` (P-SECRETS PASS).
- **Confirmar o fim da exposição de fora:** do iPhone em 4G, o hostname não serve a POC; `cloudflared tunnel info`
  sem conectores.
- **Preservar** só evidências sanitizadas (`pnpm evidence:check` OK) e linhas de log sem segredos.
