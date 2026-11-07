// Oryn Midnight: a página tem o que main.ts exige ao iniciar, e os tokens cumprem o contraste aprovado.
// main.ts lança erro se um id faltar, e a página inteira deixa de iniciar. Nenhum outro teste percebe isso sem navegador.

import { readdirSync, readFileSync } from 'node:fs';
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
const voiceCss = read('src/web/styles/voice.css');
const panelsCss = read('src/web/styles/panels.css');
const goldCss = read('src/web/styles/gold.css');
const entry = read('src/web/style.css');
const allCss = [tokens, base, login, shellCss, roomsCss, voiceCss, panelsCss, goldCss, entry].join('\n');

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
    expect(allCss).not.toMatch(/@font-face/);
    // Só os ícones embutidos em tokens.css: SVG em data: (img-src 'self' data:), sem nenhum endereço de rede.
    const urls = [...allCss.matchAll(/url\(([^)]*)\)/g)].map((m) => m[1]);
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) expect(u).toMatch(/^"data:image\/svg\+xml,%3Csvg xmlns=%27http:\/\/www\.w3\.org\/2000\/svg%27 [^"]*"$/);
    expect(allCss.replace(/url\("data:[^"]*"\)/g, '')).not.toMatch(/url\(/);
    for (const css of [base, login, shellCss, roomsCss, voiceCss, panelsCss, goldCss]) expect(css).not.toMatch(/url\(/);
    expect(idsIn(allCss, /@import\s+'([^']+)'/g)).toEqual(['./styles/tokens.css', './styles/base.css', './styles/login.css', './styles/shell.css', './styles/rooms.css', './styles/voice.css', './styles/panels.css', './styles/gold.css']);
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
    // Paleta da referência aprovada (docs/design/HYBRID-MIDNIGHT-GOLD.md, seção 1).
    expect(token('color-bg').toLowerCase()).toBe('#0c0a18');
    expect(token('color-surface').toLowerCase()).toBe('#15112a');
    expect(token('color-elevated').toLowerCase()).toBe('#211b3c');
    expect(token('color-accent').toLowerCase()).toBe('#9d7bff');
    expect(token('color-gold').toLowerCase()).toBe('#f2b544');
    expect(token('color-text').toLowerCase()).toBe('#f5f3ff');
    expect(token('color-text-secondary').toLowerCase()).toBe('#aca6cc');
    expect(token('color-on-accent').toLowerCase()).toBe('#0c0a18');
  });

  it.each(['color-accent-strong', 'color-danger-strong'])('o texto branco sobre o fundo forte %s tem 4,5:1', (name) => {
    expect(contrast('#ffffff', token(name))).toBeGreaterThanOrEqual(4.5);
  });

  const surfaces = ['color-bg', 'color-surface', 'color-elevated'];

  it.each(['color-text', 'color-text-secondary', 'color-error', 'color-success', 'color-accent', 'color-gold'])('%s tem 4,5:1 em toda superfície', (name) => {
    for (const surface of surfaces) expect(contrast(token(name), token(surface)), surface).toBeGreaterThanOrEqual(4.5);
  });

  it.each(['color-accent', 'color-accent-hover', 'color-error', 'color-gold'])('o texto sobre botão %s tem 4,5:1', (name) => {
    expect(contrast(token('color-on-accent'), token(name))).toBeGreaterThanOrEqual(4.5);
  });

  it('o texto principal NÃO serve sobre o accent: é por isso que existe o token próprio', () => {
    expect(contrast(token('color-text'), token('color-accent'))).toBeLessThan(4.5);
  });

  it.each(['color-accent-soft', 'color-gold-soft'])('o texto sobre o fundo suave %s tem 4,5:1', (name) => {
    for (const text of ['color-text', 'color-text-secondary', 'color-gold']) expect(contrast(token(text), token(name)), text).toBeGreaterThanOrEqual(4.5);
  });

  it.each(['color-focus', 'color-border-control'])('%s tem 3:1 contra as superfícies (controles e foco)', (name) => {
    for (const surface of surfaces) expect(contrast(token(name), token(surface)), surface).toBeGreaterThanOrEqual(3);
  });
});

describe('recursos futuros: visíveis e indisponíveis', () => {
  const group = /<div class="future-features"[\s\S]*?<\/div>/.exec(html)?.[0] ?? '';
  const buttons = [...group.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map((m) => m[0]);
  const sources = readdirSync(fileURLToPath(new URL('../src', import.meta.url)), { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts'))
    .map((f) => read(`src/${f.replaceAll('\\', '/')}`))
    .join('\n');

  it('transmissão de tela e configurações avançadas de áudio, cada uma com "Em breve" no nome acessível', () => {
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toMatch(/Transmitir tela/);
    expect(buttons[1]).toMatch(/Configurações avançadas de áudio/);
    for (const b of buttons) expect(b).toMatch(/<span class="soon-badge">Em breve<\/span>/);
  });

  it('indisponíveis sem sair do Tab: aria-disabled, type="button" e a explicação associada', () => {
    for (const b of buttons) {
      expect(b).toMatch(/\saria-disabled="true"/);
      expect(b).toMatch(/\stype="button"/);
      expect(b).toMatch(/\saria-describedby="future-features-note"/);
      expect(b).not.toMatch(/\sid=/);
    }
    expect(html).toMatch(/id="future-features-note"[^>]*>Ainda não disponíveis nesta versão\.</);
  });

  it('nenhum código os liga a uma funcionalidade nem pede permissão de captura de tela ou de dispositivos', () => {
    expect(sources).toMatch(/navigator\.mediaDevices\.getUserMedia/); // controle: a leitura encontrou o código-fonte
    expect(sources).not.toMatch(/future-btn|future-features|soon-badge/);
    expect(sources).not.toMatch(/getDisplayMedia|enumerateDevices|selectAudioOutput|setSinkId/);
    expect(sources).not.toMatch(/video:\s*true/);
  });

  it('distinguíveis dos controles disponíveis sem depender só de cor, e o hover genérico não os acende', () => {
    const rule = /button\.future-btn\[aria-disabled='true'\],\s*button\.future-btn\[aria-disabled='true'\]:hover\s*\{([^}]*)\}/.exec(voiceCss)?.[1] ?? '';
    expect(rule).toMatch(/background:\s*transparent/);
    expect(rule).toMatch(/border:\s*1px dashed var\(--color-border-control\)/);
    expect(rule).toMatch(/color:\s*var\(--color-text-secondary\)/);
    expect(rule).toMatch(/cursor:\s*not-allowed/);
    expect(rule).toMatch(/min-height:\s*44px/);
    expect(rule).not.toMatch(/opacity/);
  });
});
