// Núcleo da Edge Function `sound-media`. Puro e testável: `fetch` é injetado.
//
// Duas credenciais, nunca misturadas, como em `signal`:
// - USUÁRIO (claim_sound_validation, list_sound_cleanup): o banco decide, pelo JWT, se o chamador é o dono da sala;
// - SERVIDOR (Storage, complete_sound_validation, finish_sound_cleanup): só depois dessa decisão.
//
// O nome do arquivo e o MIME do cliente não entram aqui. Nenhum log leva chave, token, nome de som ou conteúdo.

import { isUuid } from './signal-contract.ts';
import { serverHeaders, userHeaders, type FetchLike } from './supabase-http.ts';
import type { EdgeConfig } from './edge-config.ts';
import { checkSound, MAX_SOUND_BYTES, sha256Hex } from './sound-validate.ts';

export const SOUND_BUCKET = 'oryn-sounds';
const TIMEOUT_MS = 8_000;
const ALLOW_HEADERS = 'authorization, apikey, content-type, x-client-info';
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export type MediaLog = (event: Record<string, string | number | boolean>) => void;
export interface MediaResult {
  status: number;
  body: Record<string, unknown>;
}

const refused = (status: number, error: string): MediaResult => ({ status, body: { error } });

const RPC_ERRORS: Record<string, MediaResult> = {
  unauthorized: refused(403, 'unauthorized'),
  'sound-unavailable': refused(409, 'sound-unavailable'),
};

class MediaError extends Error {
  readonly result: MediaResult;
  constructor(result: MediaResult) {
    super(String(result.body['error']));
    this.result = result;
  }
}

export type MediaHandler = (authorization: string | null, rawBody: string) => Promise<MediaResult>;

