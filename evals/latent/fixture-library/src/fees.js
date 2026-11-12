import { BLOCK_THRESHOLD_CENTS, LATE_FEE_CAP_CENTS } from './settings.js';

const DAY_MS = 86_400_000;
const balances = new Map();

export function lateFee(loan, returnedAt) {
  const lateDays = Math.ceil((returnedAt - loan.dueAt) / DAY_MS);
  if (lateDays <= 0) return 0;
  return Math.min(lateDays * 25, LATE_FEE_CAP_CENTS);
}

export function charge(memberId, cents) {
  balances.set(memberId, (balances.get(memberId) ?? 0) + cents);
}

export function isBlocked(memberId) {
  return (balances.get(memberId) ?? 0) >= BLOCK_THRESHOLD_CENTS;
}

export function pay(memberId, cents) {
  balances.set(memberId, Math.max(0, (balances.get(memberId) ?? 0) - cents));
}
