import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { allowedRequest, consoleFiles, ledgerEnv, publishTake, speed } from '../demo/record-console.mjs';

// Card U3: the shot list fits 60 seconds at an easy pace, what it shows is in the demo
// data, and the recorder keeps to the console and to its own files.
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replace(/\r\n/gu, '\n');
const seconds = time => { const [m, s] = time.split(':').map(Number); return m * 60 + s; };
const shots = () => read('docs/video/u3-script.md').split('\n').filter(line => /^\| \d:\d\d–\d:\d\d \|/u.test(line))
  .map(line => line.split('|').map(cell => cell.trim()));

test('U3: five shots run from 0:00 to 1:00 with no gap, and no shot needs more than 2.5 words a second', () => {
  const rows = shots();
  assert.equal(rows.length, 5);
  let at = 0;
  for (const [, span, , , voice] of rows) {
    const [start, end] = span.split('–').map(seconds);
    assert.equal(start, at, `${span} starts where the last shot ended`);
    at = end;
    // A shot with two versions of the line (before and after G8) is paced on the longer one.
    const longest = Math.max(...voice.split(/(?:After|Before) G8:/u).map(part => part.replace(/"/gu, '').split(/\s+/u).filter(Boolean).length));
    assert.ok(longest / (end - start) <= 2.5, `${span}: ${longest} words`);
  }
  assert.equal(at, 60);
});

test('U3: the numbers shot keeps the estimate label, and the privacy line says only what the tool does', () => {
  const numbers = shots().at(-1);
  assert.match(numbers[3], /labels as an estimate/u);
  assert.doesNotMatch(read('docs/video/u3-script.md'), /never leave your machine|only the cited summary/iu, 'review round 1: claims the tool does not keep');
  assert.match(numbers[4], /The ledger stays on your machine. Agents get cited context./u);
});

test('U3: the answer and the proof the script narrates are in the demo recording, with lines L27 and L28', () => {
  const recording = JSON.parse(read('public/console/demo-recording.json'));
  const last = recording.events.at(-1).graph.packet;
  assert.equal(last.party, 'leo');
  assert.ok((last.links ?? []).some(link => link.type === 'answers' && link.from === 'port-4317' && link.to === 'which-port'));
  const decision = last.nodes.find(node => node.id === 'port-4317');
  assert.equal(decision.label, 'The ledger stays on port 4317');
  assert.deepEqual(decision.evidenceLines, [27, 28]);
  // The whole replay fits the growth shot (play to finished, 27 s) at the recorder's speed.
  assert.ok(recording.durationMs / speed / 1000 <= 27, 'the replay fits the growth shot');
  // Review round 2: the recorder marks every cue, once, in the order of the take, and the
  // script names only those cues.
  const order = ['emptyOffice', 'play', 'firstLink', 'answerLink', 'finished', 'proofOpen', 'numbers', 'end'];
  const marked = [...read('demo/record-console.mjs').matchAll(/mark\('([a-zA-Z]+)'\)/gu)].map(match => match[1]);
  assert.deepEqual(marked, order);
  const named = [...read('docs/video/u3-script.md').matchAll(/`([a-zA-Z]+)`/gu)].map(match => match[1]).filter(name => /^[a-z]+[A-Z]?[a-zA-Z]*$/u.test(name) && order.includes(name));
  for (const cue of ['play', 'finished', 'answerLink', 'proofOpen', 'numbers', 'end']) assert.ok(named.includes(cue), `the script uses cue ${cue}`);
});

test('U3: the recorder allows only console files, starts the ledger with a small environment, and publishes only its own take', async t => {
  const origin = 'http://127.0.0.1:4999';
  assert.equal(allowedRequest(`${origin}/console/?demo`, origin), true);
  assert.equal(allowedRequest(`${origin}/console/demo-recording.json`, origin), true);
  for (const url of [`${origin}/api/graphs`, `${origin}/`, 'https://example.com/console/', 'http://127.0.0.1:5000/console/', `${origin}/console/unlisted.js`]) {
    assert.equal(allowedRequest(url, origin), false, url);
  }
  assert.equal(allowedRequest(`${origin}/console/`, origin, 'POST'), false, 'only GET');
  // The list is exactly the console's files.
  const files = readdirSync(new URL('../public/console/', import.meta.url)).map(name => `/console/${name}`).filter(path => !path.endsWith('index.html'));
  assert.deepEqual([...consoleFiles].sort(), ['/console/', ...files].sort());
  const env = ledgerEnv('/tmp/x.sqlite', { PATH: 'p', NODE_OPTIONS: '--require evil', LATENT_ROOT: '/home/me', CONTEXT_LEDGER_DB: '/real.sqlite' });
  assert.deepEqual(env, { PATH: 'p', PORT: '0', CONTEXT_LEDGER_DB: '/tmp/x.sqlite' });

  const root = await mkdtemp(join(tmpdir(), 'ctm-u3-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const staging = join(root, 'staging');
  const out = join(root, 'out');
  await mkdir(staging);
  await mkdir(out);
  await writeFile(join(staging, 'abc.webm'), 'video');
  await writeFile(join(out, 'console-demo.webm'), 'an earlier take');
  await writeFile(join(out, 'other.webm'), 'someone else');
  const saved = await publishTake(staging, out, 'stamp', { play: 1 });
  assert.equal(saved, join(out, 'console-demo-stamp.webm'));
  assert.deepEqual((await readdir(out)).sort(), ['console-demo-stamp.cues.json', 'console-demo-stamp.webm', 'console-demo.webm', 'other.webm']);
  assert.equal(await readFile(join(out, 'console-demo.webm'), 'utf8'), 'an earlier take', 'nothing else is overwritten or removed');
  const empty = join(root, 'empty');
  await mkdir(empty);
  await assert.rejects(publishTake(empty, out, 'none', {}), /No video was recorded/u);
  // Review round 2: a take with the same name never overwrites, and a half-written pair is rolled back.
  await assert.rejects(publishTake(staging, out, 'stamp', { play: 2 }), /EEXIST/u);
  assert.equal(await readFile(join(out, 'console-demo-stamp.cues.json'), 'utf8'), JSON.stringify({ play: 1 }, null, 2) + '\n');
  await writeFile(join(out, 'console-demo-half.cues.json'), 'already here');
  await assert.rejects(publishTake(staging, out, 'half', {}), /EEXIST/u);
  assert.equal((await readdir(out)).includes('console-demo-half.webm'), false, 'the video this call wrote is removed');
  assert.equal(await readFile(join(out, 'console-demo-half.cues.json'), 'utf8'), 'already here');
});
