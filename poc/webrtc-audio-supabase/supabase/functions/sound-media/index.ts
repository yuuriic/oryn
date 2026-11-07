// Edge Function `sound-media` (Deno): valida o conteúdo de um som em quarentena e apaga objetos pendentes. Só a LIGAÇÃO dos
// módulos de ../_shared, que são puros e testados no Node. Publicação pela CLI, com autorização própria.
// Credenciais: as mesmas de `signal` (_shared/edge-config.ts), sem secret novo. Nenhuma chave é registrada em log.
// Este arquivo fica fora do typecheck do Node (usa APIs do Deno).

import { loadEdgeConfig } from '../_shared/edge-config.ts';
import { createMediaHandler, handleMediaHttp } from '../_shared/sound-media-core.ts';

declare const Deno: { env: { get(name: string): string | undefined }; serve(handler: (req: Request) => Promise<Response>): void };

const cfg = loadEdgeConfig((name) => Deno.env.get(name));
const handle = createMediaHandler(cfg, fetch, (event) => console.log(JSON.stringify({ fn: 'sound-media', ...event })));
console.log(JSON.stringify({ fn: 'sound-media', outcome: 'boot', keys: cfg.keyKind }));

Deno.serve((req: Request) => handleMediaHttp(req, handle, cfg.allowedOrigins));
