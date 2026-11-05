// Sessão de login persistida com o mecanismo oficial do Supabase Auth (persistSession + storage).
//
// Este é o único módulo do cliente que usa o armazenamento local do navegador, e guarda ali apenas o que o próprio
// Auth grava, sob uma chave fixa (tests/web-config.test.ts confere). A senha nunca é gravada. Riscos residuais de
// guardar a sessão no navegador: runbook §14.6.

import { isAuthRetryableFetchError, isAuthSessionMissingError, type Session, type SupabaseClient } from '@supabase/supabase-js';

export const AUTH_STORAGE_KEY = 'oryn.auth';
/** O Auth deriva estas chaves auxiliares de `storageKey`. */
const AUTH_KEYS = [AUTH_STORAGE_KEY, `${AUTH_STORAGE_KEY}-code-verifier`, `${AUTH_STORAGE_KEY}-user`];

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface AuthStorage extends KeyValueStore {
  /** Remove tudo o que o Auth grava, sem depender do servidor. */
  purge(): void;
}

const browserStore = (): KeyValueStore | null => window.localStorage;

/** Armazenamento negado, ausente ou cheio: a sessão fica em memória e simplesmente não sobrevive à recarga. */
export function createAuthStorage(getStore: () => KeyValueStore | null = browserStore): AuthStorage {
  const memory = new Map<string, string>();
  const attempt = <T>(run: (store: KeyValueStore) => T): { ok: true; value: T } | { ok: false } => {
    try {
      const store = getStore();
      return store ? { ok: true, value: run(store) } : { ok: false };
    } catch {
      return { ok: false };
    }
  };
  const remove = (key: string): void => {
    memory.delete(key);
    attempt((store) => store.removeItem(key));
  };
  return {
    getItem: (key) => {
      if (memory.has(key)) return memory.get(key)!;
      const read = attempt((store) => store.getItem(key));
      return read.ok ? read.value : null;
    },
    setItem: (key, value) => {
      if (attempt((store) => store.setItem(key, value)).ok) memory.delete(key);
      else memory.set(key, value);
    },
    removeItem: remove,
    purge: () => AUTH_KEYS.forEach(remove),
  };
}

export function authOptions(storage: AuthStorage) {
  return { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: AUTH_STORAGE_KEY, storage };
}

export type RestoredSession =
  | { status: 'none' | 'revoked' | 'unavailable' }
  /** `unverified`: sem rede para confirmar no servidor; as chamadas seguintes é que vão validar. */
  | { status: 'valid' | 'unverified'; session: Session };

/** Ao abrir a página: renova o token se preciso e confirma no servidor que a sessão não foi revogada. */
export async function restoreSession(client: SupabaseClient, storage: AuthStorage): Promise<RestoredSession> {
  const { data, error } = await client.auth.getSession();
  if (error) {
    if (isAuthRetryableFetchError(error)) return { status: 'unavailable' };
    storage.purge();
    return { status: 'revoked' };
  }
  const session = data.session;
  if (!session) return { status: 'none' };
  const user = await client.auth.getUser(session.access_token);
  if (!user.error) return { status: 'valid', session };
  if (isAuthSessionMissingError(user.error) || user.error.status === 401 || user.error.status === 403) {
    await logout(client, storage);
    return { status: 'revoked' };
  }
  return { status: 'unverified', session };
}

/** Encerra a sessão no servidor quando dá; o navegador fica limpo de qualquer jeito. */
export async function logout(client: SupabaseClient, storage: AuthStorage): Promise<void> {
  await client.auth.signOut({ scope: 'local' }).catch(() => undefined);
  storage.purge();
}
