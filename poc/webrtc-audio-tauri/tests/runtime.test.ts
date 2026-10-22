import { describe, expect, it } from 'vitest';
import { detectRuntime, opusSupport } from '../src/runtime';

const EDGE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0';
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';

describe('detectRuntime', () => {
  it('identifica WebView2 pelos brands mesmo com UA de Edge', () => {
    const brands = [
      { brand: 'Chromium', version: '155' },
      { brand: 'Microsoft Edge WebView2', version: '155' },
      { brand: 'Not.A/Brand', version: '99' },
    ];
    expect(detectRuntime(EDGE_UA, brands)).toEqual({ engine: 'WebView2', version: '155' });
  });

  it('identifica Edge e Chrome pelos brands', () => {
    expect(detectRuntime(EDGE_UA, [{ brand: 'Microsoft Edge', version: '155' }]).engine).toBe('Edge');
    expect(detectRuntime(CHROME_UA, [{ brand: 'Google Chrome', version: '155' }]).engine).toBe('Chrome');
  });

  it('recorre ao UA sem brands', () => {
    expect(detectRuntime(EDGE_UA, undefined)).toEqual({ engine: 'Edge', version: '155' });
    expect(detectRuntime(CHROME_UA, null)).toEqual({ engine: 'Chrome', version: '155' });
    expect(detectRuntime('curl/8', [])).toEqual({ engine: 'desconhecido', version: null });
  });
});

describe('opusSupport', () => {
  it('detecta Opus e lista os codecs de áudio', () => {
    const result = opusSupport([
      { mimeType: 'audio/opus', clockRate: 48000, channels: 2, sdpFmtpLine: 'minptime=10;useinbandfec=1' },
      { mimeType: 'audio/red', clockRate: 48000, channels: 2 },
      { mimeType: 'audio/PCMU', clockRate: 8000 },
      { mimeType: 'audio/PCMU', clockRate: 8000 },
    ]);
    expect(result.supported).toBe(true);
    expect(result.entries).toEqual(['audio/opus 48000/2 minptime=10;useinbandfec=1']);
    expect(result.allMimeTypes).toEqual(['audio/opus', 'audio/red', 'audio/PCMU']);
  });

  it('informa ausência de Opus e trata lista nula', () => {
    expect(opusSupport([{ mimeType: 'audio/PCMA', clockRate: 8000 }]).supported).toBe(false);
    expect(opusSupport(null)).toEqual({ supported: false, entries: [], allMimeTypes: [] });
  });
});
