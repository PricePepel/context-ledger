// Pixel sprites for the office, one per agent source, on a 16 x 20 grid. Clawd and the
// Codex pet are drawn after each vendor's own mascot for this local console: they are
// trademarks, so swap them for the neutral bot before a public video or deploy.
// Every pixel is an SVG rect with a fill attribute, so the CSP needs no style attribute.

const K = '#1d1820';

export const SPRITES = {
  claude: {
    label: 'Claude Code',
    draw: p => {
      const o = '#D77757';
      p(3, 6, 10, 7, o); p(1, 9, 2, 2, o); p(13, 9, 2, 2, o);
      p(4, 13, 1, 3, o); p(6, 13, 1, 3, o); p(9, 13, 1, 3, o); p(11, 13, 1, 3, o);
      p(5, 8, 1, 2, K); p(10, 8, 1, 2, K);
    },
  },
  codex: {
    label: 'Codex',
    draw: p => {
      const b = '#5B7CF0', l = '#86A2FF', d = '#3A55C8', s = '#1E2140', c = '#8FF0FF';
      p(5, 1, 3, 1, b); p(9, 1, 3, 1, b); p(3, 2, 10, 1, b); p(2, 3, 12, 7, b);
      p(1, 4, 1, 4, b); p(14, 4, 1, 4, b); p(3, 10, 10, 1, d);
      p(4, 2, 3, 1, l); p(3, 3, 2, 1, l); p(2, 4, 1, 2, l);
      p(4, 4, 9, 5, s);
      p(5, 5, 1, 1, c); p(6, 6, 1, 1, c); p(5, 7, 1, 1, c);
      p(8, 6, 1, 1, c); p(9, 7, 2, 1, c); p(11, 6, 1, 1, c);
      p(5, 11, 6, 5, b); p(5, 15, 6, 1, d); p(3, 12, 2, 3, b); p(11, 12, 2, 3, b);
      p(6, 12, 1, 1, c); p(7, 13, 1, 1, c); p(6, 14, 1, 1, c); p(8, 13, 2, 1, c);
      p(5, 16, 2, 2, b); p(9, 16, 2, 2, b); p(5, 18, 2, 1, d); p(9, 18, 2, 1, d);
    },
  },
  bot: {
    label: 'Agent',
    draw: p => {
      const g = '#8A8F98';
      p(3, 5, 2, 2, g); p(11, 5, 2, 2, g); p(4, 6, 8, 7, g); p(5, 8, 6, 3, '#EEF0F3');
      p(6, 9, 1, 1, K); p(9, 9, 1, 1, K);
      p(5, 13, 6, 4, '#666A72'); p(6, 17, 1, 2, K); p(9, 17, 1, 2, K);
    },
  },
};

/** The sprite for an agent source; any source without its own sprite gets the neutral bot. */
export const spriteKey = provider => (provider !== 'bot' && Object.hasOwn(SPRITES, provider) ? provider : 'bot');

/**
 * The pixels of a sprite as [x, y, width, height, fill] on the 16 x 20 grid.
 * Pure, so a node test can check the grid without a DOM.
 */
export function spritePixels(provider) {
  const pixels = [];
  SPRITES[spriteKey(provider)].draw((x, y, width, height, fill) => pixels.push([x, y, width, height, fill]));
  return pixels;
}

// Card U4b: a role accessory on top of the sprite, picked from words in the agent's label.
// Accessories may reach past the 16 x 20 grid (a hat above the head), so they are drawn apart.
export const ROLES = ['planner', 'builder', 'tester', 'reviewer', 'writer', 'scout'];

// Whole words only, so "codex", "inspector" or "docker" pick no role.
const ROLE_WORDS = [
  ['reviewer', /^(?:review|reviews|reviewer|reviewing|audit|auditor|critic|critique|check|checker)$/u],
  ['tester', /^(?:test|tests|tester|testing|qa|verify|verifier|eval|evals|evaluator)$/u],
  ['planner', /^(?:plan|plans|planner|planning|architect|design|designer|spec|specs)$/u],
  ['builder', /^(?:build|builder|building|implement|implementer|refactor|refactoring|fix|fixer|coder|coding|dev|developer|engineer)$/u],
  ['writer', /^(?:doc|docs|documentation|write|writer|writing|copy|copywriter|notes)$/u],
  ['scout', /^(?:scout|research|researcher|explore|explorer|search|triage|finder)$/u],
];

