import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import test from 'node:test';

// Card U2: the brand tokens pass contrast, and Pip's SVGs are safe to inline as they are.
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16) / 255)
    .map(value => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
};
const tokensIn = block => Object.fromEntries([...block.matchAll(/--(ctm-[a-z0-9-]+):\s*(#[0-9a-f]{6})/gu)].map(match => [match[1], match[2]]));

function sets() {
  const css = read('docs/brand/tokens.css');
  const split = css.indexOf('.ctm-dark');
  const light = tokensIn(css.slice(0, split));
  const darkOwn = tokensIn(css.slice(split));
  return { light, darkOwn, dark: { ...light, ...darkOwn } };
}

test('the brand colours are the CTM site\'s, Soft Violet included', () => {
  const { light } = sets();
  assert.deepEqual(['ctm-charcoal', 'ctm-violet', 'ctm-violet-soft', 'ctm-lime', 'ctm-paper'].map(name => light[name]),
    ['#18181c', '#723bfa', '#9e7bff', '#b9f500', '#f4f3f7']);
});

test('every pair in the guide passes WCAG AA in both sets, and the dark set inherits no colour it must set', () => {
  const { light, darkOwn, dark } = sets();
  // The pairs of the guide's table, as [foreground, background] variable names.
  const pairs = [
    ['ctm-text', 'ctm-bg'], ['ctm-text-2', 'ctm-bg'], ['ctm-link', 'ctm-bg'], ['ctm-link-hover', 'ctm-bg'],
    ['ctm-button-text', 'ctm-button-fill'], ['ctm-button-text', 'ctm-button-fill-hover'],
    ['ctm-quoted', 'ctm-quoted-fill'], ['ctm-inferred', 'ctm-inferred-fill'],
    ['ctm-text', 'ctm-surface'], ['ctm-text-2', 'ctm-surface'], ['ctm-link', 'ctm-surface'],
    ['ctm-quoted', 'ctm-bg'], ['ctm-inferred', 'ctm-bg'], ['ctm-working', 'ctm-bg'], ['ctm-waiting', 'ctm-bg'], ['ctm-idle', 'ctm-bg'],
  ];
  for (const [name, set] of [['light', light], ['dark', dark]]) {
    for (const [fore, back] of pairs) {
      const ratio = contrast(set[fore], set[back]);
      assert.ok(ratio >= 4.5, `${name}: ${fore} on ${back} is ${ratio.toFixed(2)}`);
    }
  }
  // Every text, fill and button variable is set again for dark (review of U2).
  for (const name of new Set(pairs.flat())) assert.ok(name in darkOwn, `the dark set sets ${name}`);
  assert.ok(contrast(light['ctm-charcoal'], light['ctm-lime']) >= 4.5);
  assert.ok(contrast('#ffffff', light['ctm-lime']) < 3, 'the guide says never put white text on lime');
});

test('each ratio in the guide\'s table is the computed one for its row and column', () => {
  const guide = read('docs/brand/brand.md').replace(/\r\n/gu, '\n');
  const { light, dark } = sets();
  // Review round 2: each table cell is checked against its own pair, not found anywhere.
  const rows = {
    'Text on background': ['ctm-text', 'ctm-bg'],
    'Secondary text on background': ['ctm-text-2', 'ctm-bg'],
    'Link on background': ['ctm-link', 'ctm-bg'],
    'Link hover on background': ['ctm-link-hover', 'ctm-bg'],
    'Button text on button fill': ['ctm-button-text', 'ctm-button-fill'],
    'Button text on hover fill': ['ctm-button-text', 'ctm-button-fill-hover'],
    'Quoted mark on its fill': ['ctm-quoted', 'ctm-quoted-fill'],
    'Inferred mark on its fill': ['ctm-inferred', 'ctm-inferred-fill'],
  };
  for (const [label, [fore, back]] of Object.entries(rows)) {
    const row = guide.split('\n').find(line => line.startsWith(`| ${label} |`));
    assert.ok(row, label);
    const [lightCell, darkCell] = row.split('|').slice(2, 4);
    for (const [cell, set, name] of [[lightCell, light, 'light'], [darkCell, dark, 'dark']]) {
      const shown = cell.match(/([\d.]+):1/u)?.[1];
      assert.equal(shown, contrast(set[fore], set[back]).toFixed(1), `${label}, ${name}`);
    }
  }
  // The three lime figures in the text.
  const lime = light['ctm-lime'];
  assert.match(guide, new RegExp(`White on lime is ${contrast('#ffffff', lime).toFixed(1)}:1`, 'u'));
  assert.match(guide, new RegExp(`Charcoal on lime is ${contrast(light['ctm-charcoal'], lime).toFixed(1)}:1`, 'u'));
  assert.match(guide, new RegExp(`lime spark is ${contrast(lime, light['ctm-paper']).toFixed(1)}:1 against Paper`, 'u'));
});

const allowedElements = new Set(['svg', 'path', 'ellipse', 'circle', 'rect']);
const allowedAttributes = new Set(['xmlns', 'viewBox', 'role', 'aria-label', 'd', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'width', 'height',
  'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'opacity']);
const illustrationColours = new Set(['#18181c', '#723bfa', '#9e7bff', '#b9f500', '#f4f3f7', '#ffffff', '#5b2bd4', '#8a4f00']);

test('Pip\'s SVGs hold only allowed elements, attributes and colours, and name their pose', () => {
  const poses = { 'pip.svg': 'idle', 'pip-working.svg': 'working', 'pip-waiting.svg': 'waiting for an answer' };
  for (const [file, pose] of Object.entries(poses)) {
    const path = `docs/brand/${file}`;
    const svg = read(path);
    assert.ok(statSync(new URL(`../${path}`, import.meta.url)).size < 4096, file);
    assert.match(svg, new RegExp(`^<svg [^>]*aria-label="Pip, the CTM mascot, ${pose}"`, 'u'), file);
    assert.doesNotMatch(svg, /\sid=/u, `${file}: no IDs, so inlined copies cannot clash`);
    const body = svg.replace(/<!--[\s\S]*?-->/gu, '');
    for (const [, name, attributes] of body.matchAll(/<([a-zA-Z][\w:-]*)([^>]*)>/gu)) {
      assert.ok(allowedElements.has(name), `${file}: element <${name}>`);
      for (const [, attribute] of attributes.matchAll(/([\w:-]+)\s*=/gu)) assert.ok(allowedAttributes.has(attribute), `${file}: attribute ${attribute}`);
    }
    for (const colour of body.match(/#[0-9a-f]{6}/giu)) assert.ok(illustrationColours.has(colour.toLowerCase()), `${file}: colour ${colour}`);
    // Review round 2: every paint is an allowed colour or none (no names, no url()),
    // and the root keeps the attributes that make it an accessible, scalable image.
    for (const [, attribute, value] of body.matchAll(/\s(fill|stroke)="([^"]*)"/gu)) {
      assert.ok(value === 'none' || illustrationColours.has(value.toLowerCase()), `${file}: ${attribute}="${value}"`);
    }
    const root = body.match(/^<svg([^>]*)>/u)[1];
    for (const required of ['xmlns="http://www.w3.org/2000/svg"', 'viewBox="0 0 120 120"', 'role="img"']) {
      assert.ok(root.includes(required), `${file}: root has ${required}`);
    }
  }
});

test('the brand guide points at files that exist', () => {
  const guide = read('docs/brand/brand.md');
  for (const [, target] of guide.matchAll(/\]\(([^)#]+)\)/gu)) {
    if (target.startsWith('http')) continue;
    assert.ok(statSync(new URL(`../docs/brand/${target}`, import.meta.url)), target);
  }
});
