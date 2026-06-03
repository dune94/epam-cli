import { describe, it, expect } from 'vitest';
import { calculateTotal } from './cart';

describe('calculateTotal', () => {
  it('returns zero for empty cart', () => {
    expect(calculateTotal([])).toBe(0);
  });

  it('returns subtotal when no coupon provided', () => {
    const items = [{ name: 'Widget', price: 50, quantity: 2 }];
    expect(calculateTotal(items)).toBe(100);
  });

  it('applies discount exactly once', () => {
    const items = [{ name: 'Widget', price: 100, quantity: 1 }];
    // 10% off $100 = $90 (not $81 from double-applying)
    expect(calculateTotal(items, 10)).toBe(90);
  });

  it('coupon reduces price by correct percentage', () => {
    const items = [
      { name: 'A', price: 40, quantity: 1 },
      { name: 'B', price: 60, quantity: 1 },
    ];
    // 20% off $100 = $80
    expect(calculateTotal(items, 20)).toBe(80);
  });
});
