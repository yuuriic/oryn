// "Voltar para a chamada" depois de recarregar a aba: só o ID da sala fica no navegador, nunca credencial, e o
// retorno é sempre validado no servidor e pedido pelo usuário.
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { CallReturnController, RETURN_ROOM_KEY, ReturnRoomStore, evaluateReturn, type KeyValueStore, type ReturnState } from '../src/web/call-return.ts';
import { explainDisconnect, type DisconnectKind } from '../src/web/rooms.ts';
import type { RpcResult } from '../src/web/supabase-signaling.ts';

const ROOM = '0c2a0000-0000-4000-8000-000000000001';
const OTHER = '0c2a0000-0000-4000-8000-000000000002';

class MemoryStore implements KeyValueStore {
  readonly data = new Map<string, string>();
  getItem(k: string): string | null {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.data.set(k, v);
  }
  removeItem(k: string): void {
    this.data.delete(k);
  }
}

const row = (over: Record<string, unknown> = {}) => ({
  room_id: ROOM,
  name: 'Sala de teste',
  role: 'member',
  is_open: true,
  closed_at: null,
  member_count: 2,
  max_members: 2,
  created_at: '2026-11-04T00:00:00.000Z',
  ...over,
});
const list = (rows: unknown[]): RpcResult<unknown[]> => ({ data: rows, error: null });
const failed: RpcResult<unknown[]> = { data: null, error: 'erro' };

function setup(result: RpcResult<unknown[]> | (() => Promise<RpcResult<unknown[]>>), stored: string | null = ROOM) {
  const mem = new MemoryStore();
  if (stored !== null) mem.setItem(RETURN_ROOM_KEY, stored);
  const store = new ReturnRoomStore(() => mem);
  const start = vi.fn();
  const notify = vi.fn();
  const states: ReturnState[] = [];
  const listRooms = vi.fn(typeof result === 'function' ? result : async () => result);
  const c = new CallReturnController({ store, listRooms, start, notify, onChange: (s) => states.push(s) });
  return { c, mem, store, start, notify, states, listRooms };
}

describe('ReturnRoomStore: só um UUID de sala, e nunca quebra a página', () => {
  it('guarda o ID e o lê de volta, com uma única chave', () => {
    const mem = new MemoryStore();
    const store = new ReturnRoomStore(() => mem);
    expect(store.save(ROOM)).toBe(true);
    expect(store.read()).toBe(ROOM);
    expect([...mem.data.keys()]).toEqual([RETURN_ROOM_KEY]);
    store.clear();
    expect(mem.data.size).toBe(0);
  });

  it('recusa gravar o que não é UUID: token, JWT, senha ou e-mail nunca entram', () => {
    const mem = new MemoryStore();
    const store = new ReturnRoomStore(() => mem);
    for (const value of ['eyJhbGciOiJIUzI1NiJ9.e30.abc', 'sb_publishable_chave', 'senha-secreta', 'a@b.example', '', `${ROOM} `, `${ROOM}|token`]) {
      expect(store.save(value), value).toBe(false);
    }
    expect(mem.data.size).toBe(0);
  });

  it('valor adulterado ou inválido na leitura é descartado', () => {
    for (const value of ['nao-e-uuid', 'eyJhbGciOiJIUzI1NiJ9.e30.abc', '<script>', '']) {
      const mem = new MemoryStore();
      mem.setItem(RETURN_ROOM_KEY, value);
      const store = new ReturnRoomStore(() => mem);
      expect(store.read(), value).toBeNull();
      expect(mem.data.has(RETURN_ROOM_KEY), value).toBe(false);
    }
  });

  it('armazenamento indisponível: acesso negado, sem suporte ou cota cheia não lançam', () => {
    const denied = new ReturnRoomStore(() => {
      throw new DOMException('negado', 'SecurityError');
    });
    expect(denied.save(ROOM)).toBe(false);
    expect(denied.read()).toBeNull();
    expect(() => denied.clear()).not.toThrow();

    const absent = new ReturnRoomStore(() => null);
    expect(absent.save(ROOM)).toBe(false);
    expect(absent.read()).toBeNull();
    expect(() => absent.clear()).not.toThrow();

    const broken: KeyValueStore = {
      getItem: () => {
        throw new Error('x');
      },
      setItem: () => {
        throw new DOMException('cheio', 'QuotaExceededError');
      },
      removeItem: () => {
        throw new Error('x');
      },
    };
    const store = new ReturnRoomStore(() => broken);
    expect(store.save(ROOM)).toBe(false);
    expect(store.read()).toBeNull();
    expect(() => store.clear()).not.toThrow();
  });
});

