// Card S1: the swarm demo's task. Synthetic incident reports from a fixed seed, the
// prompt every agent shares, and the checks on each agent's answer. No real data.

export const causes = ['configuration change', 'dependency outage', 'capacity limit', 'bad deploy'];

const services = ['checkout', 'search', 'payments', 'login', 'inventory', 'shipping', 'notifications', 'billing',
  'catalog', 'reviews', 'recommendations', 'invoicing', 'profiles', 'media', 'analytics', 'webhooks', 'pricing',
  'returns', 'loyalty', 'support-chat'];

// How each cause is described in a report, so an agent has to classify, not copy a label.
const causeText = {
  'configuration change': ['an edited load-balancer rule sent traffic to a drained pool',
    'a feature-flag config was rolled out with the wrong default', 'a typo in the TLS settings file was pushed to production'],
  'dependency outage': ['the upstream identity provider stopped answering',
    'the managed queue service in the region went down', 'the third-party geocoding API returned errors for every call'],
  'capacity limit': ['traffic exceeded the database connection pool',
    'the disk on the primary node filled up', 'a marketing email doubled requests beyond the autoscaling ceiling'],
  'bad deploy': ['release 4.2 shipped a broken schema migration',
    'a new build crashed on start because a required file was missing', 'the latest container image had a memory leak'],
};

const fillers = ['On-call engineers were paged within two minutes.', 'Customers saw error pages during the incident.',
  'A follow-up review is scheduled for next week.', 'Status page updates went out every fifteen minutes.',
  'No data was lost.', 'The incident channel stayed open until recovery was confirmed.'];

/** A small seeded generator (mulberry32), so every run of the demo sees the same reports. */
export function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (random, list) => list[Math.floor(random() * list.length)];

/** count incident reports, each with its truth: { id, text, truth: { service, cause, downtimeMinutes } }. */
export function incidents(count, seed = 7) {
  const random = seeded(seed);
  return Array.from({ length: count }, (_, index) => {
    const service = services[index % services.length];
    const cause = pick(random, causes);
    const downtimeMinutes = 5 + Math.floor(random() * 236);
    const day = 1 + Math.floor(random() * 28);
    const sentence = `The ${service} service was unavailable for ${downtimeMinutes} minutes after ${pick(random, causeText[cause])}.`;
    const before = pick(random, fillers);
    const after = pick(random, fillers.filter(line => line !== before));
    const text = `Incident ${index + 1}, 2026-10-${String(day).padStart(2, '0')}. ${before} ${sentence} ${after}`;
    return { id: index + 1, text, truth: { service, cause, downtimeMinutes } };
  });
}

// Shared by every agent and placed first, so a server with prefix caching stores it once.
export const systemPrompt = [
  'You read one incident report and extract four facts.',
  'Answer with one JSON object and nothing else: {"service": string, "cause": string, "downtimeMinutes": integer, "quote": string}.',
  '- service: the name of the service that was unavailable, exactly as the report writes it.',
  `- cause: exactly one of ${causes.map(cause => `"${cause}"`).join(', ')}.`,
  '  "configuration change": someone changed a setting, rule, flag or config file.',
  '  "dependency outage": a provider or service outside the team failed.',
  '  "capacity limit": load, storage or connections ran out.',
  '  "bad deploy": a new release, build or image was broken.',
  '- downtimeMinutes: how many minutes the service was unavailable, as an integer.',
  '- quote: the one sentence of the report that states the downtime and the cause, copied exactly.',
  'Example report: "Incident 9, 2026-10-03. No data was lost. The media service was unavailable for 41 minutes after the disk on the primary node filled up. A follow-up review is scheduled for next week."',
  'Example answer: {"service": "media", "cause": "capacity limit", "downtimeMinutes": 41, "quote": "The media service was unavailable for 41 minutes after the disk on the primary node filled up."}',
].join('\n');

export const userPrompt = report => `Report: ${report}`;

const fold = text => text.replace(/\s+/gu, ' ').trim();

/** The first JSON object in a model's reply, or null. */
export function parseAnswer(reply) {
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(reply.slice(start, end + 1));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    // Fields are capped, since every snapshot carries them to the page.
    const text = (field, max) => (typeof field === 'string' ? field.trim().slice(0, max) : '');
    // A usable answer has all four fields with the right types; {} or a partial object is no answer.
    if (typeof value.service !== 'string' || !value.service.trim() || typeof value.cause !== 'string'
      || typeof value.quote !== 'string' || !Number.isInteger(value.downtimeMinutes)) return null;
    return {
      service: text(value.service, 80),
      cause: text(value.cause, 40).toLowerCase(),
      downtimeMinutes: Number.isInteger(value.downtimeMinutes) && value.downtimeMinutes >= 0 && value.downtimeMinutes <= 100_000
        ? value.downtimeMinutes : null,
      quote: text(value.quote, 400),
    };
  } catch {
    return null;
  }
}

/**
 * Verified: the quote is in the report (whitespace folded) and states the downtime as
 * "<number> minutes", so a date or an incident number in the quote does not count. It
 * says the answer points at real text, not that the answer is right.
 */
export function isVerified(answer, report) {
  if (!answer || !answer.quote.trim() || answer.downtimeMinutes === null) return false;
  const quote = fold(answer.quote);
  return fold(report).includes(quote) && new RegExp(`(^|\\D)${answer.downtimeMinutes} minutes?\\b`, 'u').test(quote);
}

/** Correct: all three facts match the generator's truth. */
export function isCorrect(answer, truth) {
  return Boolean(answer) && answer.service.toLowerCase() === truth.service && answer.cause === truth.cause
    && answer.downtimeMinutes === truth.downtimeMinutes;
}

const target = 'configuration change';

/** The combined answer from verified answers, and the same question asked of the truth. */
export function combine(agents, reports) {
  const summarize = facts => {
    const hits = facts.filter(fact => fact.cause === target);
    return { services: [...new Set(hits.map(fact => fact.service.toLowerCase()))].sort(),
      totalDowntimeMinutes: hits.reduce((sum, fact) => sum + fact.downtimeMinutes, 0), incidents: hits.length };
  };
  const used = agents.filter(agent => agent.verified);
  return {
    question: 'Which services went down because of a configuration change, and for how many minutes in total?',
    fromAgents: { ...summarize(used.map(agent => agent.answer)), answersUsed: used.length },
    truth: summarize(reports.map(report => report.truth)),
  };
}
