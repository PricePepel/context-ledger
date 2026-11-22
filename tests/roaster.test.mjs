// Card D4: the website demo's client chat and scorer.
import assert from 'node:assert/strict';
import test from 'node:test';
import { openStore } from '../src/store.mjs';
import { forbidden, requirements, roasterTranscript, scoreSite, stale } from '../demo/roaster.mjs';

const good = `<!doctype html><html><head><style>
  :root { --brand: #C65D3B; } h1, h2 { font-family: 'Fraunces', serif; }
</style></head><body>
  <h1>Tidewater Roast Co.</h1><p>Roasted slow, poured fresh.</p>
  <section><h2>Menu</h2><ul>
    <li><span>Espresso</span> <span>$3.25</span></li><li>Cortado — $4.00</li>
    <li>Oat latte <b>$5.25</b></li><li>Cold brew $4.75</li></ul>
    <p>Our signature Harbor Fog blend, roasted fresh every day.</p></section>
  <section><h2>Bean Club</h2><p>$18 a month for a bag of fresh beans.</p></section>
  <section><h2>Visit</h2><p>41 Harbor Lane, Portland, Maine</p>
    <p>Open 7:00–15:00. Closed on Tuesdays.</p>
    <p>(207) 555-0143 · <a href="mailto:hello@tidewater.example">hello@tidewater.example</a></p></section>
</body></html>`;

test('a page with every final requirement scores 15 of 15 and nothing stale or forbidden', () => {
  const score = scoreSite(good);
  assert.equal(score.of, 15);
  assert.deepEqual(score.missed, []);
  assert.equal(score.requirements, 15);
  assert.deepEqual(score.stale, []);
  assert.deepEqual(score.forbidden, []);
});

test('replaced values count as stale, ruled-out content as forbidden', () => {
  const old = good.replace('#C65D3B', '#2F5D50').replace('7:00–15:00. Closed on Tuesdays.', 'Open every day, 7:00 to 17:00.')
    .replace('$5.25', '$5.00').replace('<section><h2>Visit', '<section><h2>Wholesale</h2><p>Gluten-free pastries.</p><a>Order online</a></section><section><h2>Visit');
  const score = scoreSite(old);
  assert.deepEqual(score.missed.sort(), ['Brand colour terracotta #C65D3B', 'Closed on Tuesdays', 'Closes at 15:00', 'Oat latte $5.25'].sort());
  assert.equal(score.stale.length, stale.length);
  assert.equal(score.forbidden.length, forbidden.length);
});

test('a price is matched to its own item, not to the next one on the menu', () => {
  const swapped = good.replace('Oat latte <b>$5.25</b>', 'Oat latte <b>$4.75</b>').replace('Cold brew $4.75', 'Cold brew $5.25');
  const score = scoreSite(swapped);
  assert.ok(score.missed.includes('Oat latte $5.25'));
  assert.ok(score.missed.includes('Cold brew $4.75'));
});

test('the client chat parses as a Claude Code transcript and states every requirement', () => {
  const transcript = roasterTranscript(150);
  const lines = transcript.split('\n');
  assert.equal(lines.length % 2, 0);
  const store = openStore(':memory:');
  const session = store.importTranscript({ provider: 'claude', source: 'roaster-chat.jsonl', transcript });
  assert.equal(session.messageCount, lines.length);
  const text = transcript.toLowerCase();
  for (const needle of ['tidewater roast co', '#c65d3b', '#2f5d50', 'fraunces', 'harbor fog', '$18 a month', 'closed on tuesdays', 'hello@tidewater.example'])
    assert.ok(text.includes(needle), needle);
  // Chatter goes after the requirements, so every length has the same final word.
  assert.equal(roasterTranscript(0), lines.slice(0, roasterTranscript(0).split('\n').length).join('\n'));
  assert.equal(requirements.length, 15);
});
