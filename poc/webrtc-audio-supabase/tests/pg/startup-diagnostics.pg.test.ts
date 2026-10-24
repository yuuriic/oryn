// Diagnóstico de falha na inicialização do PostgreSQL embutido (02C.2B.1/02C.2B.2). No CI do Windows o
// erro chegava como "Unknown Error: undefined"; no Ubuntu a limpeza ficava pendente até o timeout do Vitest
// (o stop() do embedded-postgres espera um `exit` que já tinha acontecido). Aqui o servidor é obrigado a
// falhar (parâmetro inválido) e o erro tem de chegar SOZINHO e rápido, com a etapa, a mensagem real do
// Postgres e nenhuma senha, sem deixar diretório temporário para trás.
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { PgServer, PgStartupError, TIMEOUTS, withTimeout } from './pg-server.ts';

const tempDirs = () => readdirSync(tmpdir()).filter((d) => d.startsWith('oryn-pg17-')).sort();

describe('diagnóstico de falha ao iniciar o PostgreSQL 17 embutido', () => {
  it('parâmetro inválido → falha rápida com a etapa e a mensagem do Postgres; nunca "undefined"; sem sobras', async () => {
    const before = tempDirs();
    const t0 = Date.now();
    const error = await PgServer.start(['-c', 'shared_buffers=nao-numero']).then(
      () => null,
      (e: unknown) => e,
    );
    const elapsed = Date.now() - t0;
    expect(error).toBeInstanceOf(PgStartupError);
    const message = (error as Error).message;
    expect(message).toMatch(/^\[pg17:iniciar servidor/);
    expect(message).toMatch(/FATAL:\s+invalid value for parameter "shared_buffers"/); // motivo REAL, do log do servidor
    expect(message).not.toMatch(/undefined/);
    // A senha do processo é um UUID aleatório: nenhum UUID pode aparecer na mensagem.
    expect(message).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    // Termina por conta própria: só initdb + falha imediata do servidor, muito abaixo do prazo interno de
    // início e do timeout do Vitest (o bug do 02C.2B.2 só terminava pelo timeout de 120 s do teste).
    expect(elapsed).toBeLessThan(TIMEOUTS.initdbMs / 2);
    expect(tempDirs()).toEqual(before);
  });
});

describe('prazo interno das etapas', () => {
  it('etapa que nunca termina → erro explícito "tempo esgotado" e encerramento do que ficou pendente', async () => {
    let cleaned = false;
    const t0 = Date.now();
    await expect(withTimeout(new Promise(() => {}), 200, 'etapa de teste', () => (cleaned = true))).rejects.toThrow('tempo esgotado: etapa de teste não terminou em 0.2 s');
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(cleaned).toBe(true);
  });

  it('etapa que termina a tempo → resultado normal, sem efeito do prazo', async () => {
    await expect(withTimeout(Promise.resolve(42), 1_000, 'rápida')).resolves.toBe(42);
  });
});
