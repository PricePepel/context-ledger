// A synthetic planning session for a small bakery website, in Claude Code JSONL form,
// and a grader for the site agents build from it. Several decisions change late in the
// session, so an agent that reads only the start, or keeps the first mention, gets
// them wrong. Every name, number and address here is invented.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const turn = (role, content) => ({ type: role, message: { role, content } });

// [position in the session from 0 to 1, user text, assistant text]
const decisions = [
  [0.01, 'We are building the website for my bakery, Hearth & Crumb, in Tashkent. Three pages: index.html (home), menu.html and contact.html. Plain HTML and CSS, no JavaScript and no frameworks. One shared styles.css. The site is in English.',
    'Noted: Hearth & Crumb, three pages (index.html, menu.html, contact.html), plain HTML and CSS with one shared styles.css, no JavaScript, English.'],
  [0.08, 'Use our brand blue, #1E6FD9, as the accent colour.', 'Accent colour set to #1E6FD9.'],
  [0.14, 'For type, load Roboto from Google Fonts.', 'Planned: Roboto from Google Fonts for all text.'],
  [0.2, 'Our phone number is +998 71 200 00 00.', 'Phone recorded: +998 71 200 00 00.'],
  [0.26, 'Opening hours: Monday to Saturday 08:00–20:00, closed on Sunday.', 'Hours recorded: Monday to Saturday 08:00–20:00, Sunday closed.'],
  [0.32, 'Menu for the menu page: Croissant 18 000 UZS, Samsa 12 000 UZS, Non bread 8 000 UZS, Honey cake 35 000 UZS, Cappuccino 25 000 UZS.',
    'Menu recorded with five items and prices in UZS: Croissant 18 000, Samsa 12 000, Non bread 8 000, Honey cake 35 000, Cappuccino 25 000.'],
  [0.38, 'The contact page should have a contact form that posts to /api/contact.', 'Planned: a contact form on contact.html posting to /api/contact.'],
  [0.56, 'The blue clashes with the new logo. Change of plan: the accent colour is now green, #2F7D4F. Do not use the blue anywhere.',
    'Decision updated: the accent colour is #2F7D4F (green). The old blue #1E6FD9 is dropped everywhere.'],
  [0.66, 'Our privacy policy says no third-party requests. Drop Google Fonts and Roboto, use the system font stack instead.',
    'Decision updated: no Google Fonts and no Roboto. Use the system font stack only.'],
  [0.76, 'We have no backend after all. Remove the contact form. Instead, show an email link to hello@hearthcrumb.uz.',
    'Decision updated: no form on the contact page. Use a mailto link to hello@hearthcrumb.uz.'],
  [0.85, 'Correction: the phone number was wrong. The right one is +998 71 234 56 78.', 'Phone corrected: +998 71 234 56 78. The old number is wrong and must not appear.'],
  [0.91, 'We will open on Sundays now, from 09:00 to 15:00. Monday to Saturday stays 08:00–20:00.',
    'Hours updated: Monday to Saturday 08:00–20:00, Sunday 09:00–15:00.'],
  [0.96, 'Flour prices went up. The croissant is now 22 000 UZS. Other prices stay the same.', 'Price updated: Croissant 22 000 UZS. The other four prices are unchanged.'],
];

const fillerTopics = [
  ['The CI run for the {n}th time took eleven minutes. Is that normal?', 'Most of it is the dependency install. Caching it would save about {m} minutes; I will note it for later.'],
  ['Can you remind me how to undo my last local commit without losing changes?', 'Use git reset --soft HEAD~1. Your changes stay staged, and nothing is pushed.'],
  ['I will be in a meeting for {m}0 minutes.', 'Understood. I will wait and not change anything while you are away.'],
  ['My other client, the courier app, has a bug with login on Android {n}.', 'That is outside this project. I can look at it in a separate session if you want.'],
  ['Explain the difference between padding and margin again.', 'Padding is the space inside an element\'s border; margin is the space outside it, between elements.'],
  ['The photographer will send pictures of the pastries next week, batch {n}.', 'Fine. Until then the pages can use neutral placeholder blocks with alt text.'],
  ['What is a good image size for a hero picture?', 'Around 1600 pixels wide, compressed to under {m}00 kilobytes, works well on most screens.'],
  ['Lunch break, back in half an hour.', 'Noted. Nothing will change until you are back.'],
  ['Our accountant asked about invoice number {n}0{m}.', 'That is not something I can see from here. Your accounting system should have it.'],
  ['How do I check my disk usage on the laptop?', 'On macOS, About This Mac, then Storage, or du -sh on a folder in the terminal.'],
  ['Should we worry about SEO right now?', 'Only the basics: a clear title and description on each page and real text instead of images of text.'],
  ['The domain renewal reminder came again, number {n}.', 'Renewing a few weeks early avoids surprises. It does not affect the build.'],
  ['What does the 404 status code mean?', 'The server could not find the requested page. A static site shows it for a wrong link.'],
  ['My cousin wants a website for his car repair shop too, maybe in {m} months.', 'Happy to help later. It would be a separate project with its own plan.'],
  ['How many people visit a small bakery website, roughly?', 'For a local bakery, a few dozen to a few hundred visits a day is typical, mostly on phones.'],
];

