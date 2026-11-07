// Arquivos de áudio sintéticos para testes: bytes construídos aqui, com os cabeçalhos reais de MP3 e WAV. Sem arquivo de terceiros.

/** Quadro MPEG-1 Layer III, 128 kbit/s, 44,1 kHz: 417 bytes, 26,12 ms. O miolo é preenchido com zeros. */
const MP3_FRAME = (() => {
  const frame = new Uint8Array(417);
  frame.set([0xff, 0xfb, 0x90, 0x00]);
  return frame;
})();
export const MP3_FRAME_MS = (1152 / 44100) * 1000;

export function mp3(ms: number, options: { id3v2?: number; id3v1?: boolean } = {}): Uint8Array {
  const frames = Math.ceil(ms / MP3_FRAME_MS);
  const id3 = options.id3v2 ?? 0;
  const out = new Uint8Array((id3 ? id3 + 10 : 0) + frames * MP3_FRAME.length + (options.id3v1 ? 128 : 0));
  let at = 0;
  if (id3) {
    out.set([0x49, 0x44, 0x33, 3, 0, 0, (id3 >> 21) & 0x7f, (id3 >> 14) & 0x7f, (id3 >> 7) & 0x7f, id3 & 0x7f]);
    at = id3 + 10;
  }
  for (let i = 0; i < frames; i++, at += MP3_FRAME.length) out.set(MP3_FRAME, at);
  if (options.id3v1) out.set([0x54, 0x41, 0x47], at);
  return out;
}

export interface WavOptions {
  rate?: number;
  channels?: number;
  bits?: number;
  tag?: number;
  extraChunk?: boolean;
}

export function wav(ms: number, o: WavOptions = {}): Uint8Array {
  const rate = o.rate ?? 8000;
  const channels = o.channels ?? 1;
  const bits = o.bits ?? 16;
  const block = (channels * bits) / 8;
  const data = Math.round((rate * ms) / 1000) * block;
  const extra = o.extraChunk ? 8 + 4 : 0;
  const out = new Uint8Array(12 + 24 + extra + 8 + data + (data % 2));
  const view = new DataView(out.buffer);
  const tag = (at: number, s: string) => [...s].forEach((c, i) => (out[at + i] = c.charCodeAt(0)));
  tag(0, 'RIFF');
  view.setUint32(4, out.length - 8, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, o.tag ?? 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * block, true);
  view.setUint16(32, block, true);
  view.setUint16(34, bits, true);
  let at = 36;
  if (o.extraChunk) {
    tag(at, 'LIST');
    view.setUint32(at + 4, 4, true);
    at += 12;
  }
  tag(at, 'data');
  view.setUint32(at + 4, data, true);
  return out;
}
