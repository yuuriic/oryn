// Cliente web (02C, integração): configuração com SÓ a chave publicável e garantias estáticas de segurança
// do frontend (nada de chave secreta, anônimo, Broadcast do cliente ou credencial persistida no navegador).
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AUTH_STORAGE_KEY } from '../src/web/auth-session.ts';
import { RETURN_ROOM_KEY } from '../src/web/call-return.ts';
import { DEFAULT_STUN, WebConfigError, parseWebConfig } from '../src/web/config.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const webFiles = readdirSync(new URL('../src/web/', import.meta.url)).filter((f) => f.endsWith('.ts'));
const web = Object.fromEntries(webFiles.map((f) => [f, read(`src/web/${f}`)]));
const code = (text: string) => text.replace(/\/\/.*$/gm, ''); // sem comentários

const URL_OK = 'https://abcdefghijklmnopqrst.supabase.co';
const KEY_OK = 'sb_publishable_' + 'AbC123_x-Y';
const ok = (over: Record<string, string | undefined> = {}) => parseWebConfig({ VITE_SUPABASE_URL: URL_OK, VITE_SUPABASE_PUBLISHABLE_KEY: KEY_OK, ...over });

describe('configuração do cliente (só a chave publicável)', () => {
  it('aceita URL do projeto e chave publicável; STUN padrão sem TURN; sala opcional', () => {
    const c = ok({ VITE_ORYN_ROOM_ID: '0C2A0000-0000-4000-8000-000000000001'.toLowerCase() });
    expect(c).toEqual({ supabaseUrl: URL_OK, publishableKey: KEY_OK, defaultRoomId: '0c2a0000-0000-4000-8000-000000000001', iceServers: [{ urls: DEFAULT_STUN }], publicOrigin: null, googleAuth: 'off' });
    expect(ok({ VITE_ORYN_STUN_URLS: 'stun:stun.cloudflare.com:3478, stun:stun.l.google.com:19302' }).iceServers).toEqual([{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }]);
  });

  it('recusa chave secreta, PAT ou service_role em QUALQUER variável VITE_, sem citar o valor', () => {
    const secret = 'sb_secret_' + 'NAO-PODE-APARECER';
    for (const over of [{ VITE_SUPABASE_PUBLISHABLE_KEY: secret }, { VITE_ORYN_ROOM_ID: secret }, { VITE_QUALQUER: 'sbp_' + '0123456789abcdef' }, { VITE_X: '{"role":"service_role"}' }]) {
      let message = '';
      try {
        ok(over);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message, JSON.stringify(Object.keys(over))).toMatch(/credencial administrativa/);
      expect(message).not.toContain('NAO-PODE-APARECER');
    }
  });

  it('recusa chave legada (JWT), URL fora do formato, sala não UUID e TURN', () => {
    expect(() => ok({ VITE_SUPABASE_PUBLISHABLE_KEY: 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.x' })).toThrow(WebConfigError);
    expect(() => ok({ VITE_SUPABASE_URL: 'https://example.com' })).toThrow('VITE_SUPABASE_URL');
    expect(() => ok({ VITE_SUPABASE_URL: undefined })).toThrow('VITE_SUPABASE_URL');
    expect(() => ok({ VITE_ORYN_ROOM_ID: 'sala-1' })).toThrow('VITE_ORYN_ROOM_ID');
    expect(() => ok({ VITE_ORYN_STUN_URLS: 'turn:turn.example.com:3478' })).toThrow('só URLs stun:');
    expect(() => ok({ VITE_ORYN_STUN_URLS: 'stun:a.example,stun:b.example,stun:c.example,stun:d.example,stun:e.example' })).toThrow('no máximo 4');
  });
});

describe('garantias estáticas do frontend', () => {
  it('nenhum cliente publica no Realtime: sem httpSend, sem channel.send, sem realtime.send; sinais só pela função signal', () => {
    for (const [f, t] of Object.entries(web)) {
      expect(code(t), f).not.toMatch(/httpSend|\.send\(\s*\{\s*type:\s*'broadcast'|realtime\.send|\.track\(/);
    }
    expect(code(web['supabase-backend.ts']!)).toMatch(/functions\.invoke\('signal'/);
  });

  it('sem chave secreta/anônimo; cadastro só no módulo de identidade', () => {
    for (const [f, t] of Object.entries(web)) {
      const c = code(t);
      if (f !== 'config.ts') expect(c, f).not.toMatch(/sb_secret_|service_role|sbp_/);
      expect(c, f).not.toMatch(/signInAnonymously|document\.cookie/);
      if (f !== 'identity.ts') expect(c, f).not.toMatch(/\.signUp\(/);
      // Só o cache de sons usa IndexedDB, e guarda só áudio; ver o teste do cache.
      if (f !== 'sound-cache.ts') expect(c, f).not.toMatch(/indexedDB/);
      if (f !== 'auth-session.ts' && f !== 'session-ledger.ts' && f !== 'sound-prefs.ts') expect(c, f).not.toMatch(/localStorage/);
      if (f !== 'call-return.ts' && f !== 'session-ledger.ts') expect(c, f).not.toMatch(/sessionStorage/);
    }
    expect(code(web['main.ts']!)).toMatch(/signInWithPassword/);
  });

  it('cache e preferências de som: nada de sessão, token ou cabeçalho de autorização no armazenamento', () => {
    for (const f of ['sound-cache.ts', 'sound-prefs.ts']) {
      const c = code(web[f]!);
      expect(c, f).not.toMatch(/access_token|refresh_token|accessToken|authorization|getSession|auth-session|createSignedUrl|signedUrl/i);
      expect(c, f).not.toMatch(/sessionStorage|document\.cookie/);
    }
    expect(code(web['sound-prefs.ts']!).match(/\blocalStorage\b/g)).toHaveLength(2);
    expect(code(web['sound-prefs.ts']!)).not.toMatch(/indexedDB/);
    expect(code(web['sound-cache.ts']!)).not.toMatch(/localStorage/);
  });

  it('sessão de login: só auth-session.ts guarda, pelo Auth, com uma chave fixa e nada além disso', () => {
    const c = code(web['auth-session.ts']!);
    expect(c.match(/\blocalStorage\b/g)).toHaveLength(1);
    expect(c).toMatch(/persistSession: true/);
    expect(c).toMatch(/autoRefreshToken: true/);
    expect(c).toMatch(/detectSessionInUrl: false/);
    expect(AUTH_STORAGE_KEY).toBe('oryn.auth');
    expect(c).not.toMatch(/password/i);
  });

  it('com sessão guardada no navegador, XSS é o risco principal: nada de HTML dinâmico ou código gerado', () => {
    for (const [f, t] of Object.entries(web)) {
      expect(code(t), f).not.toMatch(/\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function\(|srcdoc/);
    }
    const html = read('index.html');
    expect(html.match(/<script\b[^>]*>/g)).toEqual(['<script type="module" src="/src/web/main.ts">']);
    // CSP da página e cabeçalhos: tests/security-headers.test.ts.
    expect(html).toMatch(/http-equiv="Content-Security-Policy"\s+content="__ORYN_PAGE_CSP__"/);
  });

  it('exceção única no navegador: call-return.ts guarda só o ID validado da sala, com uma chave fixa', () => {
    const c = code(web['call-return.ts']!);
    expect(c.match(/\bsessionStorage\b/g)).toHaveLength(1);
    expect(c.match(/\.setItem\(/g)).toHaveLength(1);
    expect(c).toMatch(/if \(!isUuid\(roomId\)\) return false;[\s\S]*\.setItem\(RETURN_ROOM_KEY, roomId\)/);
    expect(c).not.toMatch(/access_token|refresh_token|password|getSession|\bjwt\b|\btoken\b|\bemail\b/i);
    expect(RETURN_ROOM_KEY).toBe('oryn.returnRoomId');
  });

  it('configuração local fora do Git: .env.local e dist/ ignorados; .env.example versionável e sem valores', () => {
    const ignored = (p: string) => {
      try {
        execFileSync('git', ['check-ignore', '-q', p], { cwd: root });
        return true;
      } catch {
        return false;
      }
    };
    expect(ignored('.env.local')).toBe(true);
    expect(ignored('dist/index.html')).toBe(true);
    expect(ignored('.env.example')).toBe(false);
    const example = read('.env.example');
    for (const line of example.split(/\r?\n/).filter((l) => /^VITE_/.test(l))) expect(line, line).toMatch(/^VITE_[A-Z_]+=$/);
  });

  it('cópias da 02B: os módulos auxiliares são idênticos ao original (só o cabeçalho de origem)', () => {
    for (const f of ['ice.ts', 'codecs.ts', 'redact.ts', 'errors.ts', 'stats.ts']) {
      const original = readFileSync(new URL(`../../webrtc-audio-wan/src/${f}`, import.meta.url), 'utf8');
      expect(web[f]!.split('\n').slice(2).join('\n'), f).toBe(original);
    }
  });
});
