export class TtlCache<V> {
  private readonly values = new Map<string, { value: V; expiresAt: number }>();
  private readonly inflight = new Map<string, Promise<V>>();
  constructor(private readonly ttlMs: number, private readonly maxEntries = 100) {}
  get(key: string): V | undefined {
    const hit = this.values.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= Date.now()) return undefined;
    return hit.value;
  }
  getStale(key: string): V | undefined {
    return this.values.get(key)?.value;
  }
  async getOrLoad(key: string, loader: () => Promise<V>): Promise<V> {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const pending = loader().then((value) => {
      this.set(key, value);
      return value;
    }).finally(() => this.inflight.delete(key));
    this.inflight.set(key, pending);
    return pending;
  }
  set(key: string, value: V): void {
    for (const [entryKey, entry] of this.values) {
      if (entry.expiresAt <= Date.now()) this.values.delete(entryKey);
    }
    if (this.values.size >= this.maxEntries && !this.values.has(key)) this.values.delete(this.values.keys().next().value as string);
    this.values.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }
}
