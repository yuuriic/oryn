// Camada HTTP da Edge Function `signal` (CORS, método, corpo). Pura sobre Request/Response da Web API,
// então roda igual no Deno e nos testes Node.

import { handleSignal, type SignalDeps } from './signal-core.ts';

// supabase-js envia `apikey` e `x-client-info` junto do `authorization` em functions.invoke().
const ALLOW_HEADERS = 'authorization, apikey, content-type, x-client-info';

export async function handleHttp(req: Request, deps: SignalDeps, allowedOrigins: ReadonlySet<string>): Promise<Response> {
  const origin = req.headers.get('origin');
  const allowed = origin !== null && allowedOrigins.has(origin);
  const cors: Record<string, string> = allowed
    ? { 'access-control-allow-origin': origin, 'access-control-allow-headers': ALLOW_HEADERS, 'access-control-allow-methods': 'POST', vary: 'origin' }
    : {};
  if (req.method === 'OPTIONS') return new Response(null, { status: allowed ? 204 : 403, headers: cors });
  if (req.method !== 'POST') return new Response(null, { status: 405, headers: cors });
  const result = await handleSignal({ authorization: req.headers.get('authorization'), body: await req.text() }, deps);
  return new Response(JSON.stringify(result.body), { status: result.status, headers: { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store' } });
}
