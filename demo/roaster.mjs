// Card D4: the synthetic client chat for the website build demo, the client's final
// requirements, and the scorer. Mara, Tidewater Roast Co., every address, phone number
// and price here are made up. Run `node demo/roaster.mjs` to write the JSONL next to it.
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const turn = (role, content) => JSON.stringify({ type: role, message: { role, content } });

// Website work chatter a receiving agent has to read past. None of it states a requirement.
const chatter = [
  ['Can you explain what a favicon is? My nephew keeps mentioning it.',
    'A favicon is the small icon in the browser tab. We can make one from your logo mark later; it does not change the page itself.'],
  ['I took some photos of the roaster this morning but the light was bad.',
    'No problem. The first version will use colour blocks and simple illustrations, so photos can come in later without changing the layout.'],
  ['What does responsive mean exactly?',
    'It means the same page rearranges itself for a phone, a tablet and a laptop, so nobody has to zoom in to read the menu.'],
  ['My accountant asked whether the site needs a cookie banner.',
    'Only if the site sets tracking cookies. A plain page with no analytics does not need one, so we can leave it out for now.'],
  ['The espresso machine is making a strange noise again, give me five minutes.',
    'Take your time. I will wait before changing anything.'],
  ['Do people still read the about section?',
    'Some do, especially for local businesses. Two or three short paragraphs about how you started usually work better than a long story.'],
  ['How long does a page like this take to load?',
    'A single page without large photos loads in well under a second on most phones.'],
  ['Should the site have a blog?',
    'Not for the first version. A blog only helps if someone writes for it regularly, and it can be added later.'],
  ['My partner thinks the logo should be bigger.',
    'We can try it larger in the header and see how it looks on a phone before deciding.'],
  ['What is the difference between a domain and hosting?',
    'The domain is the address people type. Hosting is the computer that sends the page when they visit. You can buy them from different companies.'],
  ['Can people find us on Google with this?',
    'A clear page title, your address written out and your opening hours help local search. A Google business profile matters even more.'],
  ['I keep thinking about the font, but I trust you on the details.',
    'Understood. I will keep the text easy to read on a phone and check the contrast in both light and dark settings.'],
  ['We had a busy weekend, sorry for the slow replies.',
    'No need to apologise. Nothing here is urgent and I have kept your notes.'],
  ['Is it hard to change the text later?',
    'No. The text lives in one file, so changing a price or a sentence takes a minute.'],
  ['A customer asked if we will have gift cards.',
    'That is a nice idea for later. I have not added anything for it, since you have not decided.'],
  ['What happens if the site goes down?',
    'For a simple page the risk is small. Most hosts restart it automatically, and nothing is lost because the page is just a file.'],
];

// The nine places in the chat where chatter sits between requirements.
const gaps = 9;

/**
 * The client chat. extra adds chatter exchanges: by default all at the end, after every
 * requirement; with interleave they are spread evenly over the nine gaps between
 * requirements, so a long chat puts its later changes on later pages (D4 round 3).
 */
