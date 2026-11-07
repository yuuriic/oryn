// Núcleo da função `sound-media` com `fetch` em memória: credenciais separadas, decisão do banco e tratamento do objeto.
import { describe, expect, it } from 'vitest';
import type { EdgeConfig } from '../supabase/functions/_shared/edge-config.ts';
import { createMediaHandler, handleMediaHttp } from '../supabase/functions/_shared/sound-media-core.ts';
import { sha256Hex } from '../supabase/functions/_shared/sound-validate.ts';
import { mp3 } from './helpers/sound-files.ts';

const cfg = { url: 'https://x.test', publishableKey: 'pub', secretKey: 'sec', allowedOrigins: new Set(['https://app.test']), keyKind: 'new' } as unknown as EdgeConfig;
const ASSET = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const KEY = `${ROOM}/${ASSET}/v1`;

interface Call {
  method: string;
  path: string;
  apikey: string | undefined;
  auth: string | undefined;
  body: Record<string, unknown> | null;
}

function harness(over: { object?: Uint8Array | null; claim?: { status: number; body: unknown }; complete?: unknown; storageDown?: boolean } = {}) {
  const calls: Call[] = [];
  const logs: Record<string, unknown>[] = [];
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    const path = url.replace(cfg.url, '');
    calls.push({ method: init.method, path, apikey: init.headers['apikey'], auth: init.headers['authorization'], body: init.body ? (JSON.parse(init.body) as Record<string, unknown>) : null });
    if (path === '/rest/v1/rpc/claim_sound_validation') return over.claim ? json(over.claim.status, over.claim.body) : json(200, KEY);
    if (path === '/rest/v1/rpc/complete_sound_validation') return json(200, over.complete ?? 'available');
    if (path === '/rest/v1/rpc/finish_sound_cleanup') return json(200, 1);
    if (path === '/rest/v1/rpc/list_sound_cleanup') return json(200, [{ asset_id: ASSET, object_key: KEY }]);
    if (path.startsWith('/storage/v1/object/')) {
      if (over.storageDown) return new Response(null, { status: 500 });
      if (init.method === 'DELETE') return json(200, []);
      if (over.object === null) return new Response(null, { status: 404 });
      return new Response((over.object ?? mp3(1000)) as BodyInit);
    }
    return new Response(null, { status: 500 });
  };
  const handle = createMediaHandler(cfg, fetchImpl as never, (e) => logs.push(e));
  const validate = () => handle('Bearer jwt', JSON.stringify({ action: 'validate', asset_id: ASSET }));
  const named = (path: string) => calls.find((c) => c.path.endsWith(path));
  return { calls, logs, handle, validate, named };
}

