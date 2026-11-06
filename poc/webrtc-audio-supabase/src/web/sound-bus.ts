// Barramento de saída dos sons, separado da voz: sons → volume próprio → limitador → saída. Não toca no microfone nem nos
// elementos de áudio dos participantes. Por isso o som nunca é enviado pelo WebRTC, e o volume e a desativação daqui não mudam a voz.

export const MAX_SIMULTANEOUS_SOUNDS = 2;

export type PlayResult = 'playing' | 'busy' | 'blocked';

export interface SoundBusLike {
  unlock(): void;
  decode(bytes: ArrayBuffer): Promise<AudioBuffer>;
  play(buffer: AudioBuffer): PlayResult;
  setVolume(volume: number): void;
  stopAll(): void;
  readonly active: number;
}

type Context = Pick<AudioContext, 'state' | 'destination' | 'currentTime' | 'createGain' | 'createDynamicsCompressor' | 'createBufferSource' | 'decodeAudioData' | 'resume'>;

export class SoundBus implements SoundBusLike {
  private context: Context | null = null;
  private gain: GainNode | null = null;
  private volume = 1;
  private readonly sources = new Set<AudioBufferSourceNode>();
  private readonly createContext: () => Context;

  constructor(createContext: () => Context) {
    this.createContext = createContext;
  }

  get active(): number {
    return this.sources.size;
  }

  private ensure(): Context {
    if (this.context) return this.context;
    const context = this.createContext();
    const gain = context.createGain();
    gain.gain.value = this.volume;
    // Limitador: protege contra pico de um arquivo alto e contra a soma de dois sons. Não normaliza o arquivo.
    const limiter = context.createDynamicsCompressor();
    limiter.threshold.value = -6;
    limiter.knee.value = 3;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.25;
    gain.connect(limiter);
    limiter.connect(context.destination);
    this.context = context;
    this.gain = gain;
    return context;
  }

  /** Chamado em gestos do usuário: o navegador só libera o áudio depois de uma interação. */
  unlock(): void {
    const context = this.ensure();
    if (context.state !== 'running') void context.resume().catch(() => undefined);
  }

  /** O navegador consome o buffer recebido: quem chama passa uma cópia, se ainda precisar dele. */
  decode(bytes: ArrayBuffer): Promise<AudioBuffer> {
    return this.ensure().decodeAudioData(bytes);
  }

  play(buffer: AudioBuffer): PlayResult {
    const context = this.ensure();
    if (context.state !== 'running') {
      void context.resume().catch(() => undefined);
      return 'blocked';
    }
    if (this.sources.size >= MAX_SIMULTANEOUS_SOUNDS) return 'busy';
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain as GainNode);
    source.onended = () => {
      this.sources.delete(source);
      source.disconnect();
    };
    this.sources.add(source);
    source.start();
    return 'playing';
  }

  setVolume(volume: number): void {
    this.volume = Math.min(1, Math.max(0, volume));
    if (this.gain) this.gain.gain.value = this.volume;
  }

  stopAll(): void {
    for (const source of [...this.sources]) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // já terminou
      }
      source.disconnect();
    }
    this.sources.clear();
  }
}
