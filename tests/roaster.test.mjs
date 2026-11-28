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

// Round 3 of D4: chatter spread between the requirements.
test('an interleaved chat keeps every requirement turn, in order, with chatter between them', () => {
  assert.equal(roasterTranscript(0, { interleave: true }), roasterTranscript(0));
  const plain = roasterTranscript(800).split('\n');
  const spread = roasterTranscript(800, { interleave: true }).split('\n');
  assert.equal(spread.length, plain.length);
  const chatterTexts = new Set(roasterTranscript(16).split('\n').slice(roasterTranscript(0).split('\n').length));
  const requirementTurns = lines => lines.filter(line => !chatterTexts.has(line));
  assert.deepEqual(requirementTurns(spread), requirementTurns(plain));
  // The colour change and the last word sit far from the start, not in the first few hundred lines.
  const at = needle => spread.findIndex(line => line.includes(needle));
  assert.ok(at('#2F5D50') < 200);
  assert.ok(at('terracotta, #C65D3B') > spread.length / 2);
  assert.ok(at('Make it warm and welcoming') > spread.length - 200);
});

test('review 4: an old price elsewhere on the page is stale and loses the requirement', () => {
  const both = good.replace('<p>Our signature', '<p>Oat latte $5.00 all week.</p><p>Our signature');
  const score = scoreSite(both);
  assert.ok(score.stale.includes('Old oat latte price $5.00'));
  assert.ok(score.missed.includes('Oat latte $5.25'));
});

test('review 4: hidden content earns nothing', () => {
  for (const hide of ['<p hidden>', '<p aria-hidden="true">', '<p style="display: none">']) {
    const score = scoreSite(good.replace('<p>Roasted slow, poured fresh.</p>', `${hide}Roasted slow, poured fresh.</p>`));
    assert.ok(score.missed.includes('Tagline "Roasted slow, poured fresh."'), hide);
  }
  const shown = scoreSite(good.replace('<p>Roasted slow', '<p class="hiddenish">Roasted slow'));
  assert.deepEqual(shown.missed, []);
});

test('review 4: the Bean Club must be $18 a month, not a one-time $18', () => {
  const name = 'Bean Club, $18 a month';
  const swap = text => scoreSite(good.replace('<p>$18 a month for a bag of fresh beans.</p>', text)).missed.includes(name);
  assert.equal(swap('<p>$18 one-time for a bag of fresh beans.</p>'), true);
  assert.equal(swap('<p>A bag of beans: $18.</p>'), true);
  assert.equal(swap('<p>$18/month, a fresh bag each month.</p>'), false);
  assert.equal(swap('<p>Monthly subscription: $18</p>'), false);
  assert.equal(swap('<p>$18 per month.</p>'), false);
});

test('review 4, round 2: a hidden element hides all it contains, in any quoting', () => {
  const tagline = '<p>Roasted slow, poured fresh.</p>';
  for (const wrap of [
    `<div hidden><div>Intro</div>${tagline}</div>`,
    `<p style='display:none'>Roasted slow, poured fresh.</p>`,
    `<p style=display:none>Roasted slow, poured fresh.</p>`,
    `<section aria-hidden='true'><div><div>x</div></div>${tagline}</section>`,
  ]) {
    const score = scoreSite(good.replace(tagline, wrap));
    assert.ok(score.missed.includes('Tagline "Roasted slow, poured fresh."'), wrap);
    assert.equal(score.requirements, 14, wrap);
  }
  // What follows a closed hidden element is still read.
  assert.deepEqual(scoreSite(good.replace(tagline, `<div hidden><div>x</div></div>${tagline}`)).missed, []);
});

test('review 4, round 2: an item named mid-sentence does not take a stale price', () => {
  const score = scoreSite(good.replace('<p>Our signature', '<p>Cold brew float, inspired by our oat latte $5.00.</p><p>Our signature'));
  assert.deepEqual(score.stale, []);
  assert.deepEqual(score.missed, []);
});

test('review 4, round 2: "next month ... upfront" is not monthly, and $18.00 per month is', () => {
  const name = 'Bean Club, $18 a month';
  const swap = text => scoreSite(good.replace('<p>$18 a month for a bag of fresh beans.</p>', text)).missed.includes(name);
  assert.equal(swap('<p>Next month: $18 upfront for a bag.</p>'), true);
  assert.equal(swap('<p>$18.00 per month.</p>'), false);
});

