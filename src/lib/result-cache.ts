export class ResultCache<T> {
  private readonly values = new Map<string, T>();
  private readonly inFlight = new Map<string, Promise<T>>();

  get size(): number {
    return this.values.size;
  }

  get(key: string): T | undefined {
    return this.values.get(key);
  }

  hasInFlight(key: string): boolean {
    return this.inFlight.has(key);
  }

  async getOrGenerate(key: string, generate: () => Promise<T>, shouldCache: (result: T) => boolean = () => true): Promise<T> {
    const cached = this.values.get(key);
    if (cached !== undefined) return cached;

    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const pending = generate().then((result) => {
      if (shouldCache(result)) this.values.set(key, result);
      return result;
    }).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, pending);
    return pending;
  }
}
