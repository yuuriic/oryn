// Somente stack descartável local. Não lê .env, não usa chave secreta nem escreve no remoto.
// Dependência opcional de teste: ORYN_PLAYWRIGHT_MODULE = caminho absoluto para playwright/index.mjs.
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import pg from 'pg';

const base = 'http://127.0.0.1:5173';
const api = 'http://127.0.0.1:54321';
const key = process.env.ORYN_LOCAL_PUBLIC_KEY;
assert.match(key ?? '', /^sb_publishable_/);
assert.ok(process.env.ORYN_PLAYWRIGHT_MODULE, 'Indique a instalação local de Playwright');
const { chromium } = await import(pathToFileURL(process.env.ORYN_PLAYWRIGHT_MODULE).href);
const db = new pg.Pool({ host: '127.0.0.1', port: 54322, user: 'postgres', password: process.env.ORYN_LOCAL_DB_PASSWORD, database: 'postgres' });
const dir = resolve('integration/evidence/profile-display-name');
await mkdir(dir, { recursive: true });
const results = [];
function check(label, condition) { assert.ok(condition, label); results.push({ label, ok: true }); console.log(`PASS ${label}`); }
const run = Date.now().toString(36);
const emailA = `profile-a-${run}@example.test`;
const emailB = `profile-b-${run}@example.test`;
const password = `LocalOnly-${run}!42`;
const errors = [];
const diagnostics = [];
const dist = resolve('dist');
const builtHtml = await readFile(resolve(dist, 'index.html'), 'utf8');
assert.ok(builtHtml.includes("http://127.0.0.1:54321"), 'Build precisa apontar somente para a stack local');
const hosting = JSON.parse(await readFile('vercel.json', 'utf8'));
const headers = Object.fromEntries(hosting.headers[0].headers.map((h) => [h.key, h.value]));
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--disable-features=LocalNetworkAccessChecks'] });
const contexts = [];
async function page(width = 1440, height = 1000) {
  const context = await browser.newContext({ viewport: { width, height }, permissions: ['microphone'] });
  contexts.push(context);
  await context.route('**/*', async (route) => {
    const u = new URL(route.request().url());
    // Serve os bytes do build atual na origem local permitida, sem substituir o
    // preview antigo do usuário que já ocupa 5173. APIs e WebRTC continuam reais.
    if (u.origin === base) {
      const file = resolve(dist, `.${u.pathname === '/' ? '/index.html' : decodeURIComponent(u.pathname)}`);
      assert.ok(file.startsWith(`${dist}\\`) || file.startsWith(`${dist}/`));
      const contentType = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
      try { return await route.fulfill({ body: await readFile(file), contentType, headers }); }
      catch { return await route.fulfill({ status: 404 }); }
    }
    return ['127.0.0.1', 'localhost'].includes(u.hostname) ? route.continue() : route.abort();
  });
  await context.addInitScript(() => {
    window.__pcs = [];
    window.__offers = 0;
    window.__sounds = 0;
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args) { window.__sounds += 1; return start.apply(this, args); };
    const Native = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends Native {
      constructor(...args) { super(...args); window.__pcs.push(this); }
      createOffer(...args) { window.__offers += 1; return super.createOffer(...args); }
    };
  });
  const p = await context.newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error') diagnostics.push(m.text().replace(/sb_publishable_[\w-]+/g, '[public-key]')); });
  p.on('response', (r) => { if (r.status() >= 400) diagnostics.push(`${r.status()} ${new URL(r.url()).pathname}`); });
  await p.goto(base);
  return p;
}
async function login(p, email) {
  await p.locator('#email').fill(email); await p.locator('#password').fill(password);
  await p.locator('#login-btn').click(); await p.locator('#account').waitFor({ state: 'visible' });
}
async function profile(p, name) {
  await p.locator('#profile-open-btn').click();
  await p.locator('#profile-name').fill(name);
  await p.locator('#profile-save-btn').click();
  await p.locator('#profile-status').filter({ hasText: 'Nome salvo' }).waitFor();
  await p.locator('#profile-close-btn').click();
}
const settle = async (fn, message, timeout = 40000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await new Promise((r) => setTimeout(r, 200)); }
  throw new Error(message);
};
try {
  const a = await page();
  await a.locator('#signup-open-btn').click();
  await a.locator('#signup-name').fill('  Aurora  Local  ');
  await a.locator('#signup-email').fill(emailA);
  await a.locator('#signup-password').fill(password);
  await a.screenshot({ path: resolve(dir, 'P01-cadastro-desktop.png') });
  await a.locator('#signup-btn').click();
  await a.locator('#account').waitFor({ state: 'visible' });
  check('Cadastro real local normaliza e exibe nome global', (await a.locator('#user-label').textContent()) === 'Aurora Local');
  const userA = (await db.query('select id from auth.users where email=$1', [emailA])).rows[0].id;
  await db.query('insert into oryn.creator_grants(user_id,max_open_rooms) values($1,5)', [userA]);
  const signupB = await fetch(`${api}/auth/v1/signup`, { method: 'POST', headers: { apikey: key, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: emailB, password, data: { display_name: 'Boreal Local' } }) });
  check('Segunda conta real criada', signupB.ok);
  const authB = await signupB.json();
  const spoof = await fetch(`${api}/auth/v1/user`, { method: 'PUT', headers: { apikey: key, Authorization: `Bearer ${authB.access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: userA, data: { display_name: 'Boreal Local', role: 'owner' } }) });
  check('Auth não permite redirecionar edição para outra identidade', spoof.ok && (await db.query('select raw_user_meta_data->>\'display_name\' as name from auth.users where id=$1', [userA])).rows[0].name === 'Aurora Local');
  const invalid = await fetch(`${api}/auth/v1/user`, { method: 'PUT', headers: { apikey: key, Authorization: `Bearer ${authB.access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ data: { display_name: 'x'.repeat(33) } }) });
  check('Auth real recusa nome longo mesmo sem formulário', !invalid.ok);
  await a.reload(); await a.locator('#account').waitFor({ state: 'visible' });
  check('Recarga restaura nome da conta', (await a.locator('#user-label').textContent()) === 'Aurora Local');
  const second = await page(); await login(second, emailA);
  check('Outro dispositivo lê o nome persistido', (await second.locator('#user-label').textContent()) === 'Aurora Local');
  const roomName = `Identidade ${run}`;
  await a.locator('#create-open-btn').click();
  await a.locator('#create-name').fill(roomName);
  check('Criação reutiliza nome global, sem edição por sala', await a.locator('#create-display').inputValue() === 'Aurora Local' && await a.locator('#create-display').getAttribute('readonly') !== null);
  await a.locator('#create-capacity').selectOption('4');
  await a.locator('#create-btn').click();
  await a.locator('#context-title').filter({ hasText: roomName }).waitFor();
  await a.locator('#context-actions .room-chat').click();
  await a.locator('#context-actions .room-join').click();
  await a.locator('#call-bar').waitFor({ state: 'visible' });
  await a.locator('.room-admin summary').click();
  await a.locator('#context-actions .room-invite').click();
  await settle(async () => (await a.locator('#invite-link').inputValue()).includes('#convite='), 'Convite não gerado');
  const invite = await a.locator('#invite-link').inputValue();
  await a.locator('#invite-close-btn').click();
  const b = await page(); await login(b, emailB); await b.goto(invite);
  await b.locator('#invite-accept-pending').waitFor({ state: 'visible' });
  check('Convite reutiliza o nome da conta', (await b.locator('#invite-display').inputValue()) === 'Boreal Local');
  await b.locator('#invite-accept-btn').click();
  await b.locator('#invite-dismiss-btn').waitFor({ state: 'visible' }); await b.locator('#invite-dismiss-btn').click();
  await b.getByRole('button', { name: new RegExp(`^${roomName},`) }).click();
  await b.locator('#context-actions .room-chat').click();
  await b.locator('#context-actions .room-join').click();
  await settle(async () => await a.locator('#participants [data-state="connected"]').count() === 1 && await b.locator('#participants [data-state="connected"]').count() === 1, 'Áudio não conectou');
  await a.locator('#chat-input').fill('Mensagem antes do nome'); await a.locator('#chat-send-btn').click();
  await b.locator('#chat-messages').getByText('Mensagem antes do nome').waitFor();
  await a.locator('#mute-btn').click();
  check('Mudo real antes da edição', await a.evaluate(() => window.__pcs.every((pc) => pc.getSenders().filter((s) => s.track?.kind === 'audio').every((s) => !s.track.enabled))));
  const pcs = await a.evaluate(() => ({ count: window.__pcs.length, offers: window.__offers }));
  let release;
  const hold = new Promise((r) => { release = r; });
  await a.route('**/rest/v1/rpc/send_room_message', async (route) => { await hold; await route.continue(); });
  await a.locator('#chat-input').fill('Envio pendente preservado'); await a.locator('#chat-send-btn').click();
  await a.locator('#chat-input').fill('Rascunho preservado');
  await profile(a, '  Aurora   Nova  ');
  check('Renomeação mantém mensagem pendente', await a.locator('.chat-pending').count() === 1);
  check('Renomeação mantém rascunho', await a.locator('#chat-input').inputValue() === 'Rascunho preservado');
  release();
  await settle(async () => await a.locator('.chat-pending').count() === 0, 'Envio não confirmado');
  await a.unroute('**/rest/v1/rpc/send_room_message');
  await b.locator('#chat-messages').getByText('Envio pendente preservado').waitFor();
  await settle(async () => (await b.locator('#chat-messages strong').allTextContents()).every((s) => s === 'Aurora Nova'), 'Nomes antigos no histórico');
  await settle(async () => (await b.locator('#participants').textContent()).includes('Aurora Nova'), 'Nome antigo na chamada');
  check('Outro participante recebe novo nome sem entrar novamente', true);
  await settle(async () => await second.locator('#user-label').textContent() === 'Aurora Nova', 'Outro dispositivo não atualizou o perfil');
  check('Perfil converge em outro dispositivo já autenticado', true);
  await second.reload(); await second.locator('#account').waitFor({ state: 'visible' });
  check('Recarga em outro dispositivo usa metadados atuais', (await second.locator('#user-label').textContent()) === 'Aurora Nova');
  await second.locator('#logout-btn').click();
  check('Nenhum PC ou oferta criado durante a renomeação', JSON.stringify(pcs) === JSON.stringify(await a.evaluate(() => ({ count: window.__pcs.length, offers: window.__offers }))));
  check('Mudo continua ativo após salvar', await a.evaluate(() => window.__pcs.every((pc) => pc.getSenders().filter((s) => s.track?.kind === 'audio').every((s) => !s.track.enabled))));
  await a.locator('#mute-btn').click();
  check('Microfone reativável sem reconexão', await a.evaluate(() => window.__pcs.every((pc) => pc.getSenders().filter((s) => s.track?.kind === 'audio').every((s) => s.track.enabled))));
  const received = await b.evaluate(async () => {
    let bytes = 0;
    for (const pc of window.__pcs) (await pc.getStats()).forEach((s) => { if (s.type === 'inbound-rtp' && s.kind === 'audio') bytes += s.bytesReceived ?? 0; });
    return bytes;
  });
  await settle(async () => await b.evaluate(async (before) => {
    let bytes = 0;
    for (const pc of window.__pcs) (await pc.getStats()).forEach((s) => { if (s.type === 'inbound-rtp' && s.kind === 'audio') bytes += s.bytesReceived ?? 0; });
    return bytes > before;
  }, received), 'Áudio parou depois da atualização');
  check('Pacotes de áudio continuam após renomear e reativar microfone', true);
  await a.locator('#profile-open-btn').click();
  await a.screenshot({ path: resolve(dir, 'P02-perfil-desktop-em-chamada.png') });
  await a.locator('#profile-close-btn').click();
  await a.locator('#sound-toggle-btn').click();
  check('Soundboard continua disponível', await a.locator('#soundboard').isVisible());
  const wav = Buffer.alloc(44 + 4410 * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(44100, 24); wav.writeUInt32LE(88200, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  for (let i = 0; i < 4410; i++) wav.writeInt16LE(Math.round(2000 * Math.sin(2 * Math.PI * 440 * i / 44100)), 44 + i * 2);
  await a.locator('#sound-form summary').click();
  await a.locator('#sound-name').fill('Sinal local');
  await a.locator('#sound-file').setInputFiles({ name: 'sinal.wav', mimeType: 'audio/wav', buffer: wav });
  await a.locator('#sound-publish-btn').click();
  await settle(async () => await a.locator('.sound-play:not([disabled])').count() === 1, 'Som não foi validado');
  const starts = await b.evaluate(() => window.__sounds);
  await a.locator('.sound-play').click();
  await settle(async () => (await b.evaluate(() => window.__sounds)) > starts, 'Som não reproduziu no outro participante');
  check('Soundboard publica, valida e reproduz remotamente após renomeação', true);
  await a.locator('#sound-close-btn').click();
  await a.setViewportSize({ width: 360, height: 780 });
  await a.locator('#shell-menu-btn').click(); await a.locator('#profile-open-btn').click();
  check('Perfil mobile acessível fora do drawer', await a.locator('#profile-panel').isVisible());
  check('Perfil mobile cabe na janela', await a.locator('#profile-panel').evaluate((el) => el.getBoundingClientRect().right <= innerWidth && el.getBoundingClientRect().left >= 0));
  await a.waitForTimeout(250); // termina apenas a animação do drawer para a captura
  await a.screenshot({ path: resolve(dir, 'P03-perfil-mobile.png') });
  await a.locator('#profile-close-btn').click();
  await a.locator('#leave-btn').click(); await b.locator('#leave-btn').click();
  await a.locator('#shell-menu-btn').click(); await a.locator('#logout-btn').click();
  await login(a, emailA);
  check('Logout/login conserva o novo nome', (await a.locator('#user-label').textContent()) === 'Aurora Nova');
  await a.locator('#shell-menu-btn').click();
  await a.locator('#logout-btn').click();
  // Conta legada: tirar metadados só é permitido antes da adoção do nome global.
  const legacy = `legacy-${run}@example.test`;
  await fetch(`${api}/auth/v1/signup`, { method: 'POST', headers: { apikey: key, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: legacy, password }) });
  await b.locator('#logout-btn').click();
  await login(b, legacy);
  check('Conta legada continua acessível sem nome global', (await b.locator('#user-label').textContent()) === legacy);
  await profile(b, 'Legado Adotado');
  check('Conta legada adota nome pelo perfil', (await b.locator('#user-label').textContent()) === 'Legado Adotado');
  check('Sem erros de página', errors.length === 0);
} finally {
  for (const c of contexts) for (const p of c.pages()) {
    const status = await p.locator('#signup-status').textContent().catch(() => '');
    if (status) diagnostics.push(status);
  }
  await writeFile(resolve(dir, 'browser-results.json'), JSON.stringify({ localOnly: true, results, pageErrors: errors.length, diagnostics }, null, 2));
  await browser.close(); await db.end();
}
console.log(JSON.stringify({ passed: results.length, evidence: 'integration/evidence/profile-display-name/' }));
