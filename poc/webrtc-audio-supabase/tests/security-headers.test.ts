// SEC-01: política de segurança da página. As conexões vêm do URL configurado, resolvido no build; o que não depende
// do projeto vai por cabeçalho HTTP. Nenhum URL, ref ou chave real fica no código versionado.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CSP_PLACEHOLDER, applyPagePolicy, connectSources, isSupabaseUrl, pagePolicy } from '../src/csp.ts';
import { parseWebConfig } from '../src/web/config.ts';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const URL_OK = 'https://abcdefghijklmnopqrst.supabase.co';
const LOCAL = 'http://127.0.0.1:54321';
const directive = (policy: string, name: string) => policy.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `));

describe('connect-src vem do endpoint configurado', () => {
  it('projeto: só HTTPS e WSS desse host, sem curinga', () => {
    expect(connectSources(URL_OK, { dev: false })).toEqual(["'self'", URL_OK, 'wss://abcdefghijklmnopqrst.supabase.co']);
  });

  it('um outro projeto Supabase fica fora da política', () => {
    const policy = pagePolicy(URL_OK, { dev: false });
    expect(policy).not.toContain('*');
    expect(policy).not.toContain('outroprojetooutroxxx.supabase.co');
  });

  it('stack local: só a porta configurada; loopback não entra no build do projeto', () => {
    expect(connectSources(LOCAL, { dev: false })).toEqual(["'self'", LOCAL, 'ws://127.0.0.1:54321']);
    expect(pagePolicy(URL_OK, { dev: false })).not.toMatch(/localhost|127\.0\.0\.1/);
  });

  it('servidor de desenvolvimento: libera só o WebSocket do recarregamento do Vite', () => {
    const sources = connectSources(LOCAL, { dev: true });
    expect(sources).toContain('ws://127.0.0.1:*');
    expect(sources).toContain('ws://localhost:*');
    expect(sources.filter((s) => s.startsWith('http:'))).toEqual([LOCAL]);
  });

  it('sem URL configurado: fecha em self, e a página já mostra erro de configuração', () => {
    expect(connectSources(undefined, { dev: false })).toEqual(["'self'"]);
    expect(connectSources('', { dev: false })).toEqual(["'self'"]);
    expect(() => parseWebConfig({})).toThrow();
  });

  it('URL fora do formato: o build falha, em vez de gerar uma política errada', () => {
    for (const bad of ['https://evil.example.com', 'https://*.supabase.co', 'http://abcdefghijklmnopqrst.supabase.co', "https://abcdefghijklmnopqrst.supabase.co; script-src *", 'http://evil.example.com:54321', `${URL_OK}/`]) {
      expect(() => connectSources(bad, { dev: false }), bad).toThrow();
    }
  });

  it('o build e o cliente aceitam exatamente os mesmos URLs', () => {
    for (const url of [URL_OK, LOCAL, 'http://localhost:54321']) {
      expect(isSupabaseUrl(url), url).toBe(true);
      expect(parseWebConfig({ VITE_SUPABASE_URL: url, VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_' + 'AbC' }).supabaseUrl, url).toBe(url);
    }
    for (const url of ['https://evil.example.com', 'https://abc.supabase.co', 'ftp://127.0.0.1:54321']) {
      expect(isSupabaseUrl(url), url).toBe(false);
      expect(() => parseWebConfig({ VITE_SUPABASE_URL: url, VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_' + 'AbC' }), url).toThrow();
    }
  });
});

describe('política da página', () => {
  const policy = pagePolicy(URL_OK, { dev: false });

  it('sem inline, eval, terceiros ou esquema inteiro', () => {
    expect(policy).not.toMatch(/unsafe-inline|unsafe-eval|(^|\s)\*(\s|;|$)|\shttps?:(\s|;)/);
    expect(directive(policy, 'default-src')).toBe("default-src 'self'");
    expect(directive(policy, 'script-src')).toBe("script-src 'self'");
    expect(directive(policy, 'style-src')).toBe("style-src 'self'");
  });

  it('o marcador do index.html é trocado uma vez; sem ele, o build falha', () => {
    const html = read('index.html');
    expect(html.split(CSP_PLACEHOLDER)).toHaveLength(2);
    const out = applyPagePolicy(html, URL_OK, { dev: false });
    expect(out).not.toContain(CSP_PLACEHOLDER);
    expect(/Content-Security-Policy"\s+content="([^"]+)"/.exec(out)?.[1]).toBe(policy);
    expect(() => applyPagePolicy('<html></html>', URL_OK, { dev: false })).toThrow();
  });

  it('o index.html versionado não fixa domínio nenhum', () => {
    expect(read('index.html')).not.toMatch(/supabase\.co|127\.0\.0\.1|localhost/);
  });

  it('regressão: o build aplica a política; sem o plugin, o marcador iria para o HTML publicado', async () => {
    const { build } = await import('vite');
    const root = fileURLToPath(new URL('..', import.meta.url));
    const previous = process.env['VITE_SUPABASE_URL'];
    process.env['VITE_SUPABASE_URL'] = URL_OK;
    try {
      const out = (await build({ root, logLevel: 'silent', build: { write: false } })) as { output: { fileName: string; type: string; source?: string | Uint8Array }[] };
      const html = out.output.find((f) => f.fileName === 'index.html')?.source;
      expect(html).toContain(`connect-src 'self' ${URL_OK} wss://abcdefghijklmnopqrst.supabase.co`);
      expect(html).not.toContain(CSP_PLACEHOLDER);
    } finally {
      if (previous === undefined) delete process.env['VITE_SUPABASE_URL'];
      else process.env['VITE_SUPABASE_URL'] = previous;
    }
  }, 60_000);
});

