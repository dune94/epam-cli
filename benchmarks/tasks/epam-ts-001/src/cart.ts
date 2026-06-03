export interface CartItem {
  name: string;
  price: number;
  quantity: number;
}

export function calculateTotal(items: CartItem[], couponPercent?: number): number {
  const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  if (couponPercent === undefined || couponPercent === 0) return subtotal;
  // BUG: discount applied twice — once here, once below
  const afterFirstDiscount = subtotal * (1 - couponPercent / 100);
  return afterFirstDiscount * (1 - couponPercent / 100);
}
