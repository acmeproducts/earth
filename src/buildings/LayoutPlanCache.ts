/** Bounded LRU for value-equivalent planner inputs. Each caller owns its result. */
export class LayoutPlanCache<T> {
  private readonly entries = new Map<string, { value: T; bytes: number }>();
  private retainedBytes = 0;
  hits = 0;
  misses = 0;
  private readonly maximumBytes: number;
  private readonly maximumEntries: number;

  constructor(maximumBytes = 8 * 1024 * 1024, maximumEntries = 256) {
    this.maximumBytes = maximumBytes;
    this.maximumEntries = maximumEntries;
  }

  get size(): number { return this.entries.size; }
  get bytes(): number { return this.retainedBytes; }

  getOrCreate(input: unknown, create: () => T): T {
    const key = JSON.stringify(input);
    const existing = this.entries.get(key);
    if (existing) {
      this.hits++;
      this.entries.delete(key);
      this.entries.set(key, existing);
      return structuredClone(existing.value);
    }
    this.misses++;
    const value = create();
    // Account for serialized key/value storage; the entry cap also bounds object overhead.
    const bytes = 2 * (key.length + JSON.stringify(value).length);
    if (bytes <= this.maximumBytes) {
      this.entries.set(key, { value: structuredClone(value), bytes });
      this.retainedBytes += bytes;
      while (this.retainedBytes > this.maximumBytes || this.entries.size > this.maximumEntries) {
        const oldest = this.entries.entries().next().value!;
        this.entries.delete(oldest[0]);
        this.retainedBytes -= oldest[1].bytes;
      }
    }
    return value;
  }

  clear(): void {
    this.entries.clear();
    this.retainedBytes = 0;
    this.hits = this.misses = 0;
  }
}
