// Validação do conteúdo dos sons: só os bytes decidem. O mesmo módulo roda na função `sound-media` e no navegador.
import { describe, expect, it } from 'vitest';
import { checkSound, MAX_SOUND_BYTES, sha256Hex } from '../supabase/functions/_shared/sound-validate.ts';
import { mp3, MP3_FRAME_MS, wav } from './helpers/sound-files.ts';

const reason = (b: Uint8Array) => {
  const r = checkSound(b);
  return r.ok ? 'ok' : r.reason;
};
const text = (s: string) => new TextEncoder().encode(s);

describe('MP3', () => {
  it('aceita e mede a duração real pelos quadros', () => {
    const r = checkSound(mp3(1000));
    expect(r).toMatchObject({ ok: true, mime: 'audio/mpeg' });
    if (r.ok) expect(Math.abs(r.durationMs - 1000)).toBeLessThanOrEqual(MP3_FRAME_MS + 1);
  });

  it('aceita ID3v2 no início e ID3v1 no fim, sem contar como áudio', () => {
    const plain = checkSound(mp3(500));
    const tagged = checkSound(mp3(500, { id3v2: 2048, id3v1: true }));
    expect(tagged.ok && plain.ok && tagged.durationMs === plain.durationMs).toBe(true);
  });

  it('aceita etiqueta APEv2 no fim; tamanho incoerente recusa', () => {
    const audio = mp3(500);
    const ape = (declared: number, bodyBytes: number) => {
      const footer = new Uint8Array(32);
      footer.set(new TextEncoder().encode('APETAGEX'));
      new DataView(footer.buffer).setUint32(12, declared, true);
      return new Uint8Array([...audio, ...new Uint8Array(bodyBytes), ...footer]);
    };
    const plain = checkSound(audio);
    const tagged = checkSound(ape(64, 32));
    expect(tagged.ok && plain.ok && tagged.durationMs === plain.durationMs).toBe(true);
    expect(reason(ape(10_000_000, 32))).toBe('invalid-format');
    expect(reason(ape(8, 0))).toBe('invalid-format');
  });

  it('recusa acima de 10 s, medido pelos quadros', () => {
    expect(reason(mp3(9_900))).toBe('ok');
    expect(reason(mp3(10_100))).toBe('too-long');
  });

  it('recusa quadro final cortado', () => {
    const file = mp3(1000);
    expect(reason(file.subarray(0, file.length - 10))).toBe('truncated');
  });

  it('recusa lixo entre quadros', () => {
    const file = mp3(1000).slice();
    file[417 * 3] = 0x00;
    expect(reason(file)).toBe('invalid-format');
  });

  it('recusa sequência curta demais para ser áudio', () => {
    expect(reason(mp3(30))).toBe('truncated');
  });

  it('recusa Layer I e II, índice proibido e taxa reservada', () => {
    const variant = (byte: number, value: number) => {
      const file = mp3(1000).slice();
      file[byte] = value;
      return reason(file);
    };
    expect(variant(1, 0xfd)).toBe('invalid-format'); // Layer II
    expect(variant(2, 0xf0)).toBe('invalid-format'); // índice de taxa proibido
    expect(variant(2, 0x00)).toBe('invalid-format'); // "free format"
    expect(variant(2, 0x9c)).toBe('invalid-format'); // taxa de amostragem reservada
  });

  it('recusa ID3v2 que declara passar do fim do arquivo', () => {
    const file = mp3(100, { id3v2: 64 }).slice();
    file[8] = 0x7f;
    expect(reason(file)).toBe('truncated');
  });
});

describe('WAV', () => {
  it('aceita PCM e mede a duração pelos dados', () => {
    expect(checkSound(wav(1500))).toMatchObject({ ok: true, mime: 'audio/wav', durationMs: 1500 });
    expect(checkSound(wav(1000, { rate: 44100, channels: 2, bits: 16 }))).toMatchObject({ ok: true, durationMs: 1000 });
    expect(checkSound(wav(1000, { bits: 32, tag: 3 }))).toMatchObject({ ok: true, durationMs: 1000 });
  });

  it('aceita pedaços extras antes dos dados', () => {
    expect(checkSound(wav(500, { extraChunk: true }))).toMatchObject({ ok: true, durationMs: 500 });
  });

  it('recusa acima de 10 s', () => {
    expect(reason(wav(10_000))).toBe('ok');
    expect(reason(wav(10_001))).toBe('too-long');
  });

  it('recusa arquivo cortado e cauda não declarada', () => {
    const file = wav(1000);
    expect(reason(file.subarray(0, file.length - 100))).toBe('truncated');
    const longer = new Uint8Array(file.length + 4);
    longer.set(file);
    expect(reason(longer)).toBe('invalid-format');
  });

  it('recusa codec que não é PCM, cabeçalho incoerente e arquivo sem dados', () => {
    expect(reason(wav(1000, { tag: 85 }))).toBe('invalid-format');
    expect(reason(wav(1000, { bits: 12 }))).toBe('invalid-format');
    const bad = wav(1000).slice();
    new DataView(bad.buffer).setUint32(28, 1, true); // byteRate incoerente
    expect(reason(bad)).toBe('invalid-format');
    expect(reason(wav(0))).toBe('invalid-format');
  });

  it('não confunde tamanho de pedaço gigante com arquivo válido', () => {
    const bad = wav(1000).slice();
    new DataView(bad.buffer).setUint32(40, 0xffffffff, true);
    expect(reason(bad)).toBe('truncated');
  });
});

describe('falsificação e limites', () => {
  it.each([
    ['HTML com nome de som', text('<html><script>alert(1)</script></html>')],
    ['SVG', text('<svg xmlns="http://www.w3.org/2000/svg"></svg>')],
    ['executável', new Uint8Array([0x4d, 0x5a, 0x90, 0x00, ...new Array<number>(500).fill(0)])],
    ['Ogg', text('OggS' + 'x'.repeat(400))],
    ['RIFF que não é WAVE', text('RIFF\x04\x00\x00\x00AVI ')],
  ])('recusa %s, qualquer que seja o MIME declarado', (_, bytes) => {
    expect(reason(bytes)).toBe('invalid-format');
  });

  it('um cabeçalho de MP3 seguido de HTML não passa', () => {
    const file = new Uint8Array(1000).fill(0x3c);
    file.set(mp3(30).subarray(0, 417));
    expect(reason(file)).toBe('invalid-format');
  });

  it('vazio e acima de 2 MiB', () => {
    expect(reason(new Uint8Array(0))).toBe('empty');
    expect(reason(new Uint8Array(MAX_SOUND_BYTES + 1))).toBe('too-large');
  });

  it('sha256Hex: valor conhecido', async () => {
    expect(await sha256Hex(text('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
