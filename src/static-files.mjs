// The fixed list of files the loopback server serves without a sign-in: URL path to
// [file, content type]. A file is named from public/. The five brand files (colour tokens,
// logo and three fonts; cards U2, U4, U4b and U6) have one source in docs/brand/ and are
// named with a leading '../'.
//
// Card U10: the list lives in this module so a test can check that every file on it ships
// in the package. A file served from here must also be in "files" in package.json, or an
// installed copy answers 500 for it (tests/package-files.test.mjs).
export const staticFiles = new Map([
  ['/', ['index.html', 'text/html']],
  ['/app.js', ['app.js', 'text/javascript']],
  ['/styles.css', ['styles.css', 'text/css']],
  // Card U8: the pixel look the library and the swarm page share with the console.
  ['/pixel.css', ['pixel.css', 'text/css']],
  // P1f: the browser's session secret lives in this origin's storage; session.js reads
  // it for the pages, and the sign-in page turns a one-time code into one.
  ['/session.js', ['session.js', 'text/javascript']],
  ['/login', ['login.html', 'text/html']],
  ['/login.js', ['login.js', 'text/javascript']],
  // The console (card U1): a fixed list, so no other path under /console/ is served.
  ['/console', ['console/index.html', 'text/html']],
  ['/console/', ['console/index.html', 'text/html']],
  ...['console.css', 'office.css'].map(name => [`/console/${name}`, [`console/${name}`, 'text/css']]),
  // Card U4: the brand tokens have one source, docs/brand/tokens.css (card U2).
  ['/console/tokens.css', ['../docs/brand/tokens.css', 'text/css']],
  // Card U4b: the header logo and favicon, the CTM mark from ctm-ai.uz.
  ['/console/logo.svg', ['../docs/brand/ctm-logo.svg', 'image/svg+xml']],
  ...['console.mjs', 'office.mjs', 'office-furniture.mjs', 'sprites.mjs', 'agent-marks.mjs', 'ctm-band.mjs', 'panels.mjs', 'review.mjs', 'swarm-room.mjs', 'swarm-agent.mjs', 'model.mjs', 'source.mjs', 'brain.mjs', 'evidence.mjs']
    .map(name => [`/console/${name}`, [`console/${name}`, 'text/javascript']]),
  ['/console/demo-recording.json', ['console/demo-recording.json', 'application/json']],
  // The same session.js, so the console's files all stay under /console/ (P1f).
  ['/console/session.js', ['session.js', 'text/javascript']],
  // Card U6: the console's three OFL fonts, local so no request leaves the loopback host.
  ...['jersey-15', 'inter-tight', 'silkscreen'].map(name => [`/console/fonts/${name}.woff2`, [`../docs/brand/fonts/${name}.woff2`, 'font/woff2']]),

  // The swarm demo (card S1), also a fixed list.
  ['/swarm', ['swarm/index.html', 'text/html']],
  ['/swarm/', ['swarm/index.html', 'text/html']],
  ['/swarm/swarm.css', ['swarm/swarm.css', 'text/css']],
  ['/swarm/swarm.mjs', ['swarm/swarm.mjs', 'text/javascript']],
  // The same session.js, so the swarm page signs its API calls like the library (P1f).
  ['/swarm/session.js', ['session.js', 'text/javascript']],
]);

/** Where a file on the list is on disk. */
export const staticFileUrl = file => new URL(`../public/${file}`, import.meta.url);
