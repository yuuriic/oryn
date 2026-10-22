# POC-02A — Áudio WebRTC bidirecional PC ↔ celular (LAN)

Prova de conceito **descartável** do Oryn. Valida uma chamada de áudio WebRTC real, nos dois sentidos, entre o
navegador do computador Windows e o navegador do celular, na mesma rede local. Não é base de código do produto.

## Arquitetura

```text
           PC (Windows)                                        Celular (mesma Wi-Fi)
 ┌──────────────────────────────┐                     ┌──────────────────────────────┐
 │ Navegador A                  │                     │ Navegador B                  │
 │ http://localhost:5180        │                     │ https://<IP-DA-LAN>:5443     │
 │  (localhost = contexto       │                     │  (CA local instalada pelo    │
 │   seguro, sem certificado)   │                     │   usuário)                   │
 └──────┬───────────────────────┘                     └───────────┬──────────────────┘
        │ ws://localhost:5180/ws                    wss://<IP>:5443/ws │
        ▼                                                             ▼
 ┌────────────────────────────────────────────────────────────────────────────┐
 │ Servidor Node (server/): estáticos + sinalização. NÃO processa mídia.      │
 │  HTTP só em 127.0.0.1 · HTTPS/WSS só no IP da LAN · Origin obrigatório     │
 │  sessões de no máx. 2 participantes · offer/answer/candidate validados     │
 └────────────────────────────────────────────────────────────────────────────┘
        ▲                                                             ▲
        └──────── áudio Opus, WebRTC (DTLS-SRTP) direto entre os aparelhos ────┘
                         (ICE host, sem STUN/TURN; não passa pelo servidor)
```

- **Uma `RTCPeerConnection` por cliente.** Quem ocupa a vaga de *host* cria a offer; o *guest* responde.
- **Ordem e consistência:**
  - cada par formado recebe um `epoch`, e sinais de epochs antigos são descartados (cliente e servidor);
  - o servidor só aceita `offer` do host e `answer` do guest;
  - candidatos que chegam antes da descrição remota ficam em fila.
- **Opus preferido** via `setCodecPreferences`.
- **Mute** por `track.enabled`, sem renegociar.
- **Encerrar** libera tracks, conexão, sinalização, `<audio>` e timers. Se o outro lado sair, o par é desfeito e
  a sessão continua aguardando um novo participante.

## Requisitos

- Windows 10/11 com Node 24+ e pnpm 12+.
- OpenSSL: o do Git for Windows já serve, porque o script o encontra sozinho. Também dá para indicar o caminho em
  `ORYN_OPENSSL`.
- Celular Android (Chrome) ou iPhone (Safari) **na mesma rede** que o PC. Redes de visitante ou com "isolamento de
  clientes" bloqueiam a comunicação entre aparelhos.

## Passo a passo

### 1. Instalar e compilar

```powershell
cd "C:\Dev\Projeto - Oryn\poc\webrtc-audio-lan"
pnpm install
pnpm build
```

### 2. Descobrir o IP da LAN

```powershell
pnpm certs
```

Sem `--ip`, o comando **não gera nada**: apenas lista os IPv4 privados do PC. Escolha o da interface Wi-Fi ou
Ethernet que está na mesma rede do celular. Evite adaptadores virtuais, como VirtualBox, Hyper-V ou VPN.

### 3. Gerar os certificados (somente no PC, nada é instalado)

```powershell
pnpm certs --ip=<IP-DA-LAN>
```

