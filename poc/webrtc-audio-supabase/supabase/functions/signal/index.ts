// Edge Function `signal` (Deno) — só a LIGAÇÃO dos módulos de ../_shared, que são puros e testados no Node.
// NÃO foi executada nem implantada: o comportamento no Supabase real é NOT VERIFIED (02C.1B).
//
// Credenciais (ver _shared/edge-config.ts): a plataforma injeta SUPABASE_URL e as chaves; o único secret
// próprio é ORYN_ALLOWED_ORIGINS. Nenhuma chave é registrada em log.
// Este arquivo fica fora do typecheck do Node (usa APIs do Deno).

import { loadEdgeConfig } from '../_shared/edge-config.ts';
import { createSignalDeps } from '../_shared/supabase-http.ts';
import { handleHttp } from '../_shared/signal-http.ts';

declare const Deno: { env: { get(name: string): string | undefined }; serve(handler: (req: Request) => Promise<Response>): void };

const cfg = loadEdgeConfig((name) => Deno.env.get(name));
const deps = createSignalDeps(cfg, fetch, (event) => console.log(JSON.stringify({ fn: 'signal', ...event })));
console.log(JSON.stringify({ fn: 'signal', outcome: 'boot', keys: cfg.keyKind }));

Deno.serve((req: Request) => handleHttp(req, deps, cfg.allowedOrigins));
