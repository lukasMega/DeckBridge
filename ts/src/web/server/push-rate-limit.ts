// In-memory rate limits for the push API (injectable clock for tests).

export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
    private readonly now: () => number,
  ) {
    this.tokens = capacity;
    this.last = now();
  }

  private refill(): void {
    const t = this.now();
    this.tokens = Math.min(
      this.capacity,
      this.tokens + ((t - this.last) / 1000) * this.refillPerSec,
    );
    this.last = t;
  }

  /** Take one token; 0 on success, else seconds until one is available (ceil, ≥ 1). */
  take(): number {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return 0;
    }
    return Math.max(1, Math.ceil((1 - this.tokens) / this.refillPerSec));
  }

  /** Seconds until one token is available, without taking it; 0 = available now. */
  wait(): number {
    this.refill();
    return this.tokens >= 1 ? 0 : Math.max(1, Math.ceil((1 - this.tokens) / this.refillPerSec));
  }

  get full(): boolean {
    this.refill();
    return this.tokens >= this.capacity;
  }
}

const TOKEN_CAPACITY = 20;
const TOKEN_REFILL_PER_S = 10;
const GLOBAL_CAPACITY = 50;
const GLOBAL_REFILL_PER_S = 25;
const FAIL_CAPACITY = 10;
const FAIL_REFILL_PER_S = 10 / 60;
const FAIL_MAP_MAX = 256;
const TOKEN_MAP_MAX = 64;

export class PushRateLimits {
  private readonly perToken = new Map<string, TokenBucket>();
  private readonly failed = new Map<string, TokenBucket>();
  private readonly global: TokenBucket;

  constructor(private readonly now: () => number = Date.now) {
    this.global = new TokenBucket(GLOBAL_CAPACITY, GLOBAL_REFILL_PER_S, now);
  }

  /** Per-token + global; 0 = allowed, else Retry-After seconds. */
  takePush(tokenId: string): number {
    let bucket = this.perToken.get(tokenId);
    if (!bucket) {
      // Revoked tokens leave idle buckets behind; bound the map.
      if (this.perToken.size >= TOKEN_MAP_MAX) this.perToken.clear();
      bucket = new TokenBucket(TOKEN_CAPACITY, TOKEN_REFILL_PER_S, this.now);
      this.perToken.set(tokenId, bucket);
    }
    const own = bucket.take();
    if (own > 0) return own;
    return this.global.take();
  }

  /** Before token lookup: 0 = allowed; else Retry-After seconds for this address. */
  checkFailedAuth(remote: string): number {
    return this.failed.get(remote)?.wait() ?? 0;
  }

  noteFailedAuth(remote: string): void {
    let bucket = this.failed.get(remote);
    if (!bucket) {
      if (this.failed.size >= FAIL_MAP_MAX) this.prune();
      bucket = new TokenBucket(FAIL_CAPACITY, FAIL_REFILL_PER_S, this.now);
      this.failed.set(remote, bucket);
    }
    bucket.take();
  }

  /** Drop idle (full) buckets first, then the oldest entry. */
  private prune(): void {
    for (const [k, b] of this.failed) if (b.full) this.failed.delete(k);
    if (this.failed.size >= FAIL_MAP_MAX) {
      const oldest = this.failed.keys().next().value;
      if (oldest !== undefined) this.failed.delete(oldest);
    }
  }
}
