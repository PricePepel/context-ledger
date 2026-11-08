import { CURRENCY, REFUND_WINDOW_DAYS, RETRY_BASE_MS, RETRY_LIMIT } from './config.js';

const payments = new Map();

async function provider(request) {
  // Stand-in for a payment provider call.
  return { ok: request.amount > 0, reference: `p-${request.orderId}` };
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// Retry a failed charge up to RETRY_LIMIT times with exponential backoff:
// 250 ms, then 500 ms, then 1000 ms.
export async function charge(orderId, amount) {
  for (let attempt = 0; attempt <= RETRY_LIMIT; attempt += 1) {
    const result = await provider({ orderId, amount, currency: CURRENCY });
    if (result.ok) {
      payments.set(orderId, { amount, paidAt: Date.now(), reference: result.reference });
      return result.reference;
    }
    if (attempt < RETRY_LIMIT) await wait(RETRY_BASE_MS * 2 ** attempt);
  }
  throw new Error('Payment failed after retries.');
}

export function refund(orderId, now = Date.now()) {
  const payment = payments.get(orderId);
  if (!payment) throw new Error('No payment to refund.');
  const ageDays = (now - payment.paidAt) / 86_400_000;
  if (ageDays > REFUND_WINDOW_DAYS) throw new Error('Refund window has closed.');
  payments.delete(orderId);
  return { refunded: payment.amount, currency: CURRENCY };
}