describe('instalação na hospedagem (vercel.json)', () => {
  // O lockfile do pnpm 12 tem dois documentos YAML, e versões mais antigas, como a 10.20, o recusam. Sem o comando fixo,
  // a hospedagem pode escolher outra versão pelo lockfile, e o deploy falha com ERR_PNPM_BROKEN_LOCKFILE.
  const hosting = JSON.parse(read('vercel.json')) as { installCommand: string; buildCommand: string };
  const pinned = (JSON.parse(read('package.json')) as { packageManager: string }).packageManager;

  it('instala e compila com a versão exata de packageManager', () => {
    expect(pinned).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
    expect(hosting.installCommand).toBe(`npx --yes ${pinned} install --frozen-lockfile`);
    expect(hosting.buildCommand).toBe(`npx --yes ${pinned} build`);
  });

  it('o lockfile continua no formato do pnpm 12: o bloco que fixa a versão, depois o das dependências', () => {
    const docs = read('pnpm-lock.yaml').split(/^---$/m).filter((d) => d.trim());
    expect(docs).toHaveLength(2);
    expect(docs[0]).toContain(`version: ${pinned.slice('pnpm@'.length)}`);
    expect(docs[1]).toMatch(/^\s*lockfileVersion: '9\.0'/);
  });
});

describe('cabeçalhos HTTP da hospedagem (vercel.json)', () => {
  const config = JSON.parse(read('vercel.json')) as { headers: { source: string; headers: { key: string; value: string }[] }[] };
  const all = config.headers.find((h) => h.source === '/(.*)')!.headers;
  const header = (key: string) => all.find((h) => h.key.toLowerCase() === key.toLowerCase())?.value;

  it('valem para todas as rotas e não trazem URL, ref ou chave', () => {
    expect(config.headers).toHaveLength(1);
    expect(read('vercel.json')).not.toMatch(/supabase\.co|sb_publishable|sb_secret|eyJ/);
  });

  it('CSP do cabeçalho: frame-ancestors e as diretivas que o <meta> não cobre', () => {
    const csp = header('Content-Security-Policy')!;
    expect(directive(csp, 'frame-ancestors')).toBe("frame-ancestors 'none'");
    expect(directive(csp, 'base-uri')).toBe("base-uri 'none'");
    expect(directive(csp, 'object-src')).toBe("object-src 'none'");
    expect(directive(csp, 'form-action')).toBe("form-action 'none'");
  });

  it('sem política duplicada ou conflitante: cabeçalho e <meta> não repetem nenhuma diretiva', () => {
    const names = (p: string) => p.split(';').map((d) => d.trim().split(/\s+/)[0]);
    const inHeader = names(header('Content-Security-Policy')!);
    const inMeta = names(pagePolicy(URL_OK, { dev: false }));
    expect(inHeader.filter((n) => inMeta.includes(n))).toEqual([]);
    // Por <meta>, o navegador ignora frame-ancestors: precisa ficar só no cabeçalho.
    expect(inMeta).not.toContain('frame-ancestors');
  });

  it('demais proteções', () => {
    expect(header('X-Content-Type-Options')).toBe('nosniff');
    expect(header('X-Frame-Options')).toBe('DENY');
    expect(header('Referrer-Policy')).toBe('no-referrer');
    expect(header('Cross-Origin-Opener-Policy')).toBe('same-origin');
  });

  it('o microfone continua liberado para a própria página, e só para ela', () => {
    const permissions = header('Permissions-Policy')!;
    expect(permissions).toContain('microphone=(self)');
    expect(permissions).toContain('camera=()');
    expect(permissions).toContain('geolocation=()');
  });
});
