// Copiado de poc/webrtc-audio-tauri/src/redact.ts (POC-01B, 73b6df7), que por sua vez veio da POC-01A.
// POCs isoladas: sem import cruzado.
// Resumos seguros para o log em tela. SDP e candidatos ICE completos podem conter
// endereços IP, portas e fingerprints; aqui só extraímos metadados não sensíveis.

export interface CandidateLike {
  type?: string | null;
  protocol?: string | null;
}

/** Ex.: "host/udp". Nunca inclui endereço, porta, foundation ou ufrag. */
export function describeCandidate(candidate: CandidateLike | null): string {
  if (!candidate) return 'fim da coleta';
  const type = candidate.type ?? 'desconhecido';
  const protocol = candidate.protocol ?? '?';
  return `${type}/${protocol}`;
}

/** Ex.: "offer — mídia: audio". Lê apenas as linhas m= (tipo de mídia). */
export function describeDescription(
  description: { type: string; sdp?: string | undefined } | null,
): string {
  if (!description) return 'descrição ausente';
  const kinds = (description.sdp ?? '')
    .split(/\r?\n/)
    .filter((line) => line.startsWith('m='))
    .map((line) => line.slice(2).split(' ')[0] ?? '?');
  return `${description.type} — mídia: ${kinds.length > 0 ? kinds.join(', ') : 'nenhuma'}`;
}
