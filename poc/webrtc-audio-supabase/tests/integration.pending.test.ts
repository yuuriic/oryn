// NOT VERIFIED — testes que SÓ podem ser comprovados com um projeto Supabase real (02C.1B, mediante
// autorização). Registrados como `todo` para que apareçam como pendentes no relatório do Vitest e NUNCA
// sejam confundidos com aprovação. Nenhum deles é simulado aqui.
import { describe, it } from 'vitest';

describe('NOT VERIFIED — Supabase real (02C.1B)', () => {
  it.todo('migrações aplicam no Postgres do Supabase (versão do projeto, não a 18 do PGlite) sem erros');
  it.todo('privilégios padrão reais do Supabase coincidem com o shim e são neutralizados pelas migrações');
  it.todo('Data API não expõe os schemas oryn e realtime (chamar oryn.* ou realtime.send pela API → recusado)');
  it.todo('RPCs via PostgREST: anon recusado; mensagem de erro do Postgres chega como código curto');
  it.todo('Auth anônimo + Cloudflare Turnstile: cadastro sem desafio é recusado; limite de 30/h por IP');
  it.todo('canal privado: assinar o próprio tópico oryn:s:{sessão} funciona; o de outra sessão/sala é recusado');
  it.todo('"Allow public access" desligado: canal sem private:true é recusado');
  it.todo('cliente NÃO envia Broadcast em tópico oryn:* nem pelo WebSocket nem pelo REST com o próprio JWT');
  it.todo('Broadcast REST com a chave secreta entrega só a quem tem SELECT no tópico privado');
  it.todo('Broadcast REST NÃO persiste em realtime.messages e não aparece no Broadcast Replay (portão de S2)');
  it.todo('realtime.send dos eventos de controle chega ao destinatário (e fica retido 72 h–4 dias, como documentado)');
  it.todo('sessão revogada com assinatura em cache: não recebe nada novo; ao renovar o JWT a assinatura cai');
  it.todo('Edge Function signal ponta a ponta: 202/200/4xx/503 conforme o contrato; latência p95 ≤ 500 ms');
  it.todo('Edge Function: chave secreta só como secret; nada de payload, JWT ou IDs completos nos logs');
  it.todo('resgate SIMULTÂNEO do mesmo convite por duas conexões: exatamente um sucesso (PGlite tem uma conexão só)');
  // Acrescentados na revisão 02C.1A.1:
  it.todo('dono real das migrações (postgres do Supabase): não superusuário; tem EXECUTE em realtime.send e cria políticas em realtime.messages');
  it.todo('integração GitHub do Supabase: diretório de trabalho, branch de produção, "Deploy to production" e branching automático conferidos ANTES do primeiro push das migrações');
});