export function roasterTranscript(extra = 0, { interleave = false } = {}) {
  const turns = [];
  const say = (user, assistant) => turns.push(turn('user', user), turn('assistant', assistant));
  let next = 0;
  let gap = 0;
  const share = () => (interleave ? Math.floor((extra * (gap + 1)) / gaps) - Math.floor((extra * gap) / gaps) : 0);
  const filler = (count = 1) => {
    const total = count + share();
    gap += 1;
    for (let i = 0; i < total; i += 1) say(...chatter[next++ % chatter.length]);
  };

  say('Hi! I own a small coffee roaster and café and I need a one-page website. The business is called Tidewater Roast Co.',
    'Happy to help. A one-page site for Tidewater Roast Co. I will keep a list of everything you decide as we go.');
  say('Our tagline is "Roasted slow, poured fresh." Please use it exactly like that.',
    'Got it: the tagline is "Roasted slow, poured fresh." exactly as written.');
  filler(2);
  say('We are at 41 Harbor Lane, Portland, Maine.', 'Noted: the address is 41 Harbor Lane, Portland, Maine.');
  say('For colours, let us go with a deep forest green, #2F5D50, as the main brand colour.',
    'Brand colour set to forest green, #2F5D50.');
  filler(2);
  say('We are open every day from 7:00 to 17:00.', 'Opening hours: every day, 7:00 to 17:00.');
  say('The menu should list four drinks: Espresso $3.25, Cortado $4.00, Oat latte $5.00 and Cold brew $4.75.',
    'Menu noted: Espresso $3.25, Cortado $4.00, Oat latte $5.00, Cold brew $4.75.');
  filler(3);
  say('We also sell beans wholesale to two restaurants. Add a wholesale page with a contact form.',
    'Added to the plan: a wholesale section with a contact form.');
  say('For headings I love the font Fraunces. Use it for the titles.', 'Headings will use Fraunces.');
  filler(2);
  say('Our signature beans are the Harbor Fog blend. Please feature it.', 'The Harbor Fog blend will be featured.');
  say('Customers keep asking about ordering online. Can we add an "Order online" button?',
    'I can add an "Order online" button to the top of the page.');
  filler(3);
  say('I showed the green to my partner. Honestly it looks like a bank. Change of plan: the brand colour is terracotta, #C65D3B. Forget the green.',
    'Changed: the brand colour is now terracotta, #C65D3B. This replaces forest green #2F5D50.');
  say('Phone is (207) 555-0143 and email is hello@tidewater.example.',
    'Contact details noted: phone (207) 555-0143, email hello@tidewater.example.');
  filler(2);
  say('About the wholesale page: drop it. The restaurants call me directly and I do not want strangers using a form.',
    'Dropped: there will be no wholesale section or form on the site.');
  say('We are starting a subscription. The Bean Club is $18 a month, a bag of fresh beans every month.',
    'Added: the Bean Club, $18 a month, one bag of fresh beans every month.');
  filler(3);
  say('Bad news on hours: we are short-staffed. From next month we open 7:00 to 15:00, and we are closed on Tuesdays.',
    'Hours updated: open 7:00 to 15:00, closed on Tuesdays. This replaces every day 7:00 to 17:00.');
  say('Oat milk went up again. The oat latte is $5.25 now.', 'Menu updated: Oat latte $5.25, replacing $5.00.');
  filler(2);
  say('One more thing. Some people asked if our pastries are gluten-free. They are not, and we cannot promise it. Please never say gluten-free anywhere on the site.',
    'Constraint noted: the site must never say gluten-free.');
  say('And let us hold off on online ordering. We are not ready for it, so no order button for now.',
    'Changed: no online ordering and no order button for now. This replaces the "Order online" button.');
  filler(2);
  say('I think that is everything. Make it warm and welcoming, like walking into the café.',
    'Understood. A warm, welcoming page that feels like the café.');
  if (gap !== gaps) throw new Error(`The chat has ${gap} chatter gaps, not ${gaps}.`);
  if (!interleave) for (let index = 0; index < extra; index += 1) say(...chatter[index % chatter.length]);
  return turns.join('\n');
}

const fold = text => text.toLowerCase().replace(/\s+/gu, ' ');

// Block-level ends become " | " so a check never reads across two rows, items or paragraphs.
// Table cells and inline elements do not, so "Tue | Closed" stays one row: "tue closed".
const blockEnd = /<\/(li|tr|p|div|h[1-6]|section|article|header|footer|ul|ol|table|nav|figure|blockquote)>|<br\s*\/?>/giu;

const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

