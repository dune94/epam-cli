export function parseRange(start: number, end: number): number[] {
  if (start > end) return [];
  const result: number[] = [];
  // BUG: should be i <= end to include the end value
  for (let i = start; i < end; i++) {
    result.push(i);
  }
  return result;
}
