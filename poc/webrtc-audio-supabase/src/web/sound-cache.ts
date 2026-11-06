// Cache local de sons: LRU até 100 MiB, isolado por conta e sala. A chave leva conta, sala, som, versão e hash. Nunca guarda
// token nem URL assinada: só os bytes e metadados. O hash confere integridade, não autorização: quem autoriza é o servidor.
// Sem armazenamento disponível (navegação privada, cota esgotada), tudo segue sem cache: nenhuma falha aqui impede a chamada.

export const SOUND_CACHE_MAX_BYTES = 100 * 1024 * 1024;

export interface SoundCacheMeta {
  key: string;
  account: string;
  room: string;
  size: number;
  lastUsed: number;
}

export interface SoundStore {
  list(): Promise<SoundCacheMeta[]>;
  read(key: string): Promise<ArrayBuffer | null>;
  write(meta: SoundCacheMeta, bytes: ArrayBuffer): Promise<void>;
  touch(key: string, lastUsed: number): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

export const soundKey = (account: string, room: string, asset: string, version: number, sha256: string): string =>
  `${account}|${room}|${asset}|${version}|${sha256}`;

export class SoundCache {
  /** Operações em fila: uma escrita e uma limpeza simultâneas não calculam a ocupação sobre dados velhos. */
  private queue: Promise<unknown> = Promise.resolve();
  private readonly store: SoundStore | null;
  private readonly now: () => number;
  private readonly maxBytes: number;

  constructor(store: SoundStore | null, now: () => number, maxBytes = SOUND_CACHE_MAX_BYTES) {
    this.store = store;
    this.now = now;
    this.maxBytes = maxBytes;
  }

  private run<T>(fallback: T, task: (store: SoundStore) => Promise<T>): Promise<T> {
    const store = this.store;
    if (!store) return Promise.resolve(fallback);
    const next = this.queue.then(() => task(store)).catch(() => fallback);
    this.queue = next;
    return next;
  }

  get(key: string): Promise<ArrayBuffer | null> {
    return this.run(null, async (store) => {
      const bytes = await store.read(key);
      if (bytes) await store.touch(key, this.now());
      return bytes;
    });
  }

  put(account: string, room: string, key: string, bytes: ArrayBuffer): Promise<void> {
    return this.run(undefined, async (store) => {
      if (bytes.byteLength > this.maxBytes) return;
      const metas = (await store.list()).filter((m) => m.key !== key).sort((a, b) => a.lastUsed - b.lastUsed);
      let used = metas.reduce((sum, m) => sum + m.size, 0);
      const evict: string[] = [];
      for (const m of metas) {
        if (used + bytes.byteLength <= this.maxBytes) break;
        evict.push(m.key);
        used -= m.size;
      }
      if (evict.length > 0) await store.remove(evict);
      await store.write({ key, account, room, size: bytes.byteLength, lastUsed: this.now() }, bytes);
    });
  }

  remove(key: string): Promise<void> {
    return this.run(undefined, (store) => store.remove([key]));
  }

  private removeWhere(test: (meta: SoundCacheMeta) => boolean): Promise<void> {
    return this.run(undefined, async (store) => {
      const keys = (await store.list()).filter(test).map((m) => m.key);
      if (keys.length > 0) await store.remove(keys);
    });
  }

  /** Fim da sessão: nada desta conta fica no aparelho. */
  purgeAccount(account: string): Promise<void> {
    return this.removeWhere((m) => m.account === account);
  }

  /** Saída ou remoção da sala. */
  purgeRoom(account: string, room: string): Promise<void> {
    return this.removeWhere((m) => m.account === account && m.room === room);
  }

  /** Só as salas abertas em que a conta continua: cobre remoção e encerramento ocorridos com o aparelho desligado. */
  retainRooms(account: string, rooms: ReadonlySet<string>): Promise<void> {
    return this.removeWhere((m) => m.account === account && !rooms.has(m.room));
  }

  /** Só os sons que continuam no catálogo da sala. */
  retainAssets(account: string, room: string, keys: ReadonlySet<string>): Promise<void> {
    return this.removeWhere((m) => m.account === account && m.room === room && !keys.has(m.key));
  }
}

const request = <T>(req: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('idb'));
  });

const done = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('idb'));
    tx.onerror = () => reject(tx.error ?? new Error('idb'));
  });

export const createBrowserSoundStore = (): SoundStore | null => (typeof indexedDB === 'undefined' ? null : createIndexedDbStore(indexedDB));

/** Metadados e bytes em depósitos separados: listar para o LRU não carrega áudio em memória. */
export function createIndexedDbStore(factory: IDBFactory): SoundStore {
  let opened: Promise<IDBDatabase> | null = null;
  const open = (): Promise<IDBDatabase> => {
    if (!opened) {
      const req = factory.open('oryn-sounds', 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('meta', { keyPath: 'key' });
        req.result.createObjectStore('bytes');
      };
      opened = request(req).catch((error: unknown) => {
        opened = null;
        throw error;
      });
    }
    return opened;
  };
  return {
    async list() {
      const db = await open();
      return request(db.transaction('meta').objectStore('meta').getAll() as IDBRequest<SoundCacheMeta[]>);
    },
    async read(key) {
      const db = await open();
      const found = await request(db.transaction('bytes').objectStore('bytes').get(key) as IDBRequest<ArrayBuffer | undefined>);
      return found ?? null;
    },
    async write(meta, bytes) {
      const db = await open();
      const tx = db.transaction(['meta', 'bytes'], 'readwrite');
      tx.objectStore('meta').put(meta);
      tx.objectStore('bytes').put(bytes, meta.key);
      await done(tx);
    },
    async touch(key, lastUsed) {
      const db = await open();
      const tx = db.transaction('meta', 'readwrite');
      const store = tx.objectStore('meta');
      const meta = await request(store.get(key) as IDBRequest<SoundCacheMeta | undefined>);
      if (meta) store.put({ ...meta, lastUsed });
      await done(tx);
    },
    async remove(keys) {
      const db = await open();
      const tx = db.transaction(['meta', 'bytes'], 'readwrite');
      for (const key of keys) {
        tx.objectStore('meta').delete(key);
        tx.objectStore('bytes').delete(key);
      }
      await done(tx);
    },
  };
}
