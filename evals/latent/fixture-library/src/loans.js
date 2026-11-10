import { LOAN_DAYS, MAX_ACTIVE_LOANS, MAX_RENEWALS, RENEWAL_DAYS } from './settings.js';
import { isBlocked } from './fees.js';
import { hasHoldFor } from './holds.js';

const DAY_MS = 86_400_000;
const loans = new Map();

export function activeLoans(memberId) {
  return [...loans.values()].filter(loan => loan.memberId === memberId && !loan.returnedAt);
}

export function checkout(loanId, memberId, itemId, now = Date.now()) {
  if (isBlocked(memberId)) throw new Error('Member is blocked until fees are paid.');
  if (activeLoans(memberId).length >= MAX_ACTIVE_LOANS) throw new Error('Loan limit reached.');
  const loan = { memberId, itemId, dueAt: now + LOAN_DAYS * DAY_MS, renewals: 0 };
  loans.set(loanId, loan);
  return loan;
}

export function renew(loanId) {
  const loan = loans.get(loanId);
  if (loan.renewals >= MAX_RENEWALS) throw new Error('No renewals left.');
  if (hasHoldFor(loan.itemId, loan.memberId)) throw new Error('Item is on hold for another member.');
  loan.dueAt += RENEWAL_DAYS * DAY_MS;
  loan.renewals += 1;
  return loan;
}

export function giveBack(loanId, now = Date.now()) {
  const loan = loans.get(loanId);
  loan.returnedAt = now;
  return loan;
}
