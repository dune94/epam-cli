// BUG: module-level counter — shared across all calls, never reset
let attempts = 0;

export async function fetchWithRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3
): Promise<T> {
  while (attempts <= maxRetries) {
    try {
      const result = await fn();
      attempts = 0; // reset on success — but this never resets on failure path
      return result;
    } catch (err) {
      attempts++;
      if (attempts > maxRetries) throw err;
    }
  }
  throw new Error('Max retries exceeded');
}
