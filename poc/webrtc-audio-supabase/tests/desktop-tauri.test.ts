// P06, incremento 1: host Tauri 2 do mesmo cliente web. Confere a origem pública dos links (convite e recuperação),
// o build desktop que falha fechado e as garantias estáticas do host: mesmo dist/, nenhum plugin, comando ou
// capability, CSP do produto preservada e instalador NSIS por usuário.
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assertDesktopBuild, DESKTOP_MODE } from '../src/desktop-build.ts';
import { WebConfigError, parsePublicOrigin, parseWebConfig, publicLocation } from '../src/web/config.ts';
import { recoveryRedirect } from '../src/web/identity.ts';
import { buildInviteLink, parseInviteFragment } from '../src/web/invites.ts';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const code = (text: string) => text.replace(/\/\/.*$/gm, '').replace(/#.*$/gm, '');

const URL_OK = 'https://abcdefghijklmnopqrst.supabase.co';
const KEY_OK = 'sb_publishable_' + 'AbC123_x-Y';
const PUBLIC = 'https://oryn-yuuriic.vercel.app';
const TOKEN = 'a'.repeat(43);
// O que o WebView do Tauri expõe em `location` com useHttpsScheme.
const DESKTOP = { protocol: 'https:', hostname: 'tauri.localhost', origin: 'https://tauri.localhost', pathname: '/' };
const WEB = { protocol: 'https:', hostname: 'oryn-yuuriic.vercel.app', origin: PUBLIC, pathname: '/' };

describe('origem pública dos links (VITE_ORYN_PUBLIC_ORIGIN)', () => {
  it('opcional: sem ela, a configuração da web fica igual', () => {
    expect(parseWebConfig({ VITE_SUPABASE_URL: URL_OK, VITE_SUPABASE_PUBLISHABLE_KEY: KEY_OK }).publicOrigin).toBeNull();
    expect(parsePublicOrigin(undefined)).toBeNull();
    expect(parsePublicOrigin('  ')).toBeNull();
  });

  it('aceita só https://host[:porta], ou loopback HTTP, sem caminho, barra, consulta ou fragmento', () => {
    expect(parsePublicOrigin(PUBLIC)).toBe(PUBLIC);
    expect(parsePublicOrigin(' https://Oryn.Example:8443 ')).toBe('https://oryn.example:8443');
    expect(parsePublicOrigin('http://127.0.0.1:4173')).toBe('http://127.0.0.1:4173');
    for (const bad of ['http://oryn.example', `${PUBLIC}/`, `${PUBLIC}/app`, `${PUBLIC}?x=1`, `${PUBLIC}#convite=x`, 'https://tauri.localhost/x', 'javascript:alert(1)', 'oryn.example']) {
      expect(() => parsePublicOrigin(bad), bad).toThrow(WebConfigError);
    }
    expect(() => parseWebConfig({ VITE_SUPABASE_URL: URL_OK, VITE_SUPABASE_PUBLISHABLE_KEY: KEY_OK, VITE_ORYN_PUBLIC_ORIGIN: 'http://x.example' })).toThrow(/VITE_ORYN_PUBLIC_ORIGIN/);
  });

  it('web (sem origem pública): convite e recuperação saem do próprio endereço, como antes', () => {
    expect(publicLocation(WEB, null)).toBe(WEB);
    expect(buildInviteLink(publicLocation(WEB, null), TOKEN)).toBe(`${PUBLIC}/#convite=${TOKEN}`);
    expect(recoveryRedirect(publicLocation(WEB, null))).toBe(`${PUBLIC}/`);
  });

  it('desktop: o convite copiado abre na web pública, nunca em tauri.localhost', () => {
    const link = buildInviteLink(publicLocation(DESKTOP, PUBLIC), TOKEN);
    expect(link).toBe(`${PUBLIC}/#convite=${TOKEN}`);
    expect(link).not.toContain('tauri.localhost');
    expect(parseInviteFragment(new URL(link).hash)).toEqual({ kind: 'token', token: TOKEN });
    // Sem a origem pública, o link sairia inútil: é isso que o build desktop impede.
    expect(buildInviteLink(publicLocation(DESKTOP, null), TOKEN)).toContain('tauri.localhost');
  });

  it('desktop: a recuperação de senha volta para a web pública', () => {
    expect(recoveryRedirect(publicLocation(DESKTOP, PUBLIC))).toBe(`${PUBLIC}/`);
    expect(recoveryRedirect(publicLocation({ ...DESKTOP, pathname: '/index.html' }, PUBLIC))).toBe(`${PUBLIC}/`);
  });
});

describe('build desktop (vite build --mode desktop)', () => {
  it('outros modos não exigem nada: o build da web não muda', () => {
    expect(() => assertDesktopBuild('production', {})).not.toThrow();
    expect(() => assertDesktopBuild('development', {})).not.toThrow();
  });

  it('falha fechado sem origem pública HTTPS', () => {
    expect(() => assertDesktopBuild(DESKTOP_MODE, {})).toThrow(/VITE_ORYN_PUBLIC_ORIGIN/);
    expect(() => assertDesktopBuild(DESKTOP_MODE, { VITE_ORYN_PUBLIC_ORIGIN: 'http://127.0.0.1:4173' })).toThrow(/VITE_ORYN_PUBLIC_ORIGIN/);
    expect(() => assertDesktopBuild(DESKTOP_MODE, { VITE_ORYN_PUBLIC_ORIGIN: `${PUBLIC}/` })).toThrow();
    expect(() => assertDesktopBuild(DESKTOP_MODE, { VITE_ORYN_PUBLIC_ORIGIN: PUBLIC })).not.toThrow();
  });

  it('o vite.config aplica a verificação, e o Tauri compila nesse modo', () => {
    expect(code(read('vite.config.ts'))).toMatch(/assertDesktopBuild\(mode, env\)/);
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts['build:desktop']).toBe(`tsc --noEmit && vite build --mode ${DESKTOP_MODE}`);
    expect(pkg.scripts['build']).toBe('tsc --noEmit && vite build'); // a web continua igual
  });

  it('.env.example documenta a variável sem valor', () => {
    expect(read('.env.example')).toMatch(/^VITE_ORYN_PUBLIC_ORIGIN=$/m);
  });
});

