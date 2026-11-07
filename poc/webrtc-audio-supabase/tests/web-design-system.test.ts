// Oryn Midnight: a página tem o que main.ts exige ao iniciar, e os tokens cumprem o contraste aprovado.
// main.ts lança erro se um id faltar, e a página inteira deixa de iniciar. Nenhum outro teste percebe isso sem navegador.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (path: string): string => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');
const html = read('index.html');
const main = read('src/web/main.ts');
const tokens = read('src/web/styles/tokens.css');
const base = read('src/web/styles/base.css');
const login = read('src/web/styles/login.css');
const shellCss = read('src/web/styles/shell.css');
const roomsCss = read('src/web/styles/rooms.css');
const entry = read('src/web/style.css');
const allCss = [tokens, base, login, shellCss, roomsCss, entry].join('\n');

const idsIn = (text: string, pattern: RegExp): string[] => [...text.matchAll(pattern)].map((m) => m[1]!);

const token = (name: string): string => {
  const value = new RegExp(`--${name}:\\s*(#[0-9a-f]{6});`, 'i').exec(tokens)?.[1];
  if (!value) throw new Error(`token --${name} ausente`);
  return value;
};

const luminance = (hex: string): number => {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};

const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

describe('ids exigidos pela inicialização', () => {
  const required = idsIn(main, /\bel<[^>]+>\('([^']+)'\)/g);
  const present = idsIn(html, /\sid="([^"]+)"/g);

  it('a leitura de main.ts encontra os ids, inclusive os do login', () => {
    expect(required.length).toBeGreaterThan(60);
    expect(required).toEqual(expect.arrayContaining(['login', 'login-form', 'email', 'password', 'login-btn', 'account', 'error', 'status', 'audio-container']));
  });

  it('cada id exigido existe no index.html', () => {
    expect(required.filter((id) => !present.includes(id))).toEqual([]);
  });

  it('nenhum id se repete no index.html', () => {
    expect(present.filter((id, i) => present.indexOf(id) !== i)).toEqual([]);
  });

  it('cada campo de status escrito por main.ts existe', () => {
    const fields = idsIn(html, /data-field="([^"]+)"/g);
    const written = idsIn(main, /setField\('([a-z]+)'/g);
    expect(written.length).toBeGreaterThan(0);
    expect(written.filter((name) => !fields.includes(name))).toEqual([]);
  });
});

describe('experiência de login', () => {
  it('sem referência visual à POC, com o logotipo em texto', () => {
    expect(html).not.toMatch(/POC/i);
    expect(html).toMatch(/<title>Oryn<\/title>/);
    expect(html).toMatch(/<h1>Oryn<\/h1>/);
  });

  it('o formulário segue com os rótulos e o preenchimento automático do gerenciador de senhas', () => {
    expect(html).toMatch(/<label>E-mail <input id="email" type="email" autocomplete="username" required \/><\/label>/);
    expect(html).toMatch(/<label>Senha <input id="password" type="password" autocomplete="current-password" required \/><\/label>/);
    expect(html).toMatch(/<button id="login-btn" type="submit">/);
  });

  it('o erro continua anunciado e fora da seção de login, que pode estar oculta', () => {
    expect(html).toMatch(/<p id="error" class="error" role="alert" hidden><\/p>/);
    expect(html).toMatch(/<p id="config-error" class="error" role="alert" hidden><\/p>/);
  });
});

describe('estilos', () => {
  it('o atributo hidden vence qualquer display', () => {
    expect(base).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\}/);
  });

  it('foco visível e redução de movimento', () => {
    expect(base).toMatch(/:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--color-focus\)/);
    expect(base).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });

  it('sem ativo externo nem estilo em linha, que a CSP recusaria', () => {
    expect(allCss).not.toMatch(/url\(|@font-face/);
    expect(idsIn(allCss, /@import\s+'([^']+)'/g)).toEqual(['./styles/tokens.css', './styles/base.css', './styles/login.css', './styles/shell.css', './styles/rooms.css']);
    expect(html).not.toMatch(/\sstyle=|<style\b/);
  });

  it('as transições ficam na faixa aprovada', () => {
    const durations = idsIn(tokens, /--motion-[a-z]+:\s*(\d+)ms/g).map(Number);
    expect(durations.length).toBeGreaterThan(0);
    for (const ms of durations) expect(ms).toBeGreaterThanOrEqual(150);
    for (const ms of durations) expect(ms).toBeLessThanOrEqual(200);
  });
});

describe('tokens Midnight', () => {
  it('a paleta é a aprovada', () => {
    expect(token('color-bg').toLowerCase()).toBe('#0b0e18');
    expect(token('color-surface').toLowerCase()).toBe('#151a2a');
    expect(token('color-elevated').toLowerCase()).toBe('#20263a');
    expect(token('color-accent').toLowerCase()).toBe('#929aff');
    expect(token('color-text').toLowerCase()).toBe('#f3f4ff');
    expect(token('color-text-secondary').toLowerCase()).toBe('#a5abc4');
    expect(token('color-on-accent').toLowerCase()).toBe('#0b0e18');
  });

  const surfaces = ['color-bg', 'color-surface', 'color-elevated'];

  it.each(['color-text', 'color-text-secondary', 'color-error', 'color-success'])('%s tem 4,5:1 em toda superfície', (name) => {
    for (const surface of surfaces) expect(contrast(token(name), token(surface)), surface).toBeGreaterThanOrEqual(4.5);
  });

  it.each(['color-accent', 'color-accent-hover', 'color-error'])('o texto sobre botão %s tem 4,5:1', (name) => {
    expect(contrast(token('color-on-accent'), token(name))).toBeGreaterThanOrEqual(4.5);
  });

  it('o texto principal NÃO serve sobre o accent: é por isso que existe o token próprio', () => {
    expect(contrast(token('color-text'), token('color-accent'))).toBeLessThan(4.5);
  });

  it.each(['color-focus', 'color-border-control'])('%s tem 3:1 contra as superfícies (controles e foco)', (name) => {
    for (const surface of surfaces) expect(contrast(token(name), token(surface)), surface).toBeGreaterThanOrEqual(3);
  });
});
