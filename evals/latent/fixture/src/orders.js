import { MAX_CART_ITEMS, TAX_RATE } from './config.js';
import { charge } from './payments.js';
import { notifyShipped } from './notify.js';

const orders = new Map();

// Order lifecycle: pending -> paid -> shipped. Cancelled is terminal.
const transitions = {
  pending: ['paid', 'cancelled'],
  paid: ['shipped'],
  shipped: [],
  cancelled: [],
};

export function priceCart(items) {
  if (items.length > MAX_CART_ITEMS) throw new Error('Cart is too large.');
  const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  return Math.round(subtotal * (1 + TAX_RATE) * 100) / 100;
}

export async function placeOrder(id, customer, items) {
  const total = priceCart(items);
  orders.set(id, { customer, items, total, status: 'pending' });
  await charge(id, total);
  move(id, 'paid');
  return orders.get(id);
}

function move(id, next) {
  const order = orders.get(id);
  if (!transitions[order.status].includes(next)) {
    throw new Error(`Cannot move an order from ${order.status} to ${next}.`);
  }
  order.status = next;
}

// Only a pending order can be cancelled; a paid order needs a refund instead.
export function cancelOrder(id) {
  move(id, 'cancelled');
}

export async function shipOrder(id) {
  move(id, 'shipped');
  await notifyShipped(orders.get(id));
}
