// Edge Function `turn` (Deno): configuração ICE com credenciais TURN temporárias para quem está numa voz. Só a LIGAÇÃO
// dos módulos de ../_shared, que são puros e testados no Node. Publicação pela CLI, com autorização própria
// (integration/TURN-RELAY.md). NÃO publicada.
//
// Credenciais: as da plataforma (_shared/edge-config.ts) e, só com ORYN_TURN_PROVIDER=cloudflare, os secrets
// ORYN_TURN_KEY_ID e ORYN_TURN_API_TOKEN. Sem eles (padrão off), a função responde turn-unavailable e o cliente segue
// por STUN. Nenhuma chave, credencial ou JWT é registrado em log.
// Este arquivo fica fora do typecheck do Node (usa APIs do Deno).

import { loadEdgeConfig } from '../_shared/edge-config.ts';
import { IssueLimiter, createLiveSessionDeps, handleTurnHttp, loadTurnConfig, type TurnDeps } from '../_shared/turn-core.ts';
import { CloudflareTurnProvider } from '../_shared/turn-provider.ts';

declare const Deno: { env: { get(name: string): string | undefined }; serve(handler: (req: Request) => Promise<Response>): void };

const cfg = loadEdgeConfig((name) => Deno.env.get(name));
const turn = loadTurnConfig((name) => Deno.env.get(name));
const provider = turn.provider === 'cloudflare' ? new CloudflareTurnProvider({ keyId: turn.keyId!, apiToken: turn.apiToken! }) : null;
const deps: TurnDeps = {
  ...createLiveSessionDeps(cfg, fetch),
  provider,
  limiter: new IssueLimiter({ now: Date.now }),
  ttlSec: turn.ttlSec,
  log: (event) => console.log(JSON.stringify({ fn: 'turn', ...event })),
};
console.log(JSON.stringify({ fn: 'turn', outcome: 'boot', provider: turn.provider, ttl_min: Math.round(turn.ttlSec / 60) }));

Deno.serve((req: Request) => handleTurnHttp(req, deps, cfg.allowedOrigins));