describe('evaluateReturn: o servidor decide', () => {
  it('sala aberta em que a conta é membro: oferece', () => {
    const v = evaluateReturn(ROOM, list([row()]));
    expect(v.kind).toBe('offer');
    expect(v.kind === 'offer' && v.room.name).toBe('Sala de teste');
  });
  it('sala encerrada ou conta fora da sala: não existe mais retorno', () => {
    expect(evaluateReturn(ROOM, list([row({ is_open: false, closed_at: '2026-11-04T01:00:00.000Z' })])).kind).toBe('gone');
    expect(evaluateReturn(ROOM, list([])).kind).toBe('gone');
    expect(evaluateReturn(ROOM, list([row({ room_id: OTHER })])).kind).toBe('gone');
  });
  it('sem como confirmar: falha, resposta fora do contrato ou lista cheia não viram veredito', () => {
    expect(evaluateReturn(ROOM, failed).kind).toBe('unavailable');
    expect(evaluateReturn(ROOM, { data: [{ x: 1 }], error: null }).kind).toBe('unavailable');
    expect(evaluateReturn(ROOM, list([row({ name: '' })])).kind).toBe('unavailable');
    const full = Array.from({ length: 50 }, (_, i) => row({ room_id: `0c2a0000-0000-4000-8000-${String(i + 100).padStart(12, '0')}` }));
    expect(evaluateReturn(ROOM, list(full)).kind).toBe('unavailable');
  });
});

describe('CallReturnController', () => {
  it('oferta: valida no servidor, mostra o nome e NÃO inicia nada sozinha (sem chamada e sem microfone)', async () => {
    const { c, start, listRooms } = setup(list([row()]));
    await c.offer();
    expect(listRooms).toHaveBeenCalledTimes(1);
    expect(c.state).toEqual({ status: 'offer', roomId: ROOM, name: 'Sala de teste', busy: false });
    expect(start).not.toHaveBeenCalled();
  });

  it('sem ID guardado: nem consulta o servidor', async () => {
    const { c, listRooms } = setup(list([row()]), null);
    await c.offer();
    expect(listRooms).not.toHaveBeenCalled();
    expect(c.state.status).toBe('none');
  });

  it('sala encerrada ou inacessível na oferta: limpa o ID e não oferece', async () => {
    for (const rows of [[row({ is_open: false, closed_at: '2026-11-04T01:00:00.000Z' })], []]) {
      const { c, mem } = setup(list(rows));
      await c.offer();
      expect(c.state.status).toBe('none');
      expect(mem.data.size).toBe(0);
    }
  });

  it('servidor indisponível na oferta: não oferece, mas guarda o ID para o próximo login', async () => {
    const { c, mem } = setup(failed);
    await c.offer();
    expect(c.state.status).toBe('none');
    expect(mem.getItem(RETURN_ROOM_KEY)).toBe(ROOM);
    const thrown = setup(async () => {
      throw new Error('rede');
    });
    await thrown.c.offer();
    expect(thrown.c.state.status).toBe('none');
    expect(thrown.mem.getItem(RETURN_ROOM_KEY)).toBe(ROOM);
  });

  it('aceitar: valida de novo no servidor e só então inicia, uma vez, mesmo com dois cliques', async () => {
    const { c, start, listRooms } = setup(list([row()]));
    await c.offer();
    await Promise.all([c.accept(), c.accept()]);
    expect(listRooms).toHaveBeenCalledTimes(2);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(ROOM);
    expect(c.state.status).toBe('none');
  });

  it('aceitar com a sala encerrada depois da oferta: não inicia, limpa e avisa', async () => {
    let rows: unknown[] = [row()];
    const { c, start, mem, notify } = setup(async () => list(rows));
    await c.offer();
    rows = [row({ is_open: false, closed_at: '2026-11-04T01:00:00.000Z' })];
    await c.accept();
    expect(start).not.toHaveBeenCalled();
    expect(mem.data.size).toBe(0);
    expect(c.state.status).toBe('none');
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ tone: 'info' }));
  });

  it('aceitar com o servidor indisponível: não inicia, mantém a oferta e permite tentar de novo', async () => {
    let result: RpcResult<unknown[]> = list([row()]);
    const { c, start, notify } = setup(async () => result);
    await c.offer();
    result = failed;
    await c.accept();
    expect(start).not.toHaveBeenCalled();
    expect(c.state).toEqual(expect.objectContaining({ status: 'offer', busy: false }));
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ tone: 'error' }));
    result = list([row()]);
    await c.accept();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('dispensar é saída voluntária: limpa o ID e a oferta', async () => {
    const { c, mem, start } = setup(list([row()]));
    await c.offer();
    c.dismiss();
    expect(c.state.status).toBe('none');
    expect(mem.data.size).toBe(0);
    expect(start).not.toHaveBeenCalled();
  });

  it('forget(sala) só limpa a própria sala; forget() limpa qualquer uma', () => {
    const { c, mem } = setup(list([]));
    c.forget(OTHER);
    expect(mem.getItem(RETURN_ROOM_KEY)).toBe(ROOM);
    c.forget(ROOM);
    expect(mem.data.size).toBe(0);
    c.remember(OTHER);
    expect(mem.getItem(RETURN_ROOM_KEY)).toBe(OTHER);
    c.forget();
    expect(mem.data.size).toBe(0);
  });

  it('logout no meio da validação: a resposta atrasada não oferece nem inicia nada', async () => {
    let release!: (r: RpcResult<unknown[]>) => void;
    const gate = new Promise<RpcResult<unknown[]>>((r) => (release = r));
    const { c, start } = setup(() => gate);
    const pending = c.offer();
    c.reset();
    release(list([row()]));
    await pending;
    expect(c.state.status).toBe('none');
    expect(start).not.toHaveBeenCalled();
  });

  it('entrar em outra chamada durante a validação do aceite: o retorno pendente não inicia', async () => {
    let result: RpcResult<unknown[]> | Promise<RpcResult<unknown[]>> = list([row()]);
    const { c, start } = setup(async () => result);
    await c.offer();
    let release!: (r: RpcResult<unknown[]>) => void;
    result = new Promise((r) => (release = r));
    const pending = c.accept();
    c.hide();
    release(list([row()]));
    await pending;
    expect(start).not.toHaveBeenCalled();
  });

  it('armazenamento indisponível: a oferta não aparece e a chamada segue sem erro', async () => {
    const store = new ReturnRoomStore(() => null);
    const listRooms = vi.fn();
    const c = new CallReturnController({ store, listRooms, start: vi.fn(), notify: vi.fn(), onChange: () => undefined });
    expect(() => c.remember(ROOM)).not.toThrow();
    await c.offer();
    expect(c.state.status).toBe('none');
    expect(listRooms).not.toHaveBeenCalled();
  });
});