describe('host Tauri (src-tauri)', () => {
  interface TauriConf {
    productName: string;
    version: string;
    identifier: string;
    build: Record<string, string>;
    app: { withGlobalTauri: boolean; windows: Record<string, unknown>[]; security: Record<string, unknown> };
    bundle: { active: boolean; targets: string[]; createUpdaterArtifacts?: unknown; windows: { webviewInstallMode: { type: string }; nsis: { installMode: string } } };
    plugins?: unknown;
  }
  const conf = JSON.parse(read('src-tauri/tauri.conf.json')) as TauriConf;

  it('nome, identificador e versão estáveis, fora do espaço da POC-01B', () => {
    expect(conf.productName).toBe('Oryn');
    expect(conf.identifier).toBe('dev.oryn.desktop');
    expect(conf.identifier).not.toBe(JSON.parse(read('../webrtc-audio-tauri/src-tauri/tauri.conf.json')).identifier);
    expect(conf.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(read('src-tauri/Cargo.toml')).toContain(`version = "${conf.version}"`);
  });

  it('consome o mesmo dist/ do Vite, compilado no modo desktop', () => {
    expect(conf.build).toEqual({ devUrl: 'http://127.0.0.1:5173', frontendDist: '../dist', beforeDevCommand: 'pnpm dev', beforeBuildCommand: 'pnpm build:desktop' });
    expect(read('vite.config.ts')).toMatch(/port: 5173, strictPort: true/);
  });

  it('janela: origem HTTPS (aceita pelas Edge Functions), sem API global e sem captura nativa de arquivos', () => {
    expect(conf.app.withGlobalTauri).toBe(false);
    expect(conf.app.windows).toHaveLength(1);
    expect(conf.app.windows[0]).toMatchObject({ label: 'main', useHttpsScheme: true, dragDropEnabled: false });
  });

  it('CSP: a do produto, no <meta> gerado no build; o Tauri não injeta outra', () => {
    expect(conf.app.security).toEqual({ freezePrototype: true, csp: null });
    expect(read('index.html')).toContain('__ORYN_PAGE_CSP__');
  });

  it('sem plugins, comandos ou capabilities: o frontend não tem API nativa nenhuma', () => {
    expect(conf.plugins).toBeUndefined();
    expect(existsSync(new URL('../src-tauri/capabilities', import.meta.url))).toBe(false);
    const cargo = read('src-tauri/Cargo.toml');
    expect(cargo).not.toMatch(/tauri-plugin/);
    expect(cargo).toMatch(/^tauri = \{ version = "=2\.12\.5", features = \[\] \}$/m);
    const main = code(read('src-tauri/src/main.rs'));
    expect(main).not.toMatch(/invoke_handler|\.plugin\(|#\[tauri::command\]|Command::new|std::process/);
  });

  it('instalador NSIS por usuário, sem admin; WebView2 Evergreen; sem updater neste incremento', () => {
    expect(conf.bundle.active).toBe(true);
    expect(conf.bundle.targets).toEqual(['nsis']);
    expect(conf.bundle.windows.nsis.installMode).toBe('currentUser');
    expect(conf.bundle.windows.webviewInstallMode.type).toBe('downloadBootstrapper');
    expect(conf.bundle.createUpdaterArtifacts).toBeUndefined();
    expect(JSON.stringify(conf)).not.toMatch(/certificateThumbprint|signCommand|pubkey/);
  });

  it('o app web não importa nada do Tauri', () => {
    const pkg = JSON.parse(read('package.json')) as { dependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies)).toEqual(['@supabase/supabase-js']);
    expect(code(read('src/web/main.ts'))).not.toMatch(/@tauri-apps|__TAURI/);
  });
});
