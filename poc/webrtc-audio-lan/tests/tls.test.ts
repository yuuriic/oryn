// HTTPS/WSS com certificados gerados pelo OpenSSL (teste 10).
// Verifica a cadeia de verdade (sem desabilitar TLS): o cliente confia apenas na CA gerada.
// Usa 127.0.0.1 como "IP da LAN" para não depender da rede da máquina.
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CA_CERT,
  SERVER_CERT,
  SERVER_KEY,
  checkCertificates,
  findOpenssl,
  generateCertificates,
  isPrivateOrLoopbackIPv4,
  opensslConfig,
  type GeneratedCerts,
} from '../server/certs.ts';
import { startServer, type RunningServer } from '../server/server.ts';
import { signalingUrl } from '../src/signaling-client.ts';
import { TestClient, fakeDist } from './helpers/ws-client.ts';

let openssl: string | null = null;
try {
  openssl = findOpenssl();
} catch {
  openssl = null;
}

describe('configuração de certificados (puro)', () => {
  it('aceita apenas IPv4 privados ou loopback', () => {
    for (const ip of ['10.0.0.5', '172.16.0.1', '172.31.255.254', '192.168.0.23', '127.0.0.1']) expect(isPrivateOrLoopbackIPv4(ip), ip).toBe(true);
    for (const ip of ['8.8.8.8', '172.32.0.1', '192.169.0.1', '256.1.1.1', '1.2.3', 'localhost', '192.168.1.1; rm']) expect(isPrivateOrLoopbackIPv4(ip), ip).toBe(false);
    expect(() => opensslConfig('8.8.8.8')).toThrow();
  });

  it('extensões: CA restrita por nameConstraints e pathlen:0; servidor apenas serverAuth', () => {
    const cnf = opensslConfig('192.168.0.23');
    expect(cnf).toContain('basicConstraints = critical, CA:TRUE, pathlen:0');
    expect(cnf).toContain('nameConstraints = critical, permitted;IP:192.168.0.23/255.255.255.255, permitted;DNS:localhost');
    expect(cnf).toContain('extendedKeyUsage = serverAuth');
    expect(cnf).toContain('subjectAltName = IP:192.168.0.23, DNS:localhost');
  });

  it('URL da sinalização: ws:// em HTTP local e wss:// em HTTPS', () => {
    expect(signalingUrl({ protocol: 'http:', host: 'localhost:5180' })).toBe('ws://localhost:5180/ws');
    expect(signalingUrl({ protocol: 'https:', host: '192.168.0.23:5443' })).toBe('wss://192.168.0.23:5443/ws');
  });
});

