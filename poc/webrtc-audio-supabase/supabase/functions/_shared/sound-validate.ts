// Validação do CONTEÚDO de um som, sem transcodificar. Puro: roda no Deno (função `sound-media`, que decide) e no navegador
// (aviso imediato ao dono, sem valor de segurança). MIME e extensão declarados não entram na decisão: só os bytes.
// A leitura percorre o arquivo inteiro. Lixo entre quadros, quadro cortado ou cabeçalho incoerente recusam o arquivo.

export const MAX_SOUND_BYTES = 2 * 1024 * 1024;
export const MAX_SOUND_MS = 10_000;

export type SoundReject = 'empty' | 'too-large' | 'invalid-format' | 'truncated' | 'too-long';
export type SoundMime = 'audio/mpeg' | 'audio/wav';
export type SoundCheck = { ok: true; mime: SoundMime; durationMs: number; sizeBytes: number } | { ok: false; reason: SoundReject };

const fail = (reason: SoundReject): SoundCheck => ({ ok: false, reason });
const text = (b: Uint8Array, at: number, n: number): string => String.fromCharCode(...b.subarray(at, at + n));

/** MPEG-1, 2 e 2.5, só Layer III. Taxas em kbit/s, por índice. */
const BITRATES_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const BITRATES_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
/** Quadros mínimos para um arquivo ser áudio, e não um cabeçalho solto: cerca de 100 ms. */
const MIN_MP3_FRAMES = 4;

function checkMp3(b: Uint8Array): SoundCheck {
  let at = 0;
  if (b.length >= 10 && text(b, 0, 3) === 'ID3') {
    if (b[3] === 0xff || b[4] === 0xff || (b[6]! | b[7]! | b[8]! | b[9]!) & 0x80) return fail('invalid-format');
    const size = (b[6]! << 21) | (b[7]! << 14) | (b[8]! << 7) | b[9]!;
    const footer = b[5]! & 0x10 ? 10 : 0;
    at = 10 + size + footer;
    if (at >= b.length) return fail('truncated');
  }
  // Caudas aceitas, sem contar como áudio: ID3v1 (128 bytes finais) e APEv2 antes dela. Qualquer outra sobra recusa o arquivo.
  let end = b.length >= 128 && text(b, b.length - 128, 3) === 'TAG' ? b.length - 128 : b.length;
  if (end >= 32 && text(b, end - 32, 8) === 'APETAGEX') {
    const total = u32(b, end - 32 + 12) + (b[end - 32 + 23]! & 0x80 ? 32 : 0);
    if (total < 32 || total > end - at) return fail('invalid-format');
    end -= total;
  }
  let frames = 0;
  let seconds = 0;
  let firstRate = 0;
  while (at < end) {
    if (at + 4 > end) return fail(frames ? 'truncated' : 'invalid-format');
    if (b[at] !== 0xff || (b[at + 1]! & 0xe0) !== 0xe0) return fail('invalid-format');
    const version = (b[at + 1]! >> 3) & 3;
    const layer = (b[at + 1]! >> 1) & 3;
    const bitrateIndex = b[at + 2]! >> 4;
    const rateIndex = (b[at + 2]! >> 2) & 3;
    const padding = (b[at + 2]! >> 1) & 1;
    if (version === 1 || layer !== 1 || rateIndex === 3) return fail('invalid-format');
    const v1 = version === 3;
    const kbps = (v1 ? BITRATES_V1 : BITRATES_V2)[bitrateIndex]!;
    if (kbps === 0) return fail('invalid-format'); // "free format" ou índice proibido
    const rate = RATES[version]![rateIndex]!;
    if (frames === 0) firstRate = rate;
    else if (rate !== firstRate) return fail('invalid-format');
    const samples = v1 ? 1152 : 576;
    const length = Math.floor(((samples / 8) * (kbps * 1000)) / rate) + padding;
    if (at + length > end) return fail('truncated');
    at += length;
    frames += 1;
    seconds += samples / rate;
  }
  if (frames < MIN_MP3_FRAMES) return fail(frames ? 'truncated' : 'invalid-format');
  return finish('audio/mpeg', seconds, b.length);
}

const u16 = (b: Uint8Array, at: number): number => b[at]! | (b[at + 1]! << 8);
const u32 = (b: Uint8Array, at: number): number => (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0;
const WAVE_PCM = 1;
const WAVE_FLOAT = 3;
const WAVE_EXTENSIBLE = 0xfffe;

function checkWav(b: Uint8Array): SoundCheck {
  const riff = u32(b, 4) + 8;
  if (riff > b.length) return fail('truncated');
  if (riff < b.length) return fail('invalid-format');
  let at = 12;
  let byteRate = 0;
  let blockAlign = 0;
  let dataBytes = 0;
  while (at < b.length) {
    if (at + 8 > b.length) return fail('truncated');
    const id = text(b, at, 4);
    const size = u32(b, at + 4);
    const body = at + 8;
    if (body + size > b.length) return fail('truncated');
    if (id === 'fmt ') {
      if (byteRate || size < 16) return fail('invalid-format');
      let tag = u16(b, body);
      const channels = u16(b, body + 2);
      const rate = u32(b, body + 4);
      byteRate = u32(b, body + 8);
      blockAlign = u16(b, body + 12);
      const bits = u16(b, body + 14);
      if (tag === WAVE_EXTENSIBLE) {
        if (size < 40) return fail('invalid-format');
        tag = u16(b, body + 24);
      }
      if (tag !== WAVE_PCM && tag !== WAVE_FLOAT) return fail('invalid-format');
      if (channels < 1 || channels > 2 || rate < 8000 || rate > 192000) return fail('invalid-format');
      if (bits !== 8 && bits !== 16 && bits !== 24 && bits !== 32) return fail('invalid-format');
      if (tag === WAVE_FLOAT && bits !== 32) return fail('invalid-format');
      if (blockAlign !== (channels * bits) / 8 || byteRate !== rate * blockAlign) return fail('invalid-format');
    } else if (id === 'data') {
      if (!byteRate || dataBytes || size === 0 || size % blockAlign !== 0) return fail('invalid-format');
      dataBytes = size;
    }
    at = body + size + (size % 2);
    if (at > b.length) return fail(id === 'data' ? 'truncated' : 'invalid-format');
  }
  if (!byteRate || !dataBytes) return fail('invalid-format');
  return finish('audio/wav', dataBytes / byteRate, b.length);
}

function finish(mime: SoundMime, seconds: number, sizeBytes: number): SoundCheck {
  const durationMs = Math.ceil(seconds * 1000);
  if (durationMs > MAX_SOUND_MS) return fail('too-long');
  return { ok: true, mime, durationMs: Math.max(durationMs, 1), sizeBytes };
}

export function checkSound(bytes: Uint8Array): SoundCheck {
  if (bytes.length === 0) return fail('empty');
  if (bytes.length > MAX_SOUND_BYTES) return fail('too-large');
  if (bytes.length >= 12 && text(bytes, 0, 4) === 'RIFF' && text(bytes, 8, 4) === 'WAVE') return checkWav(bytes);
  return checkMp3(bytes);
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