function filler(index) {
  const [user, assistant] = fillerTopics[index % fillerTopics.length];
  const fill = text => text.replaceAll('{n}', String(index + 2)).replaceAll('{m}', String((index % 7) + 2));
  return [fill(user), fill(assistant)];
}

/** The session as Claude Code JSONL, with `chatter` filler exchanges among the decisions. */
export function makeSession(chatter = 600) {
  const exchanges = [];
  let next = 0;
  for (let index = 0; index <= chatter; index += 1) {
    const position = chatter ? index / chatter : 1;
    while (next < decisions.length && decisions[next][0] <= position) {
      exchanges.push(decisions[next].slice(1));
      next += 1;
    }
    if (index < chatter) exchanges.push(filler(index));
  }
  while (next < decisions.length) exchanges.push(decisions[next++].slice(1));
  const records = exchanges.flatMap(([user, assistant]) => [turn('user', user), turn('assistant', assistant)]);
  return {
    jsonl: records.map(record => JSON.stringify(record)).join('\n'),
    // The same session as a plain Markdown export, for the arm without Context Ledger.
    markdown: ['# Previous planning session (exported transcript)', '',
      ...exchanges.flatMap(([user, assistant]) => [`**User:** ${user}`, '', `**Assistant:** ${assistant}`, ''])].join('\n'),
  };
}

function siteFiles(dir) {
  const files = new Map();
  const walk = folder => {
    for (const name of readdirSync(folder)) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const path = join(folder, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(html?|css)$/iu.test(name)) files.set(relative(dir, path).replaceAll('\\', '/'), readFileSync(path, 'utf8'));
    }
  };
  walk(dir);
  return files;
}

const visible = html => html.replace(/<style[\s\S]*?<\/style>/giu, ' ').replace(/<[^>]+>/gu, ' ')
  .replace(/&nbsp;|&#160;/gu, ' ').replace(/&amp;/gu, '&').replace(/&ndash;|&#8211;/gu, '–').replace(/\s+/gu, ' ');
const digits = text => text.replace(/\D+/gu, '');

/** Check the built site against the final decisions. */
export function gradeSite(dir) {
  const files = siteFiles(dir);
  const pages = ['index.html', 'menu.html', 'contact.html'];
  const page = name => [...files].find(([path]) => path === name || path.endsWith('/' + name))?.[1] ?? '';
  const html = [...files].filter(([path]) => /\.html?$/iu.test(path)).map(([, text]) => text).join('\n');
  const css = [...files].filter(([path]) => /\.css$/iu.test(path)).map(([, text]) => text).join('\n') +
    (html.match(/<style[\s\S]*?<\/style>|style="[^"]*"/giu) ?? []).join('\n');
  const all = html + '\n' + css;
  const text = visible(html);
  const near = (pattern, value, span = 80) => new RegExp(`${pattern}.{0,${span}}?${value}`, 'iu').test(text);
  // The first price after each mention of the croissant, in thousands of UZS.
  const croissantPrices = [...text.matchAll(/croissant/giu)]
    .map(match => text.slice(match.index, match.index + 300).match(/\b(\d{1,3})[\s,.]?000\b/u)?.[1])
    .filter(Boolean).map(Number);

  const checks = {
    pages: pages.every(name => page(name)),
    sharedStyles: Boolean([...files.keys()].find(path => /(^|\/)styles\.css$/iu.test(path))) &&
      pages.every(name => /href="[^"]*styles\.css"/iu.test(page(name))),
    accentGreen: /#2f7d4f/iu.test(css) && !/#1e6fd9/iu.test(all),
    // A system font stack may name Roboto as a local font; what the decision forbids is loading fonts from elsewhere.
    noWebFonts: !/fonts\.googleapis|fonts\.gstatic|@font-face|@import\s+url\(\s*['"]?https?:/iu.test(all),
    noJavaScript: !/<script/iu.test(html),
    phone: digits(text).includes('998712345678') && !digits(text).includes('998712000000'),
    sundayHours: near('sunday', '09[:.]00\\s*(?:–|-|—|to)\\s*15[:.]00', 40) && !near('sunday', 'closed', 20),
    croissantPrice: croissantPrices.includes(22) && !croissantPrices.includes(18),
    emailNotForm: /mailto:hello@hearthcrumb\.uz/iu.test(html) && !/<form/iu.test(html),
    brand: /hearth\s*(?:&|&amp;|and)\s*crumb/iu.test(page('index.html')),
  };
  return { score: Object.values(checks).filter(Boolean).length, total: Object.keys(checks).length, checks, files: [...files.keys()] };
}
