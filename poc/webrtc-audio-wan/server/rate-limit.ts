// Token bucket por conexão: limita rajadas de mensagens de sinalização.

export interface TokenBucketOptions {
  /** Capacidade (rajada máxima). */
  capacity: number;
  /** Tokens repostos por segundo. */
  refillPerSecond: number;
  now: () => number;
}

export class TokenBucket {
  private tokens: number;
  private last: number;
  private readonly options: TokenBucketOptions;

  constructor(options: TokenBucketOptions) {
    this.options = options;
    this.tokens = options.capacity;
    this.last = options.now();
  }

  /** Consome um token; retorna false quando o limite foi excedido. */
  take(): boolean {
    const now = this.options.now();
    const elapsed = Math.max(0, now - this.last) / 1000;
    this.last = now;
    this.tokens = Math.min(this.options.capacity, this.tokens + elapsed * this.options.refillPerSecond);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
