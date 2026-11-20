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
      const v = '#8B5CF6', d = '#6D3FD6', w = '#ffffff';
      p(7, 2, 2, 2, d); p(5, 4, 6, 1, v); p(4, 5, 8, 9, v); p(5, 14, 6, 1, v);
      p(5, 7, 6, 3, K); p(6, 8, 1, 1, '#7DF9FF'); p(9, 8, 1, 1, '#7DF9FF');
      p(6, 11, 1, 1, w); p(7, 12, 1, 1, w); p(6, 13, 1, 1, w); p(8, 13, 2, 1, w);
      p(5, 15, 2, 2, d); p(9, 15, 2, 2, d);
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
