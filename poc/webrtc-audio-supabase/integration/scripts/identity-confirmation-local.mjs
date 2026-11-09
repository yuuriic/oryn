// Confirmação real de cadastro: GoTrue descartável + SMTP de teste, todos locais.
// Credenciais da stack local ficam só no ambiente dos processos, nunca nos artefatos.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
const original = JSON.parse(execFileSync('docker', ['inspect', 'supabase_auth_oryn-e2e-local'], { encoding: 'utf8' }))[0];
const config = Object.fromEntries(original.Config.Env.map((s) => { const i = s.indexOf('='); return [s.slice(0, i), s.slice(i + 1)]; }).filter(([k]) => k.startsWith('GOTRUE_') || k === 'API_EXTERNAL_URL'));
assert.ok(config.GOTRUE_DB_DATABASE_URL.includes('supabase_db_oryn-e2e-local'), 'Somente banco descartável local');
const name = `oryn-profile-confirm-${Date.now()}`;
const env = { ...process.env, ...config, GOTRUE_MAILER_AUTOCONFIRM: 'false', GOTRUE_SMTP_HOST: 'host.docker.internal', GOTRUE_SMTP_PORT: '54325', GOTRUE_SMTP_USER: '', GOTRUE_SMTP_PASS: '', GOTRUE_SMTP_ADMIN_EMAIL: 'local@example.test', GOTRUE_RATE_LIMIT_EMAIL_SENT: '100', API_EXTERNAL_URL: 'http://127.0.0.1:54324', GOTRUE_SITE_URL: 'http://127.0.0.1:5173' };
let delivered = 0;
const sockets = new Set();
const smtp = createServer((socket) => {
  sockets.add(socket); socket.on('close', () => sockets.delete(socket));
  socket.write('220 localhost ESMTP\r\n');
  let buffer = ''; let data = false;
  socket.on('data', (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\r\n')) !== -1) {
      const line = buffer.slice(0, i); buffer = buffer.slice(i + 2);
      if (data) { if (line === '.') { data = false; delivered++; socket.write('250 accepted\r\n'); } continue; }
      if (/^EHLO|^HELO/i.test(line)) socket.write('250-localhost\r\n250 OK\r\n');
      else if (/^DATA/i.test(line)) { data = true; socket.write('354 End with dot\r\n'); }
      else if (/^QUIT/i.test(line)) { socket.end('221 bye\r\n'); }
      else socket.write('250 OK\r\n');
    }
  });
});
await new Promise((r, reject) => { smtp.once('error', reject); smtp.listen(54325, '0.0.0.0', r); });
const db = new pg.Pool({ host: '127.0.0.1', port: 54322, user: 'postgres', password: process.env.ORYN_LOCAL_DB_PASSWORD, database: 'postgres' });
const dir = resolve('integration/evidence/profile-display-name'); await mkdir(dir, { recursive: true });
const results = [];
const check = (label, ok) => { assert.ok(ok, label); results.push({ label, ok: true }); console.log(`PASS ${label}`); };
let browser;
let started = false;
try {
  const flags = Object.keys(env).filter((k) => k in config || k.startsWith('GOTRUE_') || k === 'API_EXTERNAL_URL').flatMap((k) => ['--env', k]);
  execFileSync('docker', ['run', '--detach', '--name', name, '--network', 'supabase_network_oryn-e2e-local', '--publish', '127.0.0.1:54324:9999', ...flags, original.Config.Image], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  started = true;
  let ready = false;
  for (let i = 0; i < 50; i++) {
    try { ready = (await fetch('http://127.0.0.1:54324/health')).ok; } catch { /* inicializando */ }
    if (ready) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.ok(ready, 'GoTrue local não ficou pronto');
  const settings = await (await fetch('http://127.0.0.1:54324/settings')).json();
  check('Auth descartável exige confirmação', settings.mailer_autoconfirm === false);
  const { chromium } = await import(pathToFileURL(process.env.ORYN_PLAYWRIGHT_MODULE).href);
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-features=LocalNetworkAccessChecks'] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const dist = resolve('dist');
  const hosting = JSON.parse(await readFile('vercel.json', 'utf8'));
  const headers = Object.fromEntries(hosting.headers[0].headers.map((h) => [h.key, h.value]));
  await context.route('**/*', async (route) => {
    const u = new URL(route.request().url());
    assert.ok(u.hostname === '127.0.0.1', 'Requisição fora de loopback');
    if (u.origin === 'http://127.0.0.1:5173') {
      const file = resolve(dist, `.${u.pathname === '/' ? '/index.html' : u.pathname}`);
      assert.ok(file.startsWith(`${dist}\\`) || file.startsWith(`${dist}/`));
      try { return route.fulfill({ body: await readFile(file), contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html', headers }); }
      catch { return route.fulfill({ status: 404 }); }
    }
    if (u.pathname === '/auth/v1/signup') {
      const response = await route.fetch({ url: 'http://127.0.0.1:54324/signup' });
      return route.fulfill({ response });
    }
    return route.continue();
  });
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:5173'); await page.locator('#signup-open-btn').click();
  const email = `confirm-${Date.now()}@example.test`; const password = 'OnlyLocalConfirmation!42';
  await page.locator('#signup-name').fill('Confirmação Local'); await page.locator('#signup-email').fill(email); await page.locator('#signup-password').fill(password);
  await page.locator('#signup-btn').click();
  await page.locator('#signup-status').filter({ hasText: 'Confira seu e-mail' }).waitFor();
  check('UI aguarda confirmação, sem autenticar automaticamente', await page.locator('#account').isHidden());
  check('SMTP local recebeu a confirmação', delivered > 0);
  await page.screenshot({ path: resolve(dir, 'P04-confirmacao-mobile.png') });
  await page.locator('#email').fill(email); await page.locator('#password').fill(password); await page.locator('#login-btn').click();
  await page.locator('#error').filter({ hasText: 'Login recusado' }).waitFor();
  check('Login antes de confirmar é recusado pelo Auth real', await page.locator('#account').isHidden());
  const row = (await db.query('select confirmation_token from auth.users where email=$1', [email])).rows[0];
  assert.ok(row?.confirmation_token);
  // Usa o token hash só em memória. Não registra nem exporta o conteúdo do e-mail.
  const verified = await fetch('http://127.0.0.1:54324/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'signup', token_hash: row.confirmation_token }) });
  check('Confirmação real aceita o token e ativa a conta', verified.ok);
  await page.locator('#password').fill(password); await page.locator('#login-btn').click();
  await page.locator('#account').waitFor({ state: 'visible' });
  check('Login após confirmação preserva nome do cadastro', (await page.locator('#user-label').textContent()) === 'Confirmação Local');
} finally {
  await browser?.close();
  if (started) execFileSync('docker', ['rm', '--force', name], { stdio: 'pipe' });
  for (const socket of sockets) socket.destroy();
  await new Promise((r) => smtp.close(r)); await db.end();
  await writeFile(resolve(dir, 'confirmation-results.json'), JSON.stringify({ localOnly: true, results, smtpMessages: delivered, temporaryAuthRemoved: started }, null, 2));
}
console.log(JSON.stringify({ passed: results.length }));