describe('validação', () => {
  it('aprova com hash, tipo e duração REAIS; o dono é decidido pelo JWT e o servidor grava com a chave própria', async () => {
    const file = mp3(1000);
    const h = harness({ object: file });
    const r = await h.validate();
    expect(r.status).toBe(200);
    expect(r.body['sha256']).toBe(await sha256Hex(file));
    const claim = h.named('claim_sound_validation')!;
    expect(claim).toMatchObject({ apikey: 'pub', auth: 'Bearer jwt' });
    const done = h.named('complete_sound_validation')!;
    expect(done).toMatchObject({ apikey: 'sec', auth: undefined });
    expect(done.body).toMatchObject({ p_ok: true, p_mime: 'audio/mpeg', p_size_bytes: file.length, p_sha256: await sha256Hex(file) });
    // Nunca as duas credenciais juntas, e nenhum objeto é apagado.
    expect(h.calls.some((c) => c.apikey === 'sec' && c.auth !== undefined)).toBe(false);
    expect(h.calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it.each([
    ['falsificado', new TextEncoder().encode('<html></html>'), 'invalid-format'],
    ['cortado', mp3(1000).subarray(0, 700), 'truncated'],
    ['longo demais', mp3(10_500), 'too-long'],
  ])('arquivo %s: recusa, registra o motivo e apaga o objeto', async (_, object, reason) => {
    const h = harness({ object });
    const r = await h.validate();
    expect(r).toEqual({ status: 422, body: { error: reason } });
    expect(h.named('complete_sound_validation')!.body).toMatchObject({ p_ok: false, p_reason: reason, p_sha256: null });
    const del = h.calls.find((c) => c.method === 'DELETE')!;
    expect(del.body).toEqual({ prefixes: [KEY] });
    expect(h.named('finish_sound_cleanup')!.body).toEqual({ p_asset_ids: [ASSET] });
  });

  it('objeto acima de 2 MiB é recusado sem validar conteúdo', async () => {
    const h = harness({ object: new Uint8Array(2 * 1024 * 1024 + 1) });
    expect(await h.validate()).toEqual({ status: 422, body: { error: 'too-large' } });
  });

  it('quem não é dono não chega ao Storage', async () => {
    const h = harness({ claim: { status: 403, body: { message: 'unauthorized' } } });
    expect(await h.validate()).toEqual({ status: 403, body: { error: 'unauthorized' } });
    expect(h.calls.map((c) => c.path)).toEqual(['/rest/v1/rpc/claim_sound_validation']);
  });

  it('JWT recusado e som já tratado têm respostas próprias', async () => {
    expect((await harness({ claim: { status: 401, body: {} } }).validate()).status).toBe(401);
    expect(await harness({ claim: { status: 409, body: { message: 'sound-unavailable' } } }).validate()).toEqual({ status: 409, body: { error: 'sound-unavailable' } });
  });

  it('objeto ainda não enviado não muda o estado', async () => {
    const h = harness({ object: null });
    expect(await h.validate()).toEqual({ status: 409, body: { error: 'upload-missing' } });
    expect(h.named('complete_sound_validation')).toBeUndefined();
  });

  it('prazo vencido na hora de gravar: recusa e apaga', async () => {
    const h = harness({ complete: 'rejected' });
    expect(await h.validate()).toEqual({ status: 409, body: { error: 'upload-expired' } });
    expect(h.calls.some((c) => c.method === 'DELETE')).toBe(true);
  });

  it('Storage fora do ar: erro próprio, sem mudar o estado', async () => {
    const h = harness({ storageDown: true });
    expect(await h.validate()).toEqual({ status: 503, body: { error: 'storage-unavailable' } });
    expect(h.named('complete_sound_validation')).toBeUndefined();
  });

  it('registro sem chave, JWT ou conteúdo', async () => {
    const h = harness();
    await h.validate();
    const text = JSON.stringify(h.logs);
    expect(text).not.toMatch(/jwt|sec|pub|\/v1/);
    expect(text).not.toContain(ASSET);
  });
});

describe('limpeza', () => {
  it('lista com o JWT do dono, apaga com a chave do servidor e confirma', async () => {
    const h = harness();
    const r = await h.handle('Bearer jwt', JSON.stringify({ action: 'cleanup', room_id: ROOM }));
    expect(r).toEqual({ status: 200, body: { removed: 1 } });
    expect(h.named('list_sound_cleanup')).toMatchObject({ apikey: 'pub', auth: 'Bearer jwt' });
    expect(h.calls.find((c) => c.method === 'DELETE')).toMatchObject({ apikey: 'sec', auth: undefined, body: { prefixes: [KEY] } });
    expect(h.named('finish_sound_cleanup')).toMatchObject({ apikey: 'sec', body: { p_asset_ids: [ASSET] } });
  });

  it('falha ao apagar não confirma: o objeto continua na lista para a próxima vez', async () => {
    const h = harness({ storageDown: true });
    expect((await h.handle('Bearer jwt', JSON.stringify({ action: 'cleanup', room_id: ROOM }))).status).toBe(503);
    expect(h.named('finish_sound_cleanup')).toBeUndefined();
  });
});

describe('entrada', () => {
  it.each([
    [null, '{}', 401],
    ['Basic x', '{}', 401],
    ['Bearer jwt', 'não é json', 400],
    ['Bearer jwt', '[]', 400],
    ['Bearer jwt', JSON.stringify({ action: 'validate', asset_id: 'x' }), 400],
    ['Bearer jwt', JSON.stringify({ action: 'apagar-tudo', room_id: ROOM }), 400],
    ['Bearer jwt', 'x'.repeat(600), 413],
  ])('%s %s → %i', async (auth, body, status) => {
    expect((await harness().handle(auth, body)).status).toBe(status);
  });

  it('HTTP: só origem permitida e só POST', async () => {
    const h = harness();
    const req = (method: string, origin: string | null) =>
      new Request('https://x.test/functions/v1/sound-media', { method, headers: { ...(origin ? { origin } : {}), authorization: 'Bearer jwt' }, ...(method === 'POST' ? { body: JSON.stringify({ action: 'cleanup', room_id: ROOM }) } : {}) });
    expect((await handleMediaHttp(req('OPTIONS', 'https://app.test'), h.handle, cfg.allowedOrigins)).status).toBe(204);
    expect((await handleMediaHttp(req('OPTIONS', 'https://mal.test'), h.handle, cfg.allowedOrigins)).status).toBe(403);
    expect((await handleMediaHttp(req('POST', 'https://mal.test'), h.handle, cfg.allowedOrigins)).status).toBe(403);
    expect((await handleMediaHttp(req('GET', 'https://app.test'), h.handle, cfg.allowedOrigins)).status).toBe(405);
    const ok = await handleMediaHttp(req('POST', 'https://app.test'), h.handle, cfg.allowedOrigins);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://app.test');
    expect(ok.headers.get('cache-control')).toBe('no-store');
  });
});
