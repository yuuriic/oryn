// Identificação do runtime e da disponibilidade de Opus, sem depender do DOM (testável).

export interface Brand {
  brand: string;
  version: string;
}

export interface RuntimeInfo {
  engine: 'WebView2' | 'Edge' | 'Chrome' | 'desconhecido';
  /** Versão principal do motor quando disponível (brands) ou do UA. */
  version: string | null;
}

/**
 * O User-Agent do WebView2 é indistinguível do Edge ("Edg/155…"). O brand
 * "Microsoft Edge WebView2" em navigator.userAgentData.brands é o sinal confiável.
 */
export function detectRuntime(userAgent: string, brands: readonly Brand[] | null | undefined): RuntimeInfo {
  const find = (re: RegExp) => brands?.find((b) => re.test(b.brand));
  const webview = find(/WebView2/i);
  if (webview) return { engine: 'WebView2', version: webview.version };
  const edgeBrand = find(/^Microsoft Edge$/i);
  if (edgeBrand) return { engine: 'Edge', version: edgeBrand.version };
  const chromeBrand = find(/^Google Chrome$/i);
  if (chromeBrand) return { engine: 'Chrome', version: chromeBrand.version };

  const edg = /Edg\/(\d+)/.exec(userAgent);
  if (edg) return { engine: 'Edge', version: edg[1] ?? null };
  const chrome = /Chrome\/(\d+)/.exec(userAgent);
  if (chrome) return { engine: 'Chrome', version: chrome[1] ?? null };
  return { engine: 'desconhecido', version: null };
}

export interface CodecCapabilityLike {
  mimeType: string;
  clockRate: number;
  channels?: number | undefined;
  sdpFmtpLine?: string | undefined;
}

export interface OpusSupport {
  supported: boolean;
  /** Ex.: ["audio/opus 48000/2 minptime=10;useinbandfec=1"] */
  entries: string[];
  /** Todos os codecs de áudio anunciados (apenas mimeType, deduplicados). */
  allMimeTypes: string[];
}

/** Interpreta RTCRtpSender.getCapabilities('audio').codecs. */
export function opusSupport(codecs: readonly CodecCapabilityLike[] | null | undefined): OpusSupport {
  const list = codecs ?? [];
  const opus = list.filter((c) => c.mimeType.toLowerCase() === 'audio/opus');
  return {
    supported: opus.length > 0,
    entries: opus.map(
      (c) => `${c.mimeType} ${c.clockRate}/${c.channels ?? 1}${c.sdpFmtpLine ? ` ${c.sdpFmtpLine}` : ''}`,
    ),
    allMimeTypes: [...new Set(list.map((c) => c.mimeType))],
  };
}