test('review 4, round 3: quoted attribute values neither end nor start a hidden element', () => {
  const tagline = '<p>Roasted slow, poured fresh.</p>';
  const leak = scoreSite(good.replace(tagline, `<div hidden><span title="</div>">Roasted slow, poured fresh.</span></div><p>Visible</p>`));
  assert.ok(leak.missed.includes('Tagline "Roasted slow, poured fresh."'));
  const titled = scoreSite(good.replace(tagline, '<p title="keep hidden until launch" data-x="aria-hidden=true">Roasted slow, poured fresh.</p>'));
  assert.deepEqual(titled.missed, []);
});

test('review 4, round 3: only the item\'s own short row can show a stale price', () => {
  const add = row => scoreSite(good.replace('<p>Our signature', `${row}<p>Our signature`));
  const fans = add('<p>Oat latte fans might like our seasonal cookie for $5.00.</p>');
  assert.deepEqual(fans.stale, []);
  assert.deepEqual(fans.missed, []);
  const small = add('<p>Small oat latte $5.00</p>');
  assert.ok(small.stale.includes('Old oat latte price $5.00'));
  assert.ok(small.missed.includes('Oat latte $5.25'));
});

test('review 4, round 3: Bean Club wording is read sentence by sentence and word by word', () => {
  const name = 'Bean Club, $18 a month';
  const swap = text => scoreSite(good.replace('<p>$18 a month for a bag of fresh beans.</p>', text)).missed.includes(name);
  assert.equal(swap('<p>$18 per month. Cancel once you move.</p>'), false);
  assert.equal(swap('<p>Join annually for $18 per monthlong workshop.</p>'), true);
});

test('review 4, round 4: block breaks bound price labels and one-time words; quoted ">" stays in its tag', () => {
  const pairings = scoreSite(good.replace('<p>Our signature', '<h3>Oat Latte Pairings</h3><p>Cookie $5.00</p><p>Our signature'));
  assert.deepEqual(pairings.stale, []);
  assert.deepEqual(pairings.missed, []);
  const club = scoreSite(good.replace('<p>$18 a month for a bag of fresh beans.</p>', '<p>$18 per month</p><p>Sign up once.</p>'));
  assert.deepEqual(club.missed, []);
  const titled = scoreSite(good.replace('<p>Roasted slow, poured fresh.</p>', '<p title="Our motto > Roasted slow, poured fresh.">Welcome</p>'));
  assert.ok(titled.missed.includes('Tagline "Roasted slow, poured fresh."'));
});

test('review 4, round 5: a menu card puts its price in the next block; a one-time label in the next block counts', () => {
  const card = scoreSite(good.replace('<p>Our signature', '<div class="menu-item"><p>Oat Latte</p><p>$5.00</p></div><p>Our signature'));
  assert.ok(card.stale.includes('Old oat latte price $5.00'));
  assert.ok(card.missed.includes('Oat latte $5.25'));
  const fee = scoreSite(good.replace('<p>$18 a month for a bag of fresh beans.</p>', '<p>Monthly coffee deliveries</p><div>$18</div><div>One-time signup fee</div>'));
  assert.ok(fee.missed.includes('Bean Club, $18 a month'));
});

test('review 4, round 6: nested closing tags make one block break', () => {
  const nested = scoreSite(good.replace('<p>Our signature', '<article><header><h3>Oat Latte</h3></header><p>$5.00</p></article><p>Our signature'));
  assert.ok(nested.stale.includes('Old oat latte price $5.00'));
  assert.ok(nested.missed.includes('Oat latte $5.25'));
  const wrapped = scoreSite(good.replace('<p>$18 a month for a bag of fresh beans.</p>', '<p>Monthly coffee deliveries</p><div class="price"><p>$18</p></div><p>One-time signup fee</p>'));
  assert.ok(wrapped.missed.includes('Bean Club, $18 a month'));
});

test('review 4, round 7: monthly wording on the price beats the next section\'s heading', () => {
  const page = good.replace('<section><h2>Bean Club</h2><p>$18 a month for a bag of fresh beans.</p></section>',
    '<section><h2>Bean Club</h2><div><p>$18/month</p></div></section><section><h2>One-time purchases</h2><p>Buy a bag in store.</p></section>');
  assert.deepEqual(scoreSite(page).missed, []);
});