describe.skipIf(!openssl)('certificados gerados pelo OpenSSL e HTTPS/WSS', () => {
  let dir: string;
  let certs: GeneratedCerts;
  let dist: string;
  let server: RunningServer;
  let ca: Buffer;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'oryn-lan-certs-'));
    certs = generateCertificates({ ip: '127.0.0.1', dir, keepCaKey: true });
    ca = readFileSync(certs.caCertPath);
    dist = fakeDist();
    server = await startServer({
      distDir: dist,
      httpPort: 0,
      https: { host: '127.0.0.1', port: 0, key: readFileSync(certs.serverKeyPath), cert: readFileSync(certs.serverCertPath) },
      log: () => undefined,
    });
  });

  afterAll(async () => {
    await server?.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(dist, { recursive: true, force: true });
  });

  const text = (file: string) => execFileSync(openssl!, ['x509', '-in', file, '-noout', '-text'], { encoding: 'utf8' });

  it('CA: pathlen 0, nameConstraints críticos, validade ≤ 30 dias', () => {
    const t = text(certs.caCertPath);
    expect(t).toMatch(/CA:TRUE, pathlen:0/);
    expect(t).toMatch(/X509v3 Name Constraints: critical/);
    expect(t).toMatch(/IP:127\.0\.0\.1\/255\.255\.255\.255/);
    const x = new X509Certificate(ca);
    const days = (new Date(x.validTo).getTime() - new Date(x.validFrom).getTime()) / 86_400_000;
    expect(days).toBeLessThanOrEqual(30.01);
  });

  it('servidor: CA:FALSE, serverAuth, SAN com o IP, emitido pela CA', () => {
    const t = text(certs.serverCertPath);
    expect(t).toMatch(/CA:FALSE/);
    expect(t).toMatch(/TLS Web Server Authentication/);
    expect(t).toMatch(/IP Address:127\.0\.0\.1/);
    const x = new X509Certificate(readFileSync(certs.serverCertPath));
    expect(x.checkIssued(new X509Certificate(ca))).toBe(true);
    expect(x.checkIP('127.0.0.1')).toBe('127.0.0.1');
  });

  it('nameConstraints impede a CA de certificar outro IP (prova com a chave mantida só no teste)', () => {
    const rogueDir = mkdtempSync(join(tmpdir(), 'oryn-lan-rogue-'));
    try {
      const cnf = join(rogueDir, 'rogue.cnf');
      writeFileSync(cnf, opensslConfig('10.9.8.7'));
      const key = join(rogueDir, 'rogue.key');
      const csr = join(rogueDir, 'rogue.csr');
      const crt = join(rogueDir, 'rogue.crt');
      execFileSync(openssl!, ['genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', key]);
      execFileSync(openssl!, ['req', '-new', '-key', key, '-config', cnf, '-subj', '/CN=rogue', '-out', csr]);
      execFileSync(openssl!, ['x509', '-req', '-in', csr, '-CA', certs.caCertPath, '-CAkey', join(dir, 'ca.key'), '-CAcreateserial',
        '-days', '1', '-extfile', cnf, '-extensions', 'v3_server', '-out', crt]);
      // Controle: o certificado legítimo verifica.
      expect(execFileSync(openssl!, ['verify', '-CAfile', certs.caCertPath, certs.serverCertPath], { encoding: 'utf8' })).toContain('OK');
      // O certificado para 10.9.8.7 é rejeitado pela restrição de nomes.
      let output = '';
      try {
        execFileSync(openssl!, ['verify', '-CAfile', certs.caCertPath, crt], { encoding: 'utf8', stdio: 'pipe' });
      } catch (error) {
        output = String((error as { stdout?: string; stderr?: string }).stdout ?? '') + String((error as { stderr?: string }).stderr ?? '');
      }
      expect(output).toMatch(/permitted subtree violation/i);
    } finally {
      rmSync(rogueDir, { recursive: true, force: true });
    }
  });

  it('a chave privada da CA é apagada por padrão', () => {
    const other = mkdtempSync(join(tmpdir(), 'oryn-lan-certs2-'));
    try {
      generateCertificates({ ip: '127.0.0.1', dir: other });
      expect(existsSync(join(other, CA_CERT))).toBe(true);
      expect(existsSync(join(other, SERVER_CERT))).toBe(true);
      expect(existsSync(join(other, SERVER_KEY))).toBe(true);
      expect(existsSync(join(other, 'ca.key'))).toBe(false);
      expect(existsSync(join(other, 'server.csr'))).toBe(false);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('checkCertificates detecta IP errado, expiração e arquivos ausentes', () => {
    expect(checkCertificates(dir, '127.0.0.1').ok).toBe(true);
    expect(checkCertificates(dir, '192.168.0.9').problems.join()).toMatch(/não cobre o IP/);
    const future = new Date(Date.now() + 40 * 86_400_000);
    expect(checkCertificates(dir, '127.0.0.1', future).problems.join()).toMatch(/expirado/);
    expect(checkCertificates(join(dir, 'nada'), '127.0.0.1').ok).toBe(false);
  });

  const httpsGet = (url: string, opts: https.RequestOptions) =>
    new Promise<{ status: number; headers: Record<string, unknown> }>((resolve, reject) => {
      https.get(url, opts, (res) => {
        res.resume();
        resolve({ status: res.statusCode ?? 0, headers: res.headers });
      }).on('error', reject);
    });

  it('HTTPS verifica a cadeia confiando apenas na CA local', async () => {
    const res = await httpsGet(`${server.httpsOrigin}/`, { ca });
    expect(res.status).toBe(200);
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    // Sem a CA, a verificação TLS falha (nenhuma verificação é desabilitada).
    await expect(httpsGet(`${server.httpsOrigin}/`, {})).rejects.toThrow(/self-signed|unable to (get|verify)|certificate/i);
  });

  it('/api/info não é exposto pelo listener HTTPS da LAN', async () => {
    expect((await httpsGet(`${server.httpsOrigin}/api/info`, { ca })).status).toBe(404);
  });

  it('WSS: conecta com a CA e Origin HTTPS; recusa Origin estranho; sessão funciona', async () => {
    const wss = `${server.httpsOrigin!.replace('https', 'wss')}/ws`;
    await expect(TestClient.open(wss, 'https://evil.example', { ca })).rejects.toThrow('403');
    await expect(TestClient.open(wss, server.httpsOrigin, {})).rejects.toThrow(/self-signed|unable to (get|verify)|certificate/i);
    const phone = await TestClient.open(wss, server.httpsOrigin, { ca });
    phone.send({ type: 'create' });
    expect((await phone.next('session'))['role']).toBe('host');
    phone.ws.terminate();
  });

  it('TLS 1.0/1.1 não são aceitos pelo servidor', async () => {
    await expect(httpsGet(`${server.httpsOrigin}/`, { ca, maxVersion: 'TLSv1.1', minVersion: 'TLSv1' })).rejects.toThrow();
  });
});
