// Diagnóstico de falha na inicialização do PostgreSQL embutido (02C.2B.1). No CI do Windows o erro chegava
// como "Unknown Error: undefined". Aqui o servidor é obrigado a falhar (parâmetro inválido) e o erro tem de
// trazer a etapa, a mensagem real do Postgres e nenhuma senha; e nada pode sobrar rodando.
import { describe, expect, it } from 'vitest';
import { PgServer, PgStartupError } from './pg-server.ts';

describe('diagnóstico de falha ao iniciar o PostgreSQL 17 embutido', () => {
  it('parâmetro inválido → erro com a etapa e a mensagem do Postgres; nunca "undefined"', async () => {
    const error = await PgServer.start(['-c', 'shared_buffers=nao-numero']).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(PgStartupError);
    const message = (error as Error).message;
    expect(message).toMatch(/^\[pg17:iniciar servidor/);
    expect(message).toMatch(/FATAL:\s+invalid value for parameter "shared_buffers"/); // motivo REAL, do log do servidor
    expect(message).not.toMatch(/undefined/);
    // A senha do processo é um UUID aleatório: nenhum UUID pode aparecer na mensagem.
    expect(message).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  }, 120_000);
});
