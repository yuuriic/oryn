// Copiado de poc/webrtc-audio-wan/src/codecs.ts (POC-02B, 6daeb99) para a integração 02C (cliente web).
// POCs isoladas: sem import cruzado. Conteúdo original abaixo, sem alterações.
// Preferência de codec: Opus primeiro, mantendo os demais (RED, G722, PCMU…) como fallback.

export interface CodecLike {
  mimeType: string;
}

export function preferOpus<T extends CodecLike>(codecs: readonly T[]): T[] {
  const isOpus = (c: T) => c.mimeType.toLowerCase() === 'audio/opus';
  return [...codecs.filter(isOpus), ...codecs.filter((c) => !isOpus(c))];
}
