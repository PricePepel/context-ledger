// Card U10: every file the server can serve ships in the package, so an installed copy
// looks like a checkout. Found when the installed console came up without its colours,
// fonts and logo: the server read them from docs/brand/, which the package left out.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { staticFiles, staticFileUrl } from '../src/static-files.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = promisify(execFile);

// npm's own script, run with this node and no shell (a .cmd shim needs cmd.exe): next to
// node (Windows, setup-node, nvm), where npm says it is when it runs the tests, or where a
// distribution's own package puts it (Debian and Ubuntu; U10 review).
const npmCli = [
  join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  process.env.npm_execpath?.endsWith('npm-cli.js') ? process.env.npm_execpath : undefined,
  '/usr/share/nodejs/npm/bin/npm-cli.js',
  '/usr/lib/node_modules/npm/bin/npm-cli.js',
].filter(Boolean).find(existsSync);

// A file on the list as a path from the repository root, with forward slashes.
const fromRoot = file => posix.normalize(`public/${file}`);
const sources = [...new Set([...staticFiles.values()].map(([file]) => fromRoot(file)))];

// The only files served from outside public/: one source for the brand (cards U2 to U6).
const brandFiles = [
  'docs/brand/ctm-logo.svg',
  'docs/brand/fonts/inter-tight.woff2',
  'docs/brand/fonts/jersey-15.woff2',
  'docs/brand/fonts/silkscreen.woff2',
  'docs/brand/tokens.css',
];
const fontLicences = ['OFL-intertight.txt', 'OFL-jersey15.txt', 'OFL-silkscreen.txt'].map(name => `docs/brand/fonts/${name}`);

test('U10: every file the server serves is in the tarball npm makes', async () => {
  assert.ok(npmCli, 'npm-cli.js was not found next to node, at npm_execpath or in /usr/share/nodejs/npm');
  const { stdout } = await run(process.execPath, [npmCli, 'pack', '--dry-run', '--json'], { cwd: repo, encoding: 'utf8', timeout: 120_000 });
  const packed = new Set(JSON.parse(stdout)[0].files.map(file => file.path.split('\\').join('/')));
  assert.ok(sources.length >= 25, 'the list was read');
  for (const source of sources) {
    assert.ok(statSync(join(repo, source)).size > 0, `${source} is empty`);
    assert.ok(packed.has(source), `${source} is served but not packaged: add it to "files" in package.json`);
  }
  // The fonts are under the SIL Open Font License, which travels with them.
  for (const licence of fontLicences) assert.ok(packed.has(licence), licence);
  // Nothing else from docs/ ships.
  assert.deepEqual([...packed].filter(path => path.startsWith('docs/')).sort(), [...brandFiles, ...fontLicences].sort());
});

test('U10: the list names only files in public/ and the five brand files', () => {
  assert.deepEqual(sources.filter(source => !source.startsWith('public/')).sort(), brandFiles);
  for (const [path, [file, type]] of staticFiles) {
    assert.match(path, /^\/(?:[a-z0-9-]+(?:\.[a-z0-9]+)?\/?)*$/u, path);
    assert.match(type, /^(?:text\/(?:html|css|javascript)|application\/json|image\/svg\+xml|font\/woff2)$/u, path);
    assert.equal(fileURLToPath(staticFileUrl(file)), join(repo, ...fromRoot(file).split('/')), path);
  }
});

test('U10: the package list names the brand files one by one, not the docs folder', () => {
  const { files } = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  assert.deepEqual(files.filter(entry => entry.startsWith('docs')), ['docs/brand/tokens.css', 'docs/brand/ctm-logo.svg', 'docs/brand/fonts/']);
});
