/** Byte-bounded LRU for decoded resources; callers retain ownership of live values. */
export class ResourceCache<T> {
  private readonly entries = new Map<string, { promise: Promise<T>; bytes?: number }>();
  private retainedBytes = 0;
  private readonly maximumBytes: number;
  private readonly sizeOf: (value: T) => number;
  private readonly maximumEntries: number;

  constructor(
    maximumBytes: number,
    sizeOf: (value: T) => number,
    maximumEntries = 128,
  ) {
    this.maximumBytes = maximumBytes;
    this.sizeOf = sizeOf;
    this.maximumEntries = maximumEntries;
  }

  get bytes(): number { return this.retainedBytes; }
  get size(): number { return this.entries.size; }

  getOrCreate(key: string, create: () => Promise<T>): Promise<T> {
    const existing = this.entries.get(key);
    if (existing) {
      this.entries.delete(key);
      this.entries.set(key, existing);
      return existing.promise;
    }
    const entry: { promise: Promise<T>; bytes?: number } = {
      promise: Promise.resolve().then(create),
    };
    entry.promise = entry.promise.then((value) => {
      entry.bytes = this.sizeOf(value);
      this.retainedBytes += entry.bytes;
      for (const [oldKey, oldest] of this.entries) {
        if (this.retainedBytes <= this.maximumBytes && this.entries.size <= this.maximumEntries) break;
        if (oldest.bytes === undefined) continue; // Deduplicate requests still in flight.
        this.entries.delete(oldKey);
        this.retainedBytes -= oldest.bytes;
      }
      return value;
    }).catch((error: unknown) => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
      throw error;
    });
    this.entries.set(key, entry);
    return entry.promise;
  }
}
