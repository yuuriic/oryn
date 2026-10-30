// Copiado de poc/webrtc-audio-wan/src/errors.ts (POC-02B, 6daeb99) para a integração 02C (cliente web).
// POCs isoladas: sem import cruzado. Conteúdo original abaixo, sem alterações.
// Copiado de poc/webrtc-audio-tauri/src/errors.ts (POC-01B, 73b6df7), que por sua vez veio da POC-01A.
// POCs isoladas: sem import cruzado.
export type MediaErrorCode =
  | 'insecure-context'
  | 'unsupported'
  | 'permission-denied'
  | 'no-device'
  | 'device-busy'
  | 'constraints'
  | 'aborted'
  | 'unknown';

export interface DescribedError {
  code: MediaErrorCode;
  message: string;
}

const MESSAGES: Record<MediaErrorCode, string> = {
  'insecure-context':
    'A página não está em contexto seguro; getUserMedia exige localhost, tauri.localhost ou HTTPS.',
  unsupported: 'Este navegador não oferece captura de áudio (navigator.mediaDevices).',
  'permission-denied':
    'Permissão de microfone negada. Libere o acesso nas configurações do site e tente novamente.',
  'no-device': 'Nenhum microfone encontrado. Conecte um dispositivo de entrada e tente novamente.',
  'device-busy':
    'O microfone está indisponível (em uso exclusivo por outro aplicativo ou com falha de hardware).',
  constraints: 'Nenhum microfone atende às restrições solicitadas.',
  aborted: 'A captura do microfone foi interrompida antes de iniciar.',
  unknown: 'Falha inesperada ao acessar o microfone.',
};

/** Traduz falhas de getUserMedia (DOMException.name) para mensagens exibíveis. */
export function describeMediaError(error: unknown): DescribedError {
  const name =
    typeof error === 'object' && error !== null && 'name' in error
      ? String((error as { name: unknown }).name)
      : '';

  let code: MediaErrorCode;
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      code = 'permission-denied';
      break;
    case 'SecurityError':
      code = 'insecure-context';
      break;
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      code = 'no-device';
      break;
    case 'NotReadableError':
    case 'TrackStartError':
      code = 'device-busy';
      break;
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      code = 'constraints';
      break;
    case 'AbortError':
      code = 'aborted';
      break;
    default:
      code = 'unknown';
  }
  return { code, message: MESSAGES[code] };
}

export function messageFor(code: MediaErrorCode): string {
  return MESSAGES[code];
}
