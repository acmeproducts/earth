export interface SharedValueMap<K, V> {
  get(key: K): V | undefined;
  set(key: K, value: V): this;
}

interface OwnedValue<V> {
  value: V;
  owners: Set<object>;
}

/** Retains shared values only while at least one live streamed owner uses them. */
export class OwnedValueCache<K, V> {
  private readonly entries = new Map<K, OwnedValue<V>>();
  private readonly ownedKeys = new Map<object, Set<K>>();

  get size(): number { return this.entries.size; }

  forOwner(owner: object): SharedValueMap<K, V> {
    const retain = (key: K, entry: OwnedValue<V>): void => {
      if (entry.owners.has(owner)) return;
      entry.owners.add(owner);
      let keys = this.ownedKeys.get(owner);
      if (!keys) this.ownedKeys.set(owner, keys = new Set());
      keys.add(key);
    };
    const view: SharedValueMap<K, V> = {
      get: (key) => {
        const entry = this.entries.get(key);
        if (!entry) return undefined;
        retain(key, entry);
        return entry.value;
      },
      set: (key, value) => {
        let entry = this.entries.get(key);
        if (entry) entry.value = value;
        else this.entries.set(key, entry = { value, owners: new Set() });
        retain(key, entry);
        return view;
      },
    };
    return view;
  }

  release(owner: object): void {
    const keys = this.ownedKeys.get(owner);
    if (!keys) return;
    this.ownedKeys.delete(owner);
    for (const key of keys) {
      const entry = this.entries.get(key);
      if (!entry) continue;
      entry.owners.delete(owner);
      if (entry.owners.size === 0) this.entries.delete(key);
    }
  }

  clear(): void {
    this.entries.clear();
    this.ownedKeys.clear();
  }
}
