// Cliente web (02C, integração): configuração com SÓ a chave publicável e garantias estáticas de segurança
// do frontend (nada de chave secreta, anônimo, Broadcast do cliente ou credencial persistida no navegador).
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
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
    expect(c).toEqual({ supabaseUrl: URL_OK, publishableKey: KEY_OK, defaultRoomId: '0c2a0000-0000-4000-8000-000000000001', iceServers: [{ urls: DEFAULT_STUN }] });
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

  it('sem chave secreta, sem anônimo/cadastro, sem credencial persistida no navegador', () => {
    for (const [f, t] of Object.entries(web)) {
      const c = code(t);
      if (f !== 'config.ts') expect(c, f).not.toMatch(/sb_secret_|service_role|sbp_/);
      expect(c, f).not.toMatch(/signInAnonymously|signUp\(|localStorage|sessionStorage|indexedDB/);
    }
    expect(code(web['main.ts']!)).toMatch(/persistSession: false/);
    expect(code(web['main.ts']!)).toMatch(/signInWithPassword/);
  });

  it('a página tem CSP restrita (sem inline nem eval) e só fala com o projeto Supabase', () => {
    const html = read('index.html');
    const csp = /Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1] ?? '';
    expect(csp).toMatch(/script-src 'self'/);
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|(^|\s)\*(\s|;|$)|\shttps?:(\s|;)/); // sem origem * nem esquema inteiro
    expect(csp).toMatch(/connect-src 'self' https:\/\/\*\.supabase\.co wss:\/\/\*\.supabase\.co/);
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
