export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
}

interface Bucket {
  count: number;
  windowStartedAt: number;
}

export class SlidingWindowRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly maxRequests: number,
    private readonly windowMs: number,
    private readonly maxKeys = 10_000,
  ) {
    if (!Number.isInteger(maxRequests) || maxRequests <= 0) throw new Error('maxRequests must be positive');
    if (!Number.isInteger(windowMs) || windowMs <= 0) throw new Error('windowMs must be positive');
  }

  check(key: string, now = Date.now()): RateLimitResult {
    const existing = this.buckets.get(key);
    const expired = !existing || now - existing.windowStartedAt >= this.windowMs;
    const bucket = expired ? { count: 0, windowStartedAt: now } : existing;

    if (expired && this.buckets.size >= this.maxKeys && !this.buckets.has(key)) {
      const oldest = this.buckets.keys().next().value;
      if (typeof oldest === 'string') this.buckets.delete(oldest);
    }

    bucket.count += 1;
    this.buckets.set(key, bucket);
    const resetAt = bucket.windowStartedAt + this.windowMs;
    const allowed = bucket.count <= this.maxRequests;
    return {
      allowed,
      limit: this.maxRequests,
      remaining: Math.max(0, this.maxRequests - bucket.count),
      resetAt,
    };
  }
}

export function clientKey(ip: string | undefined, forwardedFor?: string): string {
  // Use Fastify's parsed address by default. Only use the first forwarded value
  // when the deployment explicitly trusts its reverse proxy.
  return (forwardedFor?.split(',')[0]?.trim() || ip || 'unknown').slice(0, 128);
}
