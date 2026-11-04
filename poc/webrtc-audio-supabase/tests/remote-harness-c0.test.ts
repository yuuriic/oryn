// Evidência ESTÁTICA (02C.5B, sem rede) de que o bloco C0 do harness remoto não obtém identidades e de que as
// fases não se misturam. Lê o código-fonte do harness; não o executa.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./remote/integration.remote.test.ts', import.meta.url), 'utf8');
const start = source.indexOf('// --- C0');
const end = source.indexOf('// --- C1');
const c0 = source.slice(start, end);

describe('harness remoto: bloco C0 sem identidade', () => {
  it('o bloco C0 existe e vem antes da C1', () => {
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
  });

  // Chamadas LIVRES (helpers do harness que obtêm ou usam usuários). `anon.rpc(...)`/`.schema(...).rpc(...)` com a
  // chave publicável são permitidos: por isso o lookbehind exclui `.` antes do nome.
  it.each([
    ['newUser', /(?<![.\w])newUser\(/],
    ['signInExisting', /(?<![.\w])signInExisting\(/],
    ['acquireUser', /(?<![.\w])acquireUser\(/],
    ['sameUserClient', /(?<![.\w])sameUserClient\(/],
    ['joinRoom', /(?<![.\w])joinRoom\(/],
    ['rpc (helper com usuário)', /(?<![.\w])rpc\(/],
    ['signInAnonymously', /signInAnonymously/],
    ['signUp', /signUp\b/],
    ['signInWithPassword', /signInWithPassword/],
    ['creatorInvite', /creatorInvite/],
  ])('o bloco C0 não chama %s', (_label, pattern) => {
    // Comentários podem citar os nomes; o código não pode chamá-los.
    const code = c0.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(code).not.toMatch(pattern);
  });

  // 02C.6A: a C0-W só ASSINA. Nenhuma publicação (WebSocket, REST ou Presence), nenhum token trocado.
  it.each([
    ['send (Broadcast pelo WebSocket)', /\.send\(/],
    ['httpSend (Broadcast REST)', /httpSend/],
    ['track (Presence)', /\.track\(/],
    ['presence: true', /presence:\s*true/],
    ['setAuth', /setAuth\(/],
  ])('o bloco C0 não publica: sem %s', (_label, pattern) => {
    const code = c0.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(code).not.toMatch(pattern);
  });

  it('o helper subscribe usado pela C0-W só assina: sem send/track/httpSend e com timeout que não vira recusa', () => {
    const body = source.slice(source.indexOf('async function subscribe('), source.indexOf('const release ='));
    expect(body.length).toBeGreaterThan(200);
    expect(body).not.toMatch(/\.send\(|\.track\(|httpSend/);
    // Sem resposta do servidor em 12 s → NO_REPLY; o expectRefused só aceita CHANNEL_ERROR vindo do servidor.
    expect(body).toMatch(/setTimeout\(\(\) => finish\('NO_REPLY'\)/);
    expect(source).toMatch(/expect\(sub\.status, `\$\{label\}: estado`\)\.toBe\('CHANNEL_ERROR'\)/);
    expect(source).toMatch(/expect\(sub\.refusedByServer, [^)]*\)\.toBe\(true\)/);
  });

  // 02C.6E: cada recusa exige o MOTIVO certo. A 1ª C0-W aprovou um MissingPartition por falta disto.
  it.each([
    ['Z6', /rit\('Z6 [^']*'[\s\S]*?expectRefused\([^;]*'anon oryn privado', 'authorization'\)/],
    ['Z7', /rit\('Z7 [^']*'[\s\S]*?expectRefused\([^;]*\{ private: false \}\)[^;]*'anon público', 'private-only'\)/],
    ['Z8', /rit\('Z8 [^']*'[\s\S]*?expectRefused\([^;]*'anon privado qualquer', 'authorization'\)/],
  ])('%s exige o motivo esperado', (_z, pattern) => {
    expect(c0).toMatch(pattern);
  });

  it('C2: #7/S5 exige PrivateOnly; S6 (anon) exige Unauthorized; ninguém tolera erro de credencial', () => {
    expect(source).toMatch(/\{ private: false \}\), ctx, 'private:false', 'private-only'\)/);
    expect(source).toMatch(/subscribe\(newClient\(\), topicOf\(ownerSession\)\), ctx, 'anon', 'authorization'\)/);
    expect(source).not.toMatch(/allowCredentialError|isCredentialRefusal/);
  });

  it('expectRefused decide pelo resultado classificado e anota o veredito para o executor', () => {
    const body = source.slice(source.indexOf('async function expectRefused('), source.indexOf('/** Broadcast REST'));
    expect(body).toMatch(/refusalVerdict\(sub\.outcome, expected\)/);
    expect(body).toMatch(/\[motivo=\$\{sub\.outcome\}; esperado=\$\{expected\}; veredito=\$\{verdict\}\]/);
    expect(body).toMatch(/expect\(sub\.outcome, `[^`]*`\)\.toBe\(expected\)/);
    // O resultado é classificado a partir do texto BRUTO do servidor, não do sanitizado/truncado.
    expect(source).toMatch(/rawReason = serverReason\(err\)/);
    expect(source).toMatch(/result\.outcome = joinOutcome\(status, result\.refusedByServer, rawReason\)/);
  });

  it('autocontrole: o padrão do helper `rpc(` reprovaria uma chamada livre e aceita `anon.rpc(`', () => {
    expect('await rpc(user, "x", {})').toMatch(/(?<![.\w])rpc\(/);
    expect('await anon.rpc("x", {})').not.toMatch(/(?<![.\w])rpc\(/);
  });

  it('o bloco C0 só roda na C0, e o WebSocket só com ORYN_IT_ALLOW_WS=1', () => {
    expect(c0).toMatch(/describe\.skipIf\(!isC0\)\('Supabase real — C0-R/);
    expect(c0).toMatch(/describe\.skipIf\(!isC0Ws\)\('Supabase real — C0-W/);
    expect(source).toMatch(/const isC0Ws = isC0 && env\.allowWebSocket;/);
  });

  it('o Z5 (Broadcast REST) está desabilitado nesta implementação', () => {
    expect(c0).toMatch(/it\.todo\('Z5/);
    expect(c0).not.toMatch(/httpSendOutcome\(/);
  });

  it('C1 e C2 não rodam na C0 (portas de fase distintas)', () => {
    expect(source).toMatch(/describe\.skipIf\(!isC1\)/);
    expect(source).toMatch(/describe\.skipIf\(!hasRoomSetup\)/);
    expect(source).toMatch(/const hasRoomSetup = gate\.enabled && env\.phase === 'C2'/);
  });

  it('cadastro e login usam contadores SEPARADOS', () => {
    expect(source).toMatch(/new IdentityBudget\([^)]*identityBudget[^)]*'cadastro'\)/);
    expect(source).toMatch(/new IdentityBudget\([^)]*loginBudget[^)]*'login'\)/);
    expect(source).toMatch(/async function newUser[\s\S]*?identities\.reserve\(\)/);
    expect(source).toMatch(/async function signInExisting[\s\S]*?logins\.reserve\(\)/);
  });
});