test('review 4, round 8: monthly wording before the price in its own block also beats the next heading', () => {
  const page = good.replace('<section><h2>Bean Club</h2><p>$18 a month for a bag of fresh beans.</p></section>',
    '<section><h2>Bean Club</h2><p>Monthly membership: $18</p></section><section><h2>One-time purchases</h2><p>Buy a bag in store.</p></section>');
  assert.deepEqual(scoreSite(page).missed, []);
});

test('review 4, round 9: trailing full stops, earlier sentences, a second $18 and sized item names', () => {
  const name = 'Bean Club, $18 a month';
  const club = text => scoreSite(good.replace('<p>$18 a month for a bag of fresh beans.</p>', text)).missed.includes(name);
  assert.equal(club('<p>Monthly membership costs $18.</p>'), false);
  assert.equal(club('<p>Monthly deliveries. One-time signup fee: $18</p>'), true);
  assert.equal(club('<p>One-time gift bag: $18. Monthly membership: $18/month.</p>'), false);
  const period = scoreSite(good.replace('<p>Our signature', '<p>Oat latte $5.00.</p><p>Our signature'));
  assert.ok(period.stale.includes('Old oat latte price $5.00'));
  const borrowed = scoreSite(good.replace('<li>Oat latte <b>$5.25</b></li><li>Cold brew $4.75</li>', '<li>Oat latte</li><li>Small cold brew $5.25</li>'));
  assert.ok(borrowed.missed.includes('Oat latte $5.25'));
});

test('review 4, round 10: an unpriced item does not take the price of the next thing on the page', () => {
  const page = good.replace('<li>Oat latte <b>$5.25</b></li>', '<li>Oat latte</li><li>Cookie $5.25</li>');
  assert.ok(scoreSite(page).missed.includes('Oat latte $5.25'));
  // A price in its own block, a size and a long description still belong to the item.
  for (const row of ['<li><p>Oat latte</p><p>$5.25</p></li>', '<li><p>Oat latte</p><p>12 oz $5.25</p></li>',
    '<li><p>Oat latte</p><p>Creamy oat milk, silky espresso $5.25</p></li>']) {
    assert.deepEqual(scoreSite(good.replace('<li>Oat latte <b>$5.25</b></li>', row)).missed, [], row);
  }
});

test('review 4, round 10: Bean Club monthly wording does not cross a heading, and a fee keeps its own words', () => {
  const name = 'Bean Club, $18 a month';
  const club = text => scoreSite(good.replace('<p>$18 a month for a bag of fresh beans.</p>', text)).missed.includes(name);
  assert.equal(club('<p>Monthly deliveries</p><h3>Gift bags</h3><p>$18</p>'), true);
  assert.equal(club('<p>$18 per month plus a one-time signup fee of $5.</p>'), false);
  assert.equal(club('<p>One-time $5 signup fee plus $18 per month.</p>'), false);
  assert.equal(club('<p>Monthly subscription</p><p>$18</p>'), false);
  assert.equal(club('<p>$18 upfront, then $10 a month.</p>'), true);
});

test('review 4, round 10: a class or ID the stylesheet hides earns nothing; a media query does not hide', () => {
  const tagline = '<p>Roasted slow, poured fresh.</p>';
  const withRule = (rule, element) => good.replace('</style>', `${rule}</style>`).replace(tagline, element);
  for (const [rule, element] of [
    ['.hide { display: none }', '<p class="lead hide">Roasted slow, poured fresh.</p>'],
    ['#motto{visibility:hidden}', '<p id="motto">Roasted slow, poured fresh.</p>'],
    ['div.off, .x { display:none; }', '<div class="off"><p>Roasted slow, poured fresh.</p></div>'],
  ]) assert.ok(scoreSite(withRule(rule, element)).missed.includes('Tagline "Roasted slow, poured fresh."'), rule);
  const media = withRule('@media (max-width: 600px) { .wide { display: none } }', '<p class="wide">Roasted slow, poured fresh.</p>');
  assert.deepEqual(scoreSite(media).missed, []);
  const compound = withRule('.menu .lead { display: none }', '<p class="lead">Roasted slow, poured fresh.</p>');
  assert.deepEqual(scoreSite(compound).missed, []);
});

