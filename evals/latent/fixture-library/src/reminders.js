import { REMINDER_LEAD_DAYS, REMINDER_QUEUE } from './settings.js';

const DAY_MS = 86_400_000;
const outbox = [];

export function scheduleReminder(loan, member) {
  outbox.push({
    queue: REMINDER_QUEUE,
    to: member.email,
    template: 'due-soon',
    sendAt: loan.dueAt - REMINDER_LEAD_DAYS * DAY_MS,
  });
}

export function scheduled() {
  return outbox.length;
}
