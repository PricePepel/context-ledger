// Card D4: the website demo's client chat and scorer.
import assert from 'node:assert/strict';
import test from 'node:test';
import { openStore } from '../src/store.mjs';
import { forbidden, htmlOf, requirements, roasterTranscript, scoreSite, stale } from '../demo/roaster.mjs';

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

test('an hours table that writes "Tue Closed" meets the Tuesday requirement', () => {
  const table = good.replace('<p>Open 7:00–15:00. Closed on Tuesdays.</p>', '<table><tr><td>Mon</td><td>7:00–15:00</td></tr><tr><td>Tue</td><td>Closed</td></tr></table>');
  assert.ok(!scoreSite(table).missed.includes('Closed on Tuesdays'));
  // A "true" or "tuesday-ish" word elsewhere does not count.
  assert.ok(scoreSite(good.replace('Closed on Tuesdays.', 'Closed for true holidays.')).missed.includes('Closed on Tuesdays'));
});

// Codex review of D4: each loose check now has a regression test.
test('review: an item without a price cannot borrow the next item\'s price', () => {
  const page = good.replace('<li>Oat latte <b>$5.25</b></li><li>Cold brew $4.75</li>', '<li>Oat latte</li><li>Cold brew $5.25</li>');
  assert.ok(scoreSite(page).missed.includes('Oat latte $5.25'));
});

test('review: a description that mentions espresso does not end the cortado row', () => {
  const page = good.replace('<li>Cortado — $4.00</li>', '<li><h3>Cortado</h3><p>Equal parts espresso and steamed milk.</p><span>$4.00</span></li>');
  assert.ok(!scoreSite(page).missed.includes('Cortado $4.00'));
});

test('review: wrong amounts and far-away numbers do not pass', () => {
  assert.ok(scoreSite(good.replace('Cortado — $4.00', 'Cortado — $4.50')).missed.includes('Cortado $4.00'));
  const club = good.replace('<p>$18 a month for a bag of fresh beans.</p>', '<p>A bag of fresh beans every month.</p>') + '<footer>' + 'x '.repeat(200) + 'Gift box $18</footer>';
  assert.ok(scoreSite(club).missed.includes('Bean Club, $18 a month'));
  assert.ok(scoreSite(good.replace('41 Harbor Lane, Portland, Maine', '41 Harbor Lane, Portland')).missed.includes('Address 41 Harbor Lane, Portland, Maine'));
});

test('review: a colour or font named only in a comment is not applied', () => {
  const page = good.replace(':root { --brand: #C65D3B; } h1, h2 { font-family: \'Fraunces\', serif; }', '/* #C65D3B Fraunces */ h1 { font-family: Georgia, serif; }');
  const score = scoreSite(page + '<!-- font-family: Fraunces; color: #C65D3B -->');
  assert.ok(score.missed.includes('Brand colour terracotta #C65D3B'));
  assert.ok(score.missed.includes('Headings in Fraunces'));
});

test('review: hours checks read one row at a time', () => {
  const rows = good.replace('<p>Open 7:00–15:00. Closed on Tuesdays.</p>', '<ul><li>Tuesday 7:00–15:00</li><li>Wednesday closed</li></ul>');
  assert.ok(rows.includes('Wednesday closed'));
  assert.ok(scoreSite(rows).missed.includes('Closed on Tuesdays'));
  assert.ok(!scoreSite(good.replace('Closed on Tuesdays.', 'Closed on Tues.')).missed.includes('Closed on Tuesdays'));
  assert.deepEqual(scoreSite(good.replace('Open 7:00–15:00.', 'Open 7:00–15:00 (last orders 14:45, not 15 pm).')).stale, []);
  assert.ok(scoreSite(good.replace('Open 7:00–15:00. Closed on Tuesdays.', 'Open 7 am–3 pm daily.')).stale.includes('Old hours "open every day"'));
});

test('review: ruled-out wording variants are caught, and a passing wholesale mention is reported, not counted', () => {
  const hyphen = String.fromCodePoint(0x2011);
  assert.ok(scoreSite(good.replace('No data', '') + `<p>Gluten${hyphen}free options</p>`).forbidden.includes('Says gluten-free'));
  assert.ok(scoreSite(good + '<p><a>Start your pickup order</a></p>').forbidden.includes('Online ordering'));
  const mention = scoreSite(good + '<p>For wholesale enquiries, please call us directly.</p>');
  assert.deepEqual(mention.forbidden, []);
  assert.deepEqual(mention.mentions, ['Mentions wholesale']);
  assert.ok(scoreSite(good + '<section><h2>Wholesale</h2></section>').forbidden.includes('A wholesale section'));
});

test('review: only a reply with exactly one HTML document counts as a built site', () => {
  assert.equal(htmlOf(['Here you go:', '<!doctype html><html><body>A</body></html>', 'Done.'].join('\n')), '<!doctype html><html><body>A</body></html>');
  assert.equal(htmlOf('<!doctype html><html>A</html><!doctype html><html>B</html>'), '');
  assert.equal(htmlOf('No page, sorry.'), '');
  assert.equal(htmlOf('<!doctype html><html><body>cut off'), '');
});

test('review: a description that starts with another item\'s name does not end the row', () => {
  const page = good.replace('<li>Cortado — $4.00</li>', '<li><h3>Cortado</h3><p>Espresso cut with equal parts warm milk.</p><span>$4.00</span></li>');
  assert.ok(!scoreSite(page).missed.includes('Cortado $4.00'));
  const borrowed = good.replace('<li>Oat latte <b>$5.25</b></li><li>Cold brew $4.75</li>', '<li><h3>Oat latte</h3></li><li><h3>Cold brew</h3><span>$5.25</span></li>');
  assert.ok(scoreSite(borrowed).missed.includes('Oat latte $5.25'));
});
