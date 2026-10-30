// Entrega da credencial pelo terminal (02B.2C): o processo real (server/index.ts) imprime só o código
// de pareamento — nunca o token administrativo nem outro segredo de 256 bits — e "codigo" + Enter
// gera um novo código e revoga a sessão administrativa anterior.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { TestClient, createAndInvite, fakeDist, pairHeaders, post, wsUrlOf } from './helpers/ws-client.ts';

const entry = fileURLToPath(new URL('../server/index.ts', import.meta.url));
const CODE = /Código de pareamento do operador: ([0-9A-Z]{4}-[0-9A-Z]{4})/g;
const TOKEN_LIKE = /[A-Za-z0-9_-]{43}/;

let child: ChildProcessWithoutNullStreams | null = null;
let dist: string | null = null;
const clients: TestClient[] = [];

afterEach(() => {
  for (const c of clients.splice(0)) c.ws.terminate();
  child?.kill();
  child = null;
  if (dist) rmSync(dist, { recursive: true, force: true });
  dist = null;
});

function waitFor(get: () => string, pattern: RegExp, timeoutMs = 10_000): Promise<RegExpMatchArray> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = (): void => {
      const m = get().match(pattern);
      if (m) return resolve(m);
      if (Date.now() - started > timeoutMs) return reject(new Error(`Tempo esgotado esperando ${pattern}:\n${get()}`));
      setTimeout(tick, 20);
    };
    tick();
  });
}

describe('servidor real (CLI): entrega local da credencial', () => {
  it('terminal mostra só o código; o token nunca aparece na saída; "codigo" gera outro e revoga o token', async () => {
    dist = fakeDist();
    child = spawn(process.execPath, [entry, '--http-port=0', '--admin-port=0', `--dist-dir=${dist}`], {
      env: { ...process.env, ORYN_PUBLIC_HOSTNAMES: '' },
    });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (output += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (output += d));

    const adminOrigin = (await waitFor(() => output, /Administração \(só neste PC\):\s+(http:\/\/\S+)/))[1]!;
    const signalOrigin = (await waitFor(() => output, /Sinalização \(alvo do túnel\):\s+(http:\/\/\S+)/))[1]!;
    const first = (await waitFor(() => output, /Código de pareamento do operador: ([0-9A-Z]{4}-[0-9A-Z]{4})/))[1]!;
    expect(adminOrigin).not.toBe(signalOrigin);
    expect(output).toContain('FECHADO');
    expect(output).not.toContain('#op=');

    // A página administrativa troca o código pelo token (Host/Origin localhost, como no navegador).
    const pair = (code: string) =>
      post(adminOrigin, '/admin/pair', JSON.stringify({ code }), pairHeaders(adminOrigin));
    const reply = await pair(first);
    expect(reply.status).toBe(200);
    const { token } = JSON.parse(reply.body) as { token: string };
    const operator = await TestClient.open(wsUrlOf(adminOrigin), adminOrigin);
    clients.push(operator);
    const { invite, sessionId } = await createAndInvite(operator, token);

    // Novo código pelo terminal: o anterior e o token vigente deixam de valer.
    child.stdin.write('codigo\n');
    await waitFor(() => output, /(Código de pareamento do operador: [0-9A-Z-]{9}[\s\S]*){2}/);
    const codes = [...output.matchAll(CODE)].map((m) => m[1]);
    expect(codes).toHaveLength(2);
    expect(codes[1]).not.toBe(codes[0]);
    expect((await pair(first)).status).toBe(403);
    const stale = await TestClient.open(wsUrlOf(adminOrigin), adminOrigin);
    clients.push(stale);
    stale.send({ type: 'create', operatorKey: token });
    expect(await stale.next('error')).toEqual({ type: 'error', code: 'unauthorized' });
    expect((await pair(codes[1]!)).status).toBe(200);

    // Nada de 256 bits na saída: nem token administrativo, nem convite, nem ID completo de sessão.
    for (const secret of [token, invite, sessionId]) expect(output).not.toContain(secret);
    expect(output).not.toMatch(TOKEN_LIKE);
  });
});