/** The role an agent label suggests, or '' when no role word matches. */
export function roleOf(label) {
  const words = String(label ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u);
  const hit = ROLE_WORDS.find(([, pattern]) => words.some(word => pattern.test(word)));
  return hit ? hit[0] : '';
}

// Where each sprite's head and right hand sit on its grid.
const BODY = {
  claude: { top: 6, cx: 8, eyes: [5, 10], eyeY: 8, hand: [13, 9] },
  codex: { top: 1, cx: 8, eyes: [5, 10], eyeY: 6, hand: [11, 12], screenFace: true },
  bot: { top: 5, cx: 8, eyes: [6, 9], eyeY: 9, hand: [11, 13] },
};

const ACCESSORIES = {
  builder: (p, b) => {
    const y = '#F5C518', d = '#C99A00';
    p(b.cx - 4, b.top - 3, 8, 3, y); p(b.cx - 1, b.top - 4, 2, 1, y);
    p(b.cx - 6, b.top - 1, 12, 1, d); p(b.cx - 3, b.top - 2, 1, 1, '#FFE680');
  },
  scout: (p, b) => {
    const k = '#C8B07A', band = '#6E4A24';
    p(b.cx - 3, b.top - 4, 6, 2, k); p(b.cx - 4, b.top - 2, 8, 1, band); p(b.cx - 7, b.top - 1, 14, 1, k);
  },
  reviewer: (p, b) => {
    const [l, r] = b.eyes, y = b.eyeY, k = '#1d1820';
    if (b.screenFace) {
      // A face on a screen has no room for glasses, so this reviewer holds a magnifier.
      const [x, h] = b.hand, rim = '#C99A00';
      p(x, h - 3, 3, 2, '#BFE3FF'); p(x, h - 4, 3, 1, rim); p(x, h - 1, 3, 1, rim);
      p(x - 1, h - 3, 1, 2, rim); p(x + 3, h - 3, 1, 2, rim); p(x + 3, h - 1, 1, 1, '#6E4A24'); p(x + 4, h, 1, 2, '#6E4A24');
      return;
    }
    for (const x of [l, r]) { p(x - 1, y - 1, 3, 3, '#BFE3FF'); p(x - 1, y - 1, 3, 1, k); p(x, y, 1, 2, k); }
    if (r - l > 3) p(l + 2, y - 1, r - l - 3, 1, k);
    p(l - 2, y - 1, 1, 1, k); p(r + 2, y - 1, 1, 1, k);
  },
  planner: (p, b) => {
    const [x, y] = b.hand;
    p(x, y - 1, 4, 6, '#2F6FD6'); p(x + 1, y, 3, 4, '#F4F3F7');
    p(x + 1, y + 1, 2, 1, '#9AA3B5'); p(x + 1, y + 3, 2, 1, '#9AA3B5'); p(x, y - 1, 1, 6, '#1F4FA0');
  },
  tester: (p, b) => {
    const [x, y] = b.hand;
    p(x + 1, y - 3, 1, 2, '#DCEFF7'); p(x, y - 1, 3, 1, '#DCEFF7');
    p(x - 1, y, 5, 3, '#B9F500'); p(x, y + 3, 3, 1, '#B9F500'); p(x, y, 1, 1, '#E8FF9E');
  },
  writer: (p, b) => {
    const [x, y] = b.hand;
    p(x + 1, y - 5, 1, 1, '#F29BB2'); p(x + 1, y - 4, 1, 5, '#F5C518'); p(x + 1, y + 1, 1, 1, '#E6C79C');
    p(x + 1, y + 2, 1, 1, '#1d1820');
  },
};

/** Accessory pixels for a sprite and role, as [x, y, width, height, fill]; empty for no role. */
export function accessoryPixels(provider, role) {
  const pixels = [];
  const draw = Object.hasOwn(ACCESSORIES, role) ? ACCESSORIES[role] : null;
  if (draw) draw((x, y, width, height, fill) => pixels.push([x, y, width, height, fill]), BODY[spriteKey(provider)]);
  return pixels;
}
