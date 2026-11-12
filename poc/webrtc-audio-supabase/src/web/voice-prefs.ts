// Volume de cada participante, só neste aparelho: quanto da voz de alguém toca aqui e se ela está silenciada para mim.
// Não muda o microfone de ninguém nem o que os outros ouvem: é o `volume` e o `muted` do <audio> daquele participante.
//
// Chave: a conta logada e o `participant_ref` da pessoa (estável na sala, diferente entre salas). Assim a preferência
// sobrevive à reconexão (a sessão muda, a referência não) e não passa de uma conta para outra no mesmo aparelho.
// Armazenamento indisponível ou valor estranho: vale o padrão (100%, ouvindo). Não guarda nome, sessão nem credencial.

export interface VoicePref {
  /** 0 a 1. Nunca acima de 1: sem amplificação neste incremento. */
  volume: number;
  /** Silenciado só para esta conta, neste aparelho. */
  muted: boolean;
}

export const VOICE_PREF_DEFAULT: Readonly<VoicePref> = Object.freeze({ volume: 1, muted: false });

/** O mínimo do armazenamento (o do navegador em produção, por browserPrefStorage). */
export interface PrefStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const KEY = 'oryn.voice.v1';
/** Limites do que fica guardado: contas neste aparelho e pessoas por conta. As mais antigas saem primeiro. */
const MAX_ACCOUNTS = 8;
const MAX_REFS = 200;
/** participant_ref: 32 hexadecimais (oryn.member_ref). O id da conta: o uuid do Auth. */
const REF = /^[0-9a-f]{32}$/;
const ACCOUNT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Guardado como [porcentagem inteira 0–100, silenciado 0/1]: compacto e sem campos livres. */
type Stored = Record<string, Record<string, [number, 0 | 1]>>;

/** Porcentagem inteira de 0 a 100. Qualquer outra coisa vira 100. */
export function clampPercent(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return 100;
  return Math.min(100, Math.max(0, Math.round(n)));
}

/** Texto curto do estado, para o cartão e o botão: "Silenciado para você", "Volume 40%" ou nada no padrão. */
export function voicePrefLabel(pref: VoicePref): string | null {
  if (pref.muted) return 'Silenciado para você';
  const pct = Math.round(pref.volume * 100);
  return pct === 100 ? null : `Volume ${pct}%`;
}

export class VoicePrefs {
  private readonly storage: PrefStorage | null;
  private account: string | null = null;
  private data: Stored = {};

  constructor(storage: PrefStorage | null) {
    this.storage = storage;
    this.data = this.load();
  }

  /** Conta logada. `null` (sem login): só o padrão, nada é guardado. */
  setAccount(account: string | null): void {
    this.account = account !== null && ACCOUNT.test(account) ? account : null;
    this.data = this.load(); // outra aba pode ter mudado
  }

  get(ref: string): VoicePref {
    const entry = this.account && REF.test(ref) ? this.data[this.account]?.[ref] : undefined;
    return entry ? { volume: entry[0] / 100, muted: entry[1] === 1 } : { ...VOICE_PREF_DEFAULT };
  }

  /** Volume em porcentagem (0–100). Devolve a preferência resultante. */
  setVolume(ref: string, percent: number): VoicePref {
    return this.put(ref, { ...this.get(ref), volume: clampPercent(percent) / 100 });
  }

  setMuted(ref: string, muted: boolean): VoicePref {
    return this.put(ref, { ...this.get(ref), muted });
  }

  private put(ref: string, pref: VoicePref): VoicePref {
    const account = this.account;
    if (!account || !REF.test(ref)) return pref;
    const latest = this.load(); // não desfaz o que outra aba gravou para outras pessoas
    const people = { ...(latest[account] ?? {}) };
    delete people[ref]; // reinserir põe no fim: as menos usadas saem primeiro
    if (pref.muted || pref.volume !== 1) people[ref] = [Math.round(pref.volume * 100), pref.muted ? 1 : 0];
    const refs = Object.keys(people);
    for (const old of refs.slice(0, Math.max(0, refs.length - MAX_REFS))) delete people[old];
    delete latest[account];
    if (Object.keys(people).length > 0) latest[account] = people;
    const accounts = Object.keys(latest);
    for (const old of accounts.slice(0, Math.max(0, accounts.length - MAX_ACCOUNTS))) delete latest[old];
    this.data = latest;
    try {
      this.storage?.setItem(KEY, JSON.stringify(latest));
    } catch {
      // vale até fechar a página
    }
    return pref;
  }

  /** Só entradas válidas: conta uuid, referência de 32 hex, porcentagem inteira 0–100 e 0/1. O resto é descartado. */
  private load(): Stored {
    let raw: unknown;
    try {
      raw = JSON.parse(this.storage?.getItem(KEY) ?? 'null');
    } catch {
      return {};
    }
    const out: Stored = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const [account, people] of Object.entries(raw as Record<string, unknown>)) {
      if (!ACCOUNT.test(account) || !people || typeof people !== 'object' || Array.isArray(people)) continue;
      const clean: Record<string, [number, 0 | 1]> = {};
      for (const [ref, v] of Object.entries(people as Record<string, unknown>)) {
        if (!REF.test(ref) || !Array.isArray(v) || v.length !== 2) continue;
        const [pct, muted] = v as unknown[];
        if (typeof pct !== 'number' || !Number.isInteger(pct) || pct < 0 || pct > 100 || (muted !== 0 && muted !== 1)) continue;
        clean[ref] = [pct, muted];
      }
      if (Object.keys(clean).length > 0) out[account] = clean;
    }
    return out;
  }
}

/** O armazenamento local do navegador, se existir e puder ser lido. Único ponto deste módulo que o toca. */
export function browserPrefStorage(): PrefStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