test('review 4, round 10: a closing time must be a closing time, and a negated closure does not count', () => {
  const hours = '<p>Open 7:00–15:00. Closed on Tuesdays.</p>';
  const swap = text => scoreSite(good.replace(hours, text)).missed;
  assert.ok(swap('<p>Pick up orders at 3pm.</p><p>Closed on Tuesdays.</p>').includes('Closes at 15:00'));
  assert.ok(swap('<p>Open 7:00–15:00.</p><p>Tuesday we are never closed.</p>').includes('Closed on Tuesdays'));
  assert.ok(swap('<p>Open 7:00–15:00.</p><p>We are not closed on Tuesdays.</p>').includes('Closed on Tuesdays'));
  assert.deepEqual(swap('<p>We close at 3pm.</p><p>Tue: closed</p>'), []);
  assert.deepEqual(swap('<table><tr><td>Mon</td><td>7am</td><td>3pm</td></tr></table><p>Closed Tuesdays</p>'), []);
});

test('review 4, round 10: headings and links are read through nested tags, and order controls count', () => {
  const add = html => scoreSite(good.replace('<section><h2>Visit', `${html}<section><h2>Visit`)).forbidden;
  assert.ok(add('<section><h2><span>Wholesale</span></h2></section>').includes('A wholesale section'));
  assert.ok(add('<p><a href="/trade"><b>Wholesale</b> enquiries</a></p>').includes('A wholesale section'));
  assert.ok(add('<p><a href="/order">Order</a></p>').includes('Online ordering'));
  assert.ok(add('<p><a href="https://shop.example/checkout">Buy beans</a></p>').includes('Online ordering'));
  assert.ok(add('<p><button>Place an order</button></p>').includes('Online ordering'));
  assert.deepEqual(add('<p><a href="#menu">See the menu</a> in any order you like.</p>'), []);
});

test('review 4, round 10: a reply with a second <html> document is not one build', () => {
  assert.equal(htmlOf('<!doctype html><html>A</html><html>B</html>'), '');
  assert.equal(htmlOf('Here:\n<!doctype html><html><body>A</body></html>\nDone.'), '<!doctype html><html><body>A</body></html>');
});

test('review 4, round 11: headings start cards, qualifiers stay with their amount, tag selectors, ranges and other days', () => {
  const card = good.replace('<li>Oat latte <b>$5.25</b></li>', '<li><h3>Oat latte</h3></li><li><h3>Chocolate chip cookie</h3><p>$5.25</p></li>');
  assert.ok(scoreSite(card).missed.includes('Oat latte $5.25'));
  assert.deepEqual(scoreSite(good.replace('<li>Oat latte <b>$5.25</b></li>', '<li><h3>Oat latte</h3><p>$5.25</p></li>')).missed, []);
  const club = scoreSite(good.replace('<p>$18 a month for a bag of fresh beans.</p>', '<p>$5 one-time signup fee, then $18 per month.</p>'));
  assert.deepEqual(club.missed, []);
  const tagged = good.replace('</style>', 'button.mobile-only {display:none}</style>')
    .replace('<p>Roasted slow, poured fresh.</p>', '<p class="mobile-only">Roasted slow, poured fresh.</p>');
  assert.deepEqual(scoreSite(tagged).missed, []);
  assert.ok(scoreSite(tagged.replace('<p class="mobile-only">Roasted slow, poured fresh.</p>', '<button class="mobile-only">Roasted slow, poured fresh.</button>'))
    .missed.includes('Tagline "Roasted slow, poured fresh."'));
  const hours = '<p>Open 7:00–15:00. Closed on Tuesdays.</p>';
  const swap = text => scoreSite(good.replace(hours, text)).missed;
  assert.ok(swap('<p>Open 3pm to 9pm.</p><p>Closed on Tuesdays.</p>').includes('Closes at 15:00'));
  assert.ok(swap('<p>Open 7:00–15:00.</p><p>Closed Monday, open Tuesday.</p>').includes('Closed on Tuesdays'));
  assert.ok(swap('<p>Open 7:00–15:00.</p><p>Open Tuesday, closed Monday.</p>').includes('Closed on Tuesdays'));
  assert.deepEqual(swap('<p>Open 7:00–15:00.</p><p>Closed Mondays and Tuesdays.</p>'), []);
});
