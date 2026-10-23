// Proxy reverso local que SIMULA o caminho borda Cloudflare → cloudflared → origem, sem Cloudflare e sem
// expor nada (escuta só em 127.0.0.1, porta efêmera). Usado pelos testes de fronteira e por `pnpm diagnose`.
import http from 'node:http';
import net from 'node:net';

export interface TunnelOptions {
  /** Porta de destino na origem (a correta é a de sinalização; a administrativa simula erro de configuração). */
  targetPort: number;
  /** Host enviado à origem: o público (preservado) ou outro (ex.: reescrita para localhost). */
  host: string;
  /** JWT do Access injetado pela borda; null = borda sem Access (ou sessão inexistente). */
  jwt: string | null;
  /** IP "do cliente" nos cabeçalhos de proxy (a origem nunca deve confiar neles). */
  clientIp?: string;
  /** Cabeçalhos adicionais (ex.: tentativas de contorno). */
  extraHeaders?: Record<string, string>;
}

export interface Tunnel {
  /** host:porta do proxy local. */
  address: string;
  close(): Promise<void>;
}

export async function startTunnel(options: TunnelOptions): Promise<Tunnel> {
  const { targetPort, host, jwt } = options;
  const clientIp = options.clientIp ?? '203.0.113.9';
  const rewrite = (headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders => {
    const out: http.OutgoingHttpHeaders = {
      ...headers,
      host,
      'x-forwarded-for': clientIp,
      'cf-connecting-ip': clientIp,
      'x-forwarded-host': `localhost:${targetPort}`, // forjado: a origem não pode usar
      'x-forwarded-proto': 'https',
      ...options.extraHeaders,
    };
    // A borda substitui qualquer valor enviado pelo cliente: o cabeçalho do Access vem só dela.
    delete out['cf-access-jwt-assertion'];
    if (jwt !== null) out['cf-access-jwt-assertion'] = jwt;
    return out;
  };
  const proxy = http.createServer((req, res) => {
    const upstream = http.request({ host: '127.0.0.1', port: targetPort, method: req.method, path: req.url, headers: rewrite(req.headers) }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    upstream.on('error', () => res.destroy());
    req.pipe(upstream);
  });
  proxy.on('upgrade', (req, socket, head) => {
    const upstream = net.connect(targetPort, '127.0.0.1', () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (const [k, v] of Object.entries(rewrite(req.headers))) {
        for (const value of Array.isArray(v) ? v : [v]) if (value !== undefined) lines.push(`${k}: ${value}`);
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
  const port = await new Promise<number>((r) => proxy.listen(0, '127.0.0.1', () => r((proxy.address() as net.AddressInfo).port)));
  return {
    address: `127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => (proxy.closeAllConnections(), proxy.close(() => r()))),
  };
}