- Cria, em `%LOCALAPPDATA%\oryn-poc-lan\certs\` (**fora do repositório**), uma CA local e um certificado de
  servidor para esse IP, válidos por 30 dias.
- A CA tem `nameConstraints`: só pode certificar `<IP-DA-LAN>` e `localhost`. Mesmo que vaze, não serve para
  falsificar outros sites.
- A chave privada da CA é **apagada** logo após a emissão.
- O comando mostra o **SHA-256 da CA**. Anote-o para conferir no celular.
- Se o IP do PC mudar (DHCP), gere de novo com `--force` e reinstale a nova CA no celular.

### 4. Instalar a CA no celular — **alteração de confiança que só você pode autorizar**

Instalar uma CA faz o celular confiar nos certificados que ela emitir. Aqui ela está restrita ao IP do PC, dura
30 dias e não tem mais a chave privada, mas **a decisão é sua**. O agente não instala nada em nenhum aparelho.

**Levar o arquivo `oryn-poc-ca.crt` (só a parte pública) até o celular.** Escolha uma das opções:

- **Cabo USB** (recomendado): copie `%LOCALAPPDATA%\oryn-poc-lan\certs\oryn-poc-ca.crt` para o aparelho.
- **Download temporário pela rede**: `pnpm share-ca --ip=<IP-DA-LAN>` serve o arquivo por HTTP durante 5 min.
  Como é HTTP, alguém na mesma rede poderia trocar o arquivo; por isso a **conferência do SHA-256 abaixo é
  obrigatória**.

**Android (Chrome).** Os nomes dos menus variam por fabricante.
1. Configurações → Segurança e privacidade → Mais configurações de segurança → Criptografia e credenciais →
   **Instalar um certificado** → **Certificado de CA**.
2. O Android mostra um aviso sobre instalar uma CA. É o aviso do sistema sobre essa alteração de confiança, não
   um erro de TLS a ser ignorado. Prossiga só se concordar.
3. Selecione `oryn-poc-ca.crt`.
4. Confira o SHA-256 em Criptografia e credenciais → Credenciais confiáveis → **Usuário** → "Oryn POC-02A Local CA".

**iPhone (Safari).**
1. Abra o arquivo no Safari → "Perfil transferido".
2. Ajustes → Geral → VPN e Gerenciamento de Dispositivos → instale o perfil.
3. Ajustes → Geral → Sobre → **Ajustes de Confiança de Certificados** → ative a confiança total para
   "Oryn POC-02A Local CA".
4. Confira o SHA-256 nos detalhes do perfil.

**Se o SHA-256 for diferente do mostrado no PC, remova o certificado e não continue.**

### 5. Iniciar o servidor

```powershell
pnpm serve --ip=<IP-DA-LAN>
```

- Escuta em `http://localhost:5180`, só para este PC, e em `https://<IP-DA-LAN>:5443`, para o celular.
- Na primeira execução, o **Firewall do Windows** pode perguntar se o Node pode aceitar conexões. Permita apenas
  em **redes privadas**. O agente não altera o firewall.
- Para testar só no PC, sem celular: `pnpm serve --no-https`.

### 6. Fazer a chamada

1. **Coloque fones de ouvido nos dois aparelhos.**
2. PC: abra `http://localhost:5180` → **Criar sessão**. Aparecem um QR code e o link `https://<IP>:5443/#s=…`.
3. Celular: leia o QR code ou digite o link. A página deve abrir **sem aviso de certificado**; se aparecer um
   aviso, pare e revise os passos 3 e 4. Toque em **Entrar**.
4. Permita o microfone nos dois aparelhos.
5. Quando o estado for "conectado — áudio nos dois sentidos", ligue **Ouvir participante** nos dois.

### 7. Remover a CA depois do teste

- **Android:** Criptografia e credenciais → Credenciais do usuário (ou Credenciais confiáveis → Usuário) → remover.
- **iPhone:** Ajustes → Geral → VPN e Gerenciamento de Dispositivos → perfil → Remover.
- **PC:** apague `%LOCALAPPDATA%\oryn-poc-lan\`.

## Comandos

| Comando | O que faz |
|---|---|
| `pnpm build` | Typecheck + build do frontend em `dist/` |
| `pnpm typecheck` | `tsc --noEmit` (frontend, servidor e testes) |
| `pnpm test` | Testes unitários e de integração: protocolo, sessões, servidor real, TLS com OpenSSL, negociação simulada |
| `pnpm certs --ip=<IP>` | Gera a CA local e o certificado do servidor (`--force` para substituir, `--days=1..90`) |
| `pnpm share-ca --ip=<IP>` | Serve `oryn-poc-ca.crt` por HTTP por 5 min (confira o SHA-256) |
| `pnpm serve --ip=<IP>` | Inicia o servidor (requer `pnpm build`). `--no-https` para só PC |
| `pnpm start --ip=<IP>` | Build + servidor |
| `pnpm e2e` | Dois navegadores reais no PC (Chrome ↔ Edge) com microfone falso, via `http://localhost` |

## Segurança e privacidade

- **O servidor não transporta mídia.** Aceita só mensagens JSON de texto, de até 16 KiB. Mensagem binária é
  recusada e a conexão, fechada.
- **Sessões:**
  - ID de 128 bits aleatórios;
  - no máximo 2 participantes e 20 sessões;
  - expiração após 10 min sozinho na sessão.
- **Controle de abuso:** rate limit por conexão e heartbeat a cada 15 s.
- **Origens:** o WebSocket exige `Origin` exato (o próprio site). Páginas de outros sites não usam a sinalização.
- **Cabeçalhos HTTP:**
  - CSP restritiva (`default-src 'self'`, `frame-ancestors 'none'`), `nosniff`, `no-referrer`;
  - `Permissions-Policy` limitando o microfone ao próprio site;
  - só GET/HEAD, e só arquivos do build são servidos.
- **Logs:** nenhum lado registra SDP, candidatos, credenciais ICE, IPs ou o ID completo da sessão.
- **Convite:** o código da sessão vai no fragmento da URL (`#s=…`), que não chega ao servidor nem ao Referer, e é
  removido da barra de endereço.
- **Sem gravação**, sem credenciais e sem dados persistidos (exceto os certificados, fora do repositório).