describe('motivo da desconexão também limpa o retorno', () => {
  const run = async (rows: unknown[] | null) => {
    const kinds: DisconnectKind[] = [];
    await explainDisconnect(ROOM, 'técnico', {
      listRooms: async () => (rows ? list(rows) : failed),
      isCurrent: () => true,
      show: () => undefined,
      onKind: (k) => kinds.push(k),
    });
    return kinds;
  };
  it('informa o motivo classificado', async () => {
    expect(await run([row({ is_open: false, closed_at: '2026-11-04T01:00:00.000Z' })])).toEqual(['closed']);
    expect(await run([])).toEqual(['not-member']);
    expect(await run([row()])).toEqual(['expired']);
    expect(await run(null)).toEqual(['unknown']);
  });
  it('resposta descartada (outra chamada começou) não informa motivo', async () => {
    const onKind = vi.fn();
    await explainDisconnect(ROOM, 'técnico', { listRooms: async () => list([]), isCurrent: () => false, show: () => undefined, onKind });
    expect(onKind).not.toHaveBeenCalled();
  });
});

describe('ligação na página', () => {
  const main = readFileSync(new URL('../src/web/main.ts', import.meta.url), 'utf8');
  const handler = (id: string) => new RegExp(`ui\\.${id}\\.addEventListener\\('click', \\(\\) => [\\s\\S]*?\\n?\\}?\\)?;\\n`).exec(main)?.[0] ?? '';

  it('o retorno só começa por clique: start vem do aceite, nunca do login', () => {
    expect(main).toMatch(/ui\.returnBtn\.addEventListener\('click', \(\) => void callReturn\.accept\(\)\)/);
    const enter = /async function enterSession[\s\S]*?\n\}\n/.exec(main)?.[0] ?? '';
    expect(enter).toMatch(/callReturn\.offer\(\)/);
    expect(enter).not.toMatch(/startCall|accept\(\)/);
  });

  it('sair da chamada limpa; recarregar ou fechar a aba (pagehide) não limpa', () => {
    expect(handler('leaveBtn')).toMatch(/callReturn\.forget\(\)/);
    const hide = /addEventListener\('pagehide', \(\) => \{([\s\S]*?)\}\);/.exec(main)?.[1] ?? 'ausente';
    expect(hide).not.toMatch(/callReturn/);
  });

  it('logout e encerramento pelo dono limpam', () => {
    const logout = /ui\.logoutBtn\.addEventListener[\s\S]*?\n\}\);\n/.exec(main)?.[0] ?? '';
    expect(logout).toMatch(/callReturn\.forget\(\)/);
    expect(main).toMatch(/onClosed: async \(roomId\) => \{\s*callReturn\.forget\(roomId\);/);
    expect(main).toMatch(/onKind: \(kind\) => \{\s*if \(kind === 'closed' \|\| kind === 'not-member'\) callReturn\.forget\(/);
  });
});