// A tag, open or close, whose attribute values may be quoted: a ">" or "</div>" inside quotes
// stays part of the tag.
const anyTag = /<(\/?)([a-z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/giu;
const attribute = /([^\s=/"'>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/gu;

/** A tag's attributes as a map of lower-case names to values ('' when it has none). */
function attributesOf(source) {
  const found = new Map();
  for (const [, name, double, single, bare] of source.matchAll(attribute)) {
    const key = name.toLowerCase();
    if (!found.has(key)) found.set(key, double ?? single ?? bare ?? '');
  }
  return found;
}

/** Whether a tag's attributes hide it: `hidden`, `aria-hidden="true"`, or an inline style with
 * `display: none` or `visibility: hidden`. Words inside other attributes' values do not count. */
function hides(source) {
  const found = attributesOf(source);
  return found.has('hidden') || /^\s*true\s*$/iu.test(found.get('aria-hidden') ?? '')
    || /display\s*:\s*none|visibility\s*:\s*hidden/iu.test(found.get('style') ?? '');
}

/** The page with every hidden element removed, up to its matching close tag (nesting counted). */
export function withoutHidden(html) {
  const tags = new RegExp(anyTag.source, anyTag.flags);
  let out = '';
  let kept = 0;
  for (let open = tags.exec(html); open; open = tags.exec(html)) {
    const [whole, closing, name, source] = open;
    if (closing || !hides(source)) continue;
    out += `${html.slice(kept, open.index)} `;
    kept = tags.lastIndex;
    const tagName = name.toLowerCase();
    if (!voidTags.has(tagName) && !/\/>$/u.test(whole)) {
      let depth = 1;
      let tag = null;
      while (depth > 0 && (tag = tags.exec(html))) {
        if (tag[2].toLowerCase() !== tagName) continue;
        if (tag[1]) depth -= 1;
        else if (!/\/>$/u.test(tag[0])) depth += 1;
      }
      // An element that is never closed hides the rest of the page.
      kept = tag ? tags.lastIndex : html.length;
    }
    tags.lastIndex = kept;
  }
  return out + html.slice(kept);
}

/** Visible body text, CSS and attribute values of a page, each folded to lower case. */
export function pageParts(html) {
  // Hidden elements are not shown to a visitor, so they earn nothing and their text is not read.
  const bare = withoutHidden(html.replace(/<!--[\s\S]*?-->/gu, ' '));
  const css = [...bare.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/giu)].map(match => match[1])
    .concat([...bare.matchAll(/style\s*=\s*"([^"]*)"/giu)].map(match => match[1]))
    .join(' ').replace(/\/\*[\s\S]*?\*\//gu, ' ');
  const attributes = [...bare.matchAll(/\b(fill|stroke|color|stop-color|href)\s*=\s*"([^"]*)"/giu)].map(match => match[2]).join(' ');
  const text = bare
    .replace(/<head[\s\S]*?<\/head>/giu, ' ').replace(/<title[\s\S]*?<\/title>/giu, ' ')
    .replace(/<script[\s\S]*?<\/script>/giu, ' ').replace(/<style[\s\S]*?<\/style>/giu, ' ')
    // Tags go with their quoted attribute values whole (a ">" inside a title is not the tag's end);
    // what is left, such as <!doctype html>, goes after.
    .replace(blockEnd, ' | ').replace(anyTag, ' ').replace(/<[^>]+>/gu, ' ')
    .replace(/&nbsp;/gu, ' ').replace(/&amp;/gu, '&').replace(/&#36;|&dollar;/gu, '$')
    .replace(/&ndash;|&mdash;|&#8211;|&#8212;/gu, '-').replace(/&quot;|&#34;/gu, '"').replace(/&#39;|&rsquo;|&apos;/gu, "'");
  return { text: fold(text), css: fold(css), attributes: fold(attributes), html: fold(bare) };
}

const menu = ['espresso', 'cortado', 'oat latte', 'cold brew'];

/**
 * The price shown for a menu item: the first "$" amount after the item's name, unless another
 * menu item starts a new row or block in between (so an item without a price cannot borrow
 * the next one's). A description that mentions "espresso" mid-sentence does not end the item.
 */
function pricesOf(text, item) {
  const others = menu.filter(name => name !== item);
  const found = [];
  for (const match of text.matchAll(new RegExp(`\\b${item}\\b`, 'gu'))) {
    const rest = text.slice(match.index + item.length, match.index + item.length + 200);
    const dollar = rest.indexOf('$');
    const between = rest.slice(0, Math.max(dollar, 0));
    // Another item starts a new row when its name opens a block as a short label ("| cold brew $"
    // or "| cold brew |"), not when a description sentence begins with it ("| espresso cut with…").
    const label = name => new RegExp(`\\|\\s*${name}\\b[^|$]{0,15}(\\||\\$)`, 'u');
    // between ends where the price starts, so the "$" is put back for the label test.
    if (dollar < 0 || others.some(name => label(name).test(between + '$'))) continue;
    const amount = /^\$\s?(\d+(?:\.\d{2})?)(?![\d.])/u.exec(rest.slice(dollar));
    // A label is the item's own short row: it opens a block, with at most two words before the
    // name ("| small oat latte $5.00") and a short gap to the price ("| oat latte (16 oz) $5.00").
    // A name in a sentence ("inspired by our oat latte $5.00", "oat latte fans might like our
    // cookie for $5.00") may be followed by some other thing's price, and so may a name whose
    // price lies past a block break ("| oat latte pairings | cookie $5.00").
    const ownRow = /(^|\|)\s*([\p{L}-]+\s+){0,2}$/u.test(text.slice(Math.max(0, match.index - 40), match.index))
      && !between.includes('|') && between.trim().length <= 15;
    if (amount) found.push({ price: Number(amount[1]), label: ownRow });
  }
  return found;
}
// The item's price is the first one after its name: later matches are often the item named in
// another item's description ("equal parts espresso and steamed milk $4.00").
const priceOf = (text, item) => pricesOf(text, item)[0]?.price ?? null;
// A replaced price counts as shown when it is the first price or follows the item as a label.
const shows = (text, item, amount) => pricesOf(text, item).some((found, index) => found.price === amount && (index === 0 || found.label));
const priced = (item, amount, replaced = []) => p =>
  priceOf(p.text, item) === amount && !replaced.some(old => shows(p.text, item, old));
const day = String.raw`\btues?(day)?s?\b`;

/** The client's final word: 15 requirements, each a test on the page. */
export const requirements = [
  ['Business name Tidewater Roast Co.', p => p.text.includes('tidewater roast co')],
  ['Tagline "Roasted slow, poured fresh."', p => p.text.includes('roasted slow, poured fresh')],
  ['Address 41 Harbor Lane, Portland, Maine', p => p.text.includes('41 harbor lane') && p.text.includes('portland') && p.text.includes('maine')],
  ['Closes at 15:00', p => /(?<![\d:])(15:00|15\.00|3\s?(:00)?\s?(pm|p\.m\.))/u.test(p.text)],
  // "Tue Closed" in an hours table counts (scorer fix after round 2, applied to every site).
  ['Closed on Tuesdays', p => new RegExp(`closed[^.|]{0,40}${day}|${day}[^.|]{0,20}closed`, 'u').test(p.text)],
  // Applied, not just mentioned: in a CSS declaration or a colour attribute, comments removed.
  ['Brand colour terracotta #C65D3B', p => /[:\s,(]#c65d3b\b/u.test(p.css) || p.attributes.includes('#c65d3b')],
  ['Headings in Fraunces', p => /(font(-family)?|--[\w-]+)\s*:[^;}]*fraunces/u.test(p.css)],
  ['Espresso $3.25', priced('espresso', 3.25)],
  ['Cortado $4.00', priced('cortado', 4)],
  ['Oat latte $5.25', priced('oat latte', 5.25, [5])],
  ['Cold brew $4.75', priced('cold brew', 4.75)],
  ['Features the Harbor Fog blend', p => p.text.includes('harbor fog')],
  // Monthly, not just $18: "/mo", "a month", "per month" or "monthly" right after the price, or
  // "monthly" or "per month" before it; never with "one-time", "once" or "upfront" in the same
  // sentence after it.
  ['Bean Club, $18 a month', p => [...p.text.matchAll(/bean club([^$]{0,300})\$\s?18(?:\.00)?(?![\d.])([^$]{0,30})/gu)].some(([, before, after]) => {
    // The sentence ends at a full stop or a block break ("| sign up once." is another paragraph).
    const sentence = after.replace(/([.!?](\s|$)|\|)[\s\S]*/u, '');
    return !/one[\s\p{Pd}]?time|\bonce\b|up[\s\p{Pd}]?front/u.test(sentence) &&
      (/^[\s|]*(\/\s*mo(nth)?\b|(a|per|each|every) month\b|monthly\b)/u.test(after) || /\bmonthly\b|\b(per|a|each|every) month\b/u.test(before));
  })],
  ['Phone (207) 555-0143', p => p.text.replace(/\D/gu, '').includes('2075550143')],
  ['Email hello@tidewater.example', p => p.text.includes('hello@tidewater.example')],
];

/** Replaced values that should be gone. */
export const stale = [
  ['Old colour forest green #2F5D50', p => p.css.includes('#2f5d50') || p.attributes.includes('#2f5d50')],
  ['Old closing time 17:00', p => /(?<![\d:])(17:00|17\.00|5\s?(:00)?\s?(pm|p\.m\.))/u.test(p.text)],
  // "Fresh every day" is fine; only the old opening pattern counts.
  ['Old hours "open every day"', p => /open (every day|daily|7 days a week|seven days)|every day,? (from )?7|(am|pm|:00)\s*,?\s*(daily|every day)/u.test(p.text)],
  ['Old oat latte price $5.00', p => shows(p.text, 'oat latte', 5)],
];

/** Things the client ruled out. */
export const forbidden = [
  // The eval rules out a wholesale section: a heading, link or form about it. A passing mention
  // is reported separately (see scoreSite), not counted here.
  ['A wholesale section', p => /<h[1-6][^>]*>[^<]*wholesale|<a\b[^>]*>[^<]*wholesale|<form\b[\s\S]*?wholesale[\s\S]*?<\/form>/u.test(p.html)],
  // The client said never to say it anywhere, so any mention counts.
  ['Says gluten-free', p => /gluten[\s\p{Pd}]?free/u.test(p.text)],
  ['Online ordering', p => /order online|online order|order ahead|order now|pick-?up order|start (your|an) order/u.test(p.text)],
];

/** The one HTML document in an agent's reply, or '' when there is none or more than one. */
export function htmlOf(reply) {
  const starts = [...reply.matchAll(/<!doctype html/giu)].map(match => match.index);
  if (starts.length !== 1) return '';
  const end = reply.toLowerCase().lastIndexOf('</html>');
  return end > starts[0] ? reply.slice(starts[0], end + 7) : '';
}

export function scoreSite(html) {
  const parts = pageParts(html);
  const check = list => list.map(([name, test]) => ({ name, hit: Boolean(test(parts)) }));
  const req = check(requirements);
  const old = check(stale);
  const bad = check(forbidden);
  return {
    requirements: req.filter(r => r.hit).length, of: req.length,
    missed: req.filter(r => !r.hit).map(r => r.name),
    stale: old.filter(r => r.hit).map(r => r.name),
    forbidden: bad.filter(r => r.hit).map(r => r.name),
    mentions: parts.text.includes('wholesale') ? ['Mentions wholesale'] : [],
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await writeFile(new URL('roaster-chat.jsonl', import.meta.url), roasterTranscript() + '\n');
  console.log('wrote demo/roaster-chat.jsonl');
}
