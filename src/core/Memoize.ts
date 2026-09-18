/** Retains one deterministic value per key for the lifetime of the lookup. */
export function memoizeByKey<K, V>(create: (key: K) => V): (key: K) => V {
  const values = new Map<K, V>();
  return key => {
    if (!values.has(key)) values.set(key, create(key));
    return values.get(key)!;
  };
}
