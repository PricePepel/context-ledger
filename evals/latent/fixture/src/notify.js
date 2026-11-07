import { MAIL_QUEUE, SMS_QUEUE } from './config.js';

const outbox = [];

function enqueue(queue, message) {
  outbox.push({ queue, message, at: Date.now() });
}

// Every shipped order gets an email. An SMS goes out only when the customer
// has a verified phone number.
export async function notifyShipped(order) {
  enqueue(MAIL_QUEUE, { to: order.customer.email, template: 'shipped' });
  if (order.customer.phone && order.customer.phoneVerified) {
    enqueue(SMS_QUEUE, { to: order.customer.phone, template: 'shipped-sms' });
  }
}

export function pending() {
  return outbox.length;
}
