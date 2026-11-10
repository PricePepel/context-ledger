import { HOLD_SHELF_DAYS } from './settings.js';

const DAY_MS = 86_400_000;
const queues = new Map();

export function placeHold(itemId, memberId) {
  const queue = queues.get(itemId) ?? [];
  queue.push({ memberId, status: 'waiting' });
  queues.set(itemId, queue);
}

export function hasHoldFor(itemId, borrowerId) {
  return (queues.get(itemId) ?? []).some(hold => hold.memberId !== borrowerId && hold.status !== 'expired');
}

export function itemReturned(itemId, now = Date.now()) {
  const next = (queues.get(itemId) ?? []).find(hold => hold.status === 'waiting');
  if (next) {
    next.status = 'on-shelf';
    next.pickUpBy = now + HOLD_SHELF_DAYS * DAY_MS;
  }
  return next;
}

export function sweepShelf(itemId, now = Date.now()) {
  for (const hold of queues.get(itemId) ?? []) {
    if (hold.status === 'on-shelf' && hold.pickUpBy < now) {
      hold.status = 'expired';
      itemReturned(itemId, now);
    }
  }
}
