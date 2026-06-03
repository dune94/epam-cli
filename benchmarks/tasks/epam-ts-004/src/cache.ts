export function memoize<T, R>(fn: (arg: T) => R): (arg: T) => R {
  const cache = new Map<string, R>();
  return (arg: T): R => {
    // BUG: String(arg) collapses all objects to '[object Object]'
    const key = String(arg);
    if (cache.has(key)) return cache.get(key)!;
    const result = fn(arg);
    cache.set(key, result);
    return result;
  };
}