export function createMediaHandler(cfg: EdgeConfig, fetchImpl: FetchLike, log: MediaLog): MediaHandler {
  const post = (path: string, headers: Record<string, string>, body: unknown) =>
    fetchImpl(`${cfg.url}${path}`, {
      method: 'POST',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const rpc = async (fn: string, headers: Record<string, string>, args: Record<string, unknown>): Promise<unknown> => {
    const res = await post(`/rest/v1/rpc/${fn}`, headers, args);
    if (res.status === 401) throw new MediaError(refused(401, 'jwt-invalid'));
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: unknown };
      const known = typeof body.message === 'string' ? RPC_ERRORS[body.message] : undefined;
      throw new MediaError(known ?? refused(503, 'database-unavailable'));
    }
    return res.json();
  };

  const objectUrl = (key: string): string => `${cfg.url}/storage/v1/object/${SOUND_BUCKET}/${key.split('/').map(encodeURIComponent).join('/')}`;

  const deleteObjects = async (keys: string[]): Promise<void> => {
    const res = await fetchImpl(`${cfg.url}/storage/v1/object/${SOUND_BUCKET}`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { ...serverHeaders(cfg), 'content-type': 'application/json' },
      body: JSON.stringify({ prefixes: keys }),
    });
    if (!res.ok) throw new MediaError(refused(503, 'storage-unavailable'));
  };

  const removeNow = async (ids: string[], keys: string[]): Promise<void> => {
    await deleteObjects(keys);
    await rpc('finish_sound_cleanup', serverHeaders(cfg), { p_asset_ids: ids });
  };

  /** `null`: nada foi enviado ainda. Um objeto maior que o limite não é carregado. */
  const download = async (key: string): Promise<Uint8Array | null | 'too-large'> => {
    const res = await fetchImpl(objectUrl(key), { method: 'GET', signal: AbortSignal.timeout(TIMEOUT_MS), headers: serverHeaders(cfg) });
    if (res.status === 400 || res.status === 404) return null;
    if (!res.ok) throw new MediaError(refused(503, 'storage-unavailable'));
    if (Number(res.headers.get('content-length') ?? 0) > MAX_SOUND_BYTES) return 'too-large';
    const bytes = new Uint8Array(await res.arrayBuffer());
    return bytes.length > MAX_SOUND_BYTES ? 'too-large' : bytes;
  };

  const validate = async (jwt: string, assetId: string): Promise<MediaResult> => {
    const key = await rpc('claim_sound_validation', userHeaders(cfg, jwt), { p_asset_id: assetId });
    if (typeof key !== 'string') throw new MediaError(refused(503, 'database-unavailable'));
    const bytes = await download(key);
    if (bytes === null) return refused(409, 'upload-missing');
    const check = bytes === 'too-large' ? ({ ok: false, reason: 'too-large' } as const) : checkSound(bytes);
    if (!check.ok) {
      await rpc('complete_sound_validation', serverHeaders(cfg), { p_asset_id: assetId, p_ok: false, p_mime: null, p_size_bytes: null, p_duration_ms: null, p_sha256: null, p_reason: check.reason });
      // Falha aqui não muda a resposta: o objeto recusado fica na lista de limpeza.
      await removeNow([assetId], [key]).catch(() => undefined);
      log({ outcome: 'rejected', reason: check.reason });
      return refused(422, check.reason);
    }
    const hash = await sha256Hex(bytes as Uint8Array);
    const state = await rpc('complete_sound_validation', serverHeaders(cfg), {
      p_asset_id: assetId, p_ok: true, p_mime: check.mime, p_size_bytes: check.sizeBytes, p_duration_ms: check.durationMs, p_sha256: hash, p_reason: null,
    });
    if (state !== 'available') {
      await removeNow([assetId], [key]).catch(() => undefined);
      log({ outcome: 'rejected', reason: 'upload-expired' });
      return refused(409, 'upload-expired');
    }
    log({ outcome: 'approved', bytes: check.sizeBytes, ms: check.durationMs });
    return { status: 200, body: { state: 'available', sha256: hash, duration_ms: check.durationMs } };
  };

  const cleanup = async (jwt: string, roomId: string): Promise<MediaResult> => {
    const rows = await rpc('list_sound_cleanup', userHeaders(cfg, jwt), { p_room_id: roomId });
    if (!Array.isArray(rows)) throw new MediaError(refused(503, 'database-unavailable'));
    const items = rows.filter(isObj).filter((r) => isUuid(r['asset_id']) && typeof r['object_key'] === 'string');
    if (items.length > 0) await removeNow(items.map((r) => r['asset_id'] as string), items.map((r) => r['object_key'] as string));
    log({ outcome: 'cleanup', count: items.length });
    return { status: 200, body: { removed: items.length } };
  };

  return async (authorization, rawBody) => {
    const jwt = /^Bearer (\S+)$/.exec(authorization ?? '')?.[1];
    if (!jwt) return refused(401, 'jwt-missing');
    if (rawBody.length > 512) return refused(413, 'too-large');
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return refused(400, 'invalid-request');
    }
    if (!isObj(body)) return refused(400, 'invalid-request');
    try {
      if (body['action'] === 'validate' && isUuid(body['asset_id'])) return await validate(jwt, body['asset_id']);
      if (body['action'] === 'cleanup' && isUuid(body['room_id'])) return await cleanup(jwt, body['room_id']);
      return refused(400, 'invalid-request');
    } catch (error) {
      if (error instanceof MediaError) return error.result;
      log({ outcome: 'error' });
      return refused(503, 'unavailable');
    }
  };
}

export async function handleMediaHttp(req: Request, handle: MediaHandler, allowedOrigins: ReadonlySet<string>): Promise<Response> {
  const origin = req.headers.get('origin');
  const allowed = origin !== null && allowedOrigins.has(origin);
  const cors: Record<string, string> = allowed
    ? { 'access-control-allow-origin': origin, 'access-control-allow-headers': ALLOW_HEADERS, 'access-control-allow-methods': 'POST', vary: 'origin' }
    : {};
  if (req.method === 'OPTIONS') return new Response(null, { status: allowed ? 204 : 403, headers: cors });
  if (req.method !== 'POST') return new Response(null, { status: 405, headers: cors });
  if (!allowed) return new Response(null, { status: 403 });
  const result = await handle(req.headers.get('authorization'), await req.text());
  return new Response(JSON.stringify(result.body), { status: result.status, headers: { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store' } });
}
