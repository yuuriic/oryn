// Preferência de codec: Opus primeiro, mantendo os demais (RED, G722, PCMU…) como fallback.

export interface CodecLike {
  mimeType: string;
}

export function preferOpus<T extends CodecLike>(codecs: readonly T[]): T[] {
  const isOpus = (c: T) => c.mimeType.toLowerCase() === 'audio/opus';
  return [...codecs.filter(isOpus), ...codecs.filter((c) => !isOpus(c))];
}
