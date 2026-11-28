import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildRecording, recordingText } from '../demo/console-recording.mjs';
import { createModel, evidenceTurns, nodeMark, partyKey, turnSpeaker, visibleText } from '../public/console/model.mjs';
import { ROLES, accessoryPixels, roleOf, spriteKey, spritePixels } from '../public/console/sprites.mjs';
import { DESKS, LOUNGE, WORK_AREA, besideDesk, loungeSpot, seatAt } from '../public/console/office-furniture.mjs';
import { spotFor } from '../public/console/office.mjs';
import { visibleText as serverVisibleText } from '../src/text.mjs';
import { bearer, ledgerToken } from './ledger-auth.mjs';

// Card U1: the console's demo recording, its state model and how the server serves it.
// Synthetic data only: the recording is built from the committed Orbit demo transcripts.
const consoleDir = new URL('../public/console/', import.meta.url);
const recording = JSON.parse(await readFile(new URL('demo-recording.json', consoleDir), 'utf8'));

function play(events, { workingMs = 8000 } = {}) {
  const model = createModel({ workingMs });
  const start = Date.now();
  const moves = events.map(event => model.apply({
    summary: event.summary,
    graph: event.graph,
    meter: event.meter,
    provider: recording.sessions[event.graph.packet.sessionId].provider,
    at: start + event.atMs,
  }));
  return { model, moves, start };
}

test('the committed demo recording is what the real store produces from the demo transcripts', async () => {
  const rebuilt = recordingText(await buildRecording());
  // A Windows checkout with core.autocrlf has CR LF line ends; the content is what counts.
  const crlf = String.fromCodePoint(13, 10);
  const committed = (await readFile(new URL('demo-recording.json', consoleDir), 'utf8')).replaceAll(crlf, '\n');
  assert.equal(committed, rebuilt,
    'Run node demo/console-recording.mjs and commit the result.');
  const providers = Object.values(recording.sessions).map(session => session.provider).sort();
  assert.deepEqual(providers, ['claude', 'codex']);
  assert.ok(recording.events.every((event, index) => index === 0 || event.atMs > recording.events[index - 1].atMs));
  assert.ok(recording.events.at(-1).atMs < recording.durationMs);
});

test('a publish moves only what changed: new nodes, changed nodes and linked nodes', () => {
  const { moves } = play(recording.events);
  assert.deepEqual(moves[0].added, ['party:leo/orbit-live', 'party:leo/port-4400']);
  assert.deepEqual(moves[1].added.sort(), ['party:leo/mcp-pairing', 'party:leo/record-video']);
  assert.deepEqual(moves[1].changed, []);
  // Ali's second graph links to two of Leo's nodes: the dashed read lines.
  assert.deepEqual(moves[4].read.sort(), ['party:leo/mcp-pairing', 'party:leo/orbit-live']);
  // Leo's last graph moves the recording to Saturday and adds the question for Ali.
  assert.deepEqual(moves[5].changed, ['party:leo/record-video']);
  assert.deepEqual(moves[5].added, ['party:leo/gpu-owner']);
  assert.deepEqual(moves[5].read, ['party:ali/which-port']);
  // Replaying a graph already seen moves nothing.
  const { model } = play(recording.events);
  const again = model.apply({ ...recording.events[5], provider: 'claude', at: Date.now() + 99_000 });
  assert.deepEqual([again.added, again.changed, again.read], [[], [], []]);
});

test('the finished demo numbers match values computed from the recording', () => {
  const { model, start } = play(recording.events);
  const last = new Map();
  for (const event of recording.events) last.set(partyKey(event.graph.packet), event);
  const tokens = [...last.values()].reduce((sum, event) => sum + event.meter.savedTokens, 0);
  let superseded = 0;
  for (const { graph } of last.values()) {
    const replaced = new Set(graph.packet.edges.filter(edge => edge.type === 'supersedes').map(edge => edge.to));
    superseded += graph.packet.nodes.filter(node => node.kind === 'decision' && replaced.has(node.id)).length;
  }
  const numbers = model.numbers(start + recording.durationMs);
  assert.equal(numbers.handoffs, recording.events.length);
  assert.equal(numbers.tokensSaved, tokens);
  assert.equal(numbers.metered, 2);
  assert.equal(numbers.superseded, superseded);
  assert.equal(superseded, 1);
  // A graph from yesterday is not a hand-off today.
  const yesterday = createModel();
  yesterday.apply({ ...recording.events[0], provider: 'claude', at: Date.now() - 2 * 86_400_000 });
  assert.equal(yesterday.numbers(Date.now()).handoffs, 0);
  assert.equal(yesterday.numbers(Date.now()).tokensSaved, 0);
});

test('agents are working right after a publish, waiting on an unanswered question, idle otherwise', () => {
  const { model, start } = play(recording.events.slice(0, 5));
  const at = ms => Object.fromEntries(model.agents(start + ms).map(agent => [agent.label, agent.state]));
  // Ali published at 20 s and has asked Leo which port; Leo has not answered yet.
  assert.deepEqual(at(24_000), { leo: 'idle', ali: 'working' });
  assert.deepEqual(at(30_000), { leo: 'idle', ali: 'waiting' });
  const full = play(recording.events);
  const end = Object.fromEntries(full.model.agents(full.start + recording.durationMs).map(agent => [agent.label, agent.state]));
  // Leo's last graph answers Ali by link and asks Ali who owns the GPU box.
  assert.deepEqual(end, { leo: 'waiting', ali: 'idle' });
  assert.deepEqual(full.model.agents(0).map(agent => agent.provider).sort(), ['claude', 'codex']);
});

test('the graph view marks superseded decisions and answered questions, and reads the G7 mark from the graph\'s lists', () => {
  const { model } = play(recording.events);
  const { columns, edges } = model.graph();
  assert.deepEqual(columns.map(column => column.label), ['leo', 'ali']);
  const nodes = new Map(columns.flatMap(column => column.nodes).map(node => [node.key, node]));
  assert.equal(nodes.get('party:leo/port-4400').superseded, true);
  assert.equal(nodes.get('party:leo/port-4317').superseded, false);
  assert.equal(nodes.get('party:ali/which-port').answered, true);
  assert.equal(nodes.get('party:leo/gpu-owner').answered, false);
  // The rebuilt recording carries G7 marks: every demo node cites its own words.
  assert.ok([...nodes.values()].every(node => node.mark === 'quoted'));
  assert.ok(edges.some(edge => edge.link && edge.from === 'party:ali/benchmark' && edge.to === 'party:leo/mcp-pairing'));
  const graph = { quotedNodeIds: ['a'], inferredNodeIds: ['b'] };
  assert.equal(nodeMark(graph, 'a'), 'quoted');
  assert.equal(nodeMark(graph, 'b'), 'inferred');
  assert.equal(nodeMark(graph, 'c'), null);
  // A graph published before G7 has no lists: unmarked, never inferred. A mark on the
  // node itself is not the ledger's and is ignored.
  assert.equal(nodeMark({}, 'a'), null);
  assert.equal(nodeMark({ quotedNodeIds: null }, 'constructor'), null);
});

test('card U4: a graph published before G7 shows its nodes unmarked', () => {
  const model = createModel();
  const graph = { id: 'g-old', packet: { version: 2, sessionId: 's1', party: 'old', nodes: [{ id: 'n', kind: 'decision', label: 'Old', evidenceLines: [1], grounding: 'inferred' }], edges: [] } };
  model.apply({ summary: { id: 'g-old' }, graph, provider: 'codex', at: Date.now() });
  assert.equal(model.graph().columns[0].nodes[0].mark, null);
});

test('card U4: an I3 agent turn says who sent it to whom, with its paths escaped on one line', () => {
  assert.equal(turnSpeaker({ role: 'agent', author: '/root/worker', recipient: '/root' }), 'Agent /root/worker to /root');
  const odd = turnSpeaker({ role: 'agent', author: `/root${String.fromCodePoint(0x202e)}x`, recipient: '/a\n/b' });
  assert.equal(odd, 'Agent /root\\u202ex to /a\\u000a/b');
  assert.equal(turnSpeaker({ role: 'agent' }), 'Agent unknown to unknown');
  assert.equal(turnSpeaker({ role: 'user' }), 'Person');
  assert.equal(turnSpeaker({ role: 'assistant' }), 'Agent');
});

test('card U4: each source has its pixel sprite on the 16 x 20 grid, and others get the bot', () => {
  assert.equal(spriteKey('claude'), 'claude');
  assert.equal(spriteKey('codex'), 'codex');
  for (const other of ['aider', 'constructor', '__proto__', undefined]) assert.equal(spriteKey(other), 'bot');
  for (const key of ['claude', 'codex', 'bot']) {
    const pixels = spritePixels(key);
    assert.ok(pixels.length > 5, key);
    for (const [x, y, width, height, fill] of pixels) {
      assert.ok(x >= 0 && y >= 0 && width > 0 && height > 0 && x + width <= 16 && y + height <= 20, `${key} ${x},${y}`);
      assert.match(fill, /^#[0-9a-f]{6}$/iu);
    }
  }
  assert.notDeepEqual(spritePixels('claude'), spritePixels('codex'));
});

const inside = ([x, y], [left, top, right, bottom], half = 16) => x - half >= left && x + half <= right && y <= bottom && y - 40 >= top;

test('card U4b: a working agent sits behind its own desk, one desk per seat', () => {
  const seats = Array.from({ length: DESKS }, (_, i) => seatAt(i));
  assert.equal(new Set(seats.map(String)).size, DESKS);
  assert.deepEqual(seats, [[52, 114], [140, 114], [228, 114], [52, 220], [140, 220], [228, 220]]);
  // The desk top starts 14 units above the feet, so the desk hides the legs and the face shows.
  for (const seat of seats) assert.ok(inside(seat, WORK_AREA), String(seat));
  assert.deepEqual(spotFor('working', 4, 0), seatAt(4));
});

test('card U4b: a waiting agent stands beside its desk, clear of the next desk and inside the work area', () => {
  for (let i = 0; i < DESKS; i += 1) {
    const [x, y] = besideDesk(i);
    const [seatX, seatY] = seatAt(i);
    assert.equal(y, seatY + 11);
    // Desks are 56 wide on an 88-unit pitch: a 32-wide sprite at +46 clears this desk and the next.
    assert.ok(x - 16 >= seatX + 28 - 2 && x + 16 <= seatX + 88 - 28 + 2, `desk ${i}`);
    assert.ok(inside([x, y], WORK_AREA), `desk ${i}`);
  }
  assert.deepEqual(spotFor('waiting', 2, 0), besideDesk(2));
});

test('card U4b: idle agents stand in the lounge, each on their own spot', () => {
  const spots = Array.from({ length: DESKS }, (_, j) => loungeSpot(j));
  assert.equal(new Set(spots.map(String)).size, DESKS);
  for (const spot of spots) assert.ok(inside(spot, LOUNGE), String(spot));
  assert.deepEqual(spotFor('idle', 5, 1), loungeSpot(1));
});

test('card U4b: role words pick an accessory, and an unknown label gets none', () => {
  const cases = { 'planner': 'planner', 'code-review': 'reviewer', 'qa-tests': 'tester', 'refactor': 'builder', 'docs': 'writer', 'triage': 'scout', 'Leo': '', '': '', 'constructor': '', '__proto__': '',
    // Whole words only (review of U4b): provider names and words that merely contain a role word.
    'codex': '', 'claude-code': '', 'inspector': '', 'docker': '', 'prefix': '', 'device': '', 'Codex reviewer': 'reviewer' };
  for (const [label, role] of Object.entries(cases)) assert.equal(roleOf(label), role, label);
  assert.equal(roleOf(undefined), '');
  for (const provider of ['claude', 'codex', 'bot']) {
    assert.deepEqual(accessoryPixels(provider, ''), []);
    assert.deepEqual(accessoryPixels(provider, 'constructor'), []);
    for (const role of ROLES) {
      const pixels = accessoryPixels(provider, role);
      assert.ok(pixels.length > 0, `${provider} ${role}`);
      // A hat may rise above the 16 x 20 grid; nothing reaches further than the room allows.
      for (const [x, y, width, height, fill] of pixels) {
        assert.ok(x >= -2 && y >= -4 && x + width <= 18 && y + height <= 20 && width > 0 && height > 0, `${provider} ${role} ${x},${y}`);
        assert.match(fill, /^#[0-9a-f]{6}$/iu);
      }
    }
  }
});

test('card U4: every brand variable the console uses is defined in docs/brand/tokens.css', async () => {
  const tokens = await readFile(new URL('../docs/brand/tokens.css', import.meta.url), 'utf8');
  const defined = new Set([...tokens.matchAll(/(--ctm-[\w-]+)\s*:/gu)].map(match => match[1]));
  for (const name of ['console.css', 'office.css']) {
    const css = await readFile(new URL(name, consoleDir), 'utf8');
    const used = [...css.matchAll(/var\((--ctm-[\w-]+)\)/gu)].map(match => match[1]);
    assert.ok(used.length > 10, name);
    for (const variable of used) assert.ok(defined.has(variable), `${name} uses ${variable}, which tokens.css does not define`);
  }
  // Every custom property the console CSS reads is defined in the console CSS or the tokens:
  // an undefined one silently draws nothing (the desk legs lost their stroke this way).
  const allCss = tokens + (await Promise.all(['console.css', 'office.css'].map(name => readFile(new URL(name, consoleDir), 'utf8')))).join('');
  const declared = new Set([...allCss.matchAll(/(--[\w-]+)\s*:/gu)].map(match => match[1]));
  for (const [, variable] of allCss.matchAll(/var\((--[\w-]+)\)/gu)) assert.ok(declared.has(variable), `${variable} is used but never defined`);
  // Colours come from the tokens; the only literals left are the two sprite colours of the office rooms.
  const console = await readFile(new URL('console.css', consoleDir), 'utf8');
  assert.deepEqual(console.match(/#[0-9a-f]{3,8}\b/giu), null);
  const office = await readFile(new URL('office.css', consoleDir), 'utf8');
  assert.deepEqual(office.match(/#[0-9a-f]{3,8}\b/giu), ['#d77757', '#9a4615']);
});

test('evidence shows each cited turn with the turns around it, in order', () => {
  const messages = [1, 2, 3, 4, 5, 6].map(line => ({ role: line % 2 ? 'user' : 'assistant', text: `t${line}`, line: line * 2 }));
  assert.deepEqual(evidenceTurns(messages, [6]).map(turn => [turn.line, turn.cited]), [[4, false], [6, true], [8, false]]);
  assert.deepEqual(evidenceTurns(messages, [2, 12]).map(turn => turn.line), [2, 4, 10, 12]);
  assert.deepEqual(evidenceTurns(messages, [99]), []);
  const rlo = String.fromCodePoint(0x202e);
  const spoof = [{ role: 'user', text: `pay ${rlo}evil`, line: 1 }];
  assert.equal(evidenceTurns(spoof, [1])[0].text, `pay ${String.fromCodePoint(0x5c)}u202eevil`);
});

test('the console shows hidden characters exactly as the CLI and handoff do', () => {
  const c = String.fromCodePoint;
  const samples = ['plain', `tab${c(9)}and${c(10)}line`, `crlf${c(13, 10)}end`, `bell${c(7)}`, `del${c(0x7f)}`, `c1${c(0x85)}`,
    `rlo${c(0x202e)} x`, `lri${c(0x2066)}`, `zw${c(0x200b)}`, `zwj${c(0x200d)} ok`, `zwnj${c(0x200c)} ok`,
    `ls${c(0x2028)}ps${c(0x2029)}`, `tag${c(0xe0041)}`, `bom${c(0xfeff)}`];
  for (const sample of samples) assert.equal(visibleText(sample), serverVisibleText(sample), JSON.stringify(sample));
});

test('console files stay light and never parse transcript text as HTML', async () => {
  let total = 0;
  for (const name of await readdir(consoleDir)) {
    const text = await readFile(new URL(name, consoleDir), 'utf8');
    total += (await stat(new URL(name, consoleDir))).size;
    // Card H12: raw control and format characters are scripts/check.mjs's rule, for every
    // tracked file; this test keeps what only the console needs.
    if (name.endsWith('.mjs')) {
      assert.doesNotMatch(text, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/u, name);
      if (name === 'swarm-room.mjs') {
        // Card U7: the one exception. Starting a swarm run is a POST to /api/swarm/runs; it
        // writes nothing to the ledger. No other write method and no other path.
        assert.doesNotMatch(text, /method:\s*['"](?:PUT|PATCH|DELETE)/iu, name);
        assert.equal([...text.matchAll(/method:\s*['"]POST['"]/giu)].length, 1, `${name} posts once`);
        // The one POST is bound to its path: the method sits in the call to /api/swarm/runs.
        assert.match(text, /api\('\/api\/swarm\/runs',\s*\{\s*method:\s*'POST'/u, `${name} posts only to /api/swarm/runs`);
        assert.deepEqual([...text.matchAll(/api\(\s*'([^']+)'/gu)].map(match => match[1]).sort(), ['/api/swarm', '/api/swarm/runs'], name);
      } else {
        assert.doesNotMatch(text, /method:\s*['"](?:POST|PUT|PATCH|DELETE)/iu, `${name} must only read`);
      }
      // Browser-only modules are not imported by node tests, so check that each parses.
      const check = spawnSync(process.execPath, ['--check', fileURLToPath(new URL(name, consoleDir))], { encoding: 'utf8' });
      assert.equal(check.status, 0, `${name}: ${check.stderr}`);
    }
  }
  assert.ok(total < 300 * 1024, `console files are ${total} bytes`);
});

function raw(port, { method = 'GET', path, headers = {} }) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, method, path, headers: { Host: `127.0.0.1:${port}`, ...headers }, agent: false }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.end();
  });
}

test('the server serves exactly the console files, read-only, with the usual headers', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ledger-console-'));
  const child = spawn(process.execPath, ['src/server.mjs'], {
    env: { ...process.env, PORT: '0', CONTEXT_LEDGER_DB: join(directory, 'ledger.sqlite') },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill();
      await once(child, 'exit');
    }
    await rm(directory, { recursive: true, force: true });
  });
  let output = '';
  let port;
  for await (const chunk of child.stdout) {
    output += chunk;
    port = Number(output.match(/listening at http:\/\/127\.0\.0\.1:(\d+)/)?.[1]);
    if (port) break;
  }

  // Card U4b: the CTM logo is served from docs/brand, and the page may load it.
  const logo = await raw(port, { path: '/console/logo.svg' });
  assert.equal(logo.status, 200);
  assert.equal(logo.headers['content-type'], 'image/svg+xml; charset=utf-8');
  assert.equal(logo.body, await readFile(new URL('../docs/brand/ctm-logo.svg', import.meta.url), 'utf8'));
  assert.match(logo.headers['content-security-policy'], /img-src 'self'/u);
  // Card U6: the three fonts come from docs/brand/fonts, and the CSP lets the page use them.
  for (const name of ['jersey-15', 'inter-tight', 'silkscreen']) {
    const font = await raw(port, { path: `/console/fonts/${name}.woff2` });
    assert.equal(font.status, 200, name);
    assert.equal(font.headers['content-type'], 'font/woff2', name);
    assert.match(font.headers['content-security-policy'], /font-src 'self'/u);
  }

  // Card U4: the brand tokens are served from their one source, docs/brand/tokens.css.
  const tokens = await raw(port, { path: '/console/tokens.css' });
  assert.equal(tokens.status, 200);
  assert.equal(tokens.headers['content-type'], 'text/css; charset=utf-8');
  assert.equal(tokens.body, await readFile(new URL('../docs/brand/tokens.css', import.meta.url), 'utf8'));

  const files = await readdir(consoleDir);
  const types = { '.html': 'text/html', '.css': 'text/css', '.mjs': 'text/javascript', '.json': 'application/json' };
  for (const name of files) {
    const path = name === 'index.html' ? '/console/' : `/console/${name}`;
    const response = await raw(port, { path });
    assert.equal(response.status, 200, path);
    assert.equal(response.headers['content-type'], `${types[name.slice(name.lastIndexOf('.'))]}; charset=utf-8`, path);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.match(response.headers['content-security-policy'], /script-src 'self'/u);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.body, await readFile(new URL(name, consoleDir), 'utf8'), path);
    assert.equal((await raw(port, { method: 'POST', path })).status, 404, `POST ${path}`);
  }
  assert.equal((await raw(port, { path: '/console' })).status, 200);
  // P1e: only the listed files are open; any other path needs the token, and then is 404.
  const auth = bearer(await ledgerToken(join(directory, 'ledger.sqlite'), port));
  for (const path of ['/console/fonts/OFL-silkscreen.txt', '/console/fonts/', '/console/pip.svg', '/console/brand.md', '/console/../docs/brand/tokens.css', '/docs/brand/tokens.css', '/console/index.html', '/console/nope.mjs', '/console/console.mjs/', '/console/%2e%2e/src/server.mjs', '/public/console/console.mjs']) {
    assert.equal((await raw(port, { path })).status, 401, path);
    assert.equal((await raw(port, { path, headers: auth })).status, 404, path);
  }
});

test('card U6: every Mark bot has its official mark and brand colour, on the grid and with room for role props', async () => {
  const { MARKS } = await import('../public/console/agent-marks.mjs');
  const { spriteMark } = await import('../public/console/sprites.mjs');
  const { bandCrew, BAND_W } = await import('../public/console/ctm-band.mjs');
  assert.deepEqual(Object.keys(MARKS), ['cursor', 'opencode', 'gemini', 'copilot', 'windsurf', 'kimi', 'deepseek', 'qwen', 'mistral', 'cline', 'warp', 'zed', 'minimax', 'ollama']);
  for (const [key, mark] of Object.entries(MARKS)) {
    assert.equal(spriteKey(key), key);
    assert.match(mark.hex, /^#[0-9A-F]{6}$/u, key);
    assert.match(mark.source, /^https:\/\//u, key);
    assert.ok(mark.paths.length > 0 && mark.paths.every(d => /^[MLHVCSQTAZmlhvcsqtaz0-9.,\s-]+$/u.test(d)), `${key} path data`);
    for (const [x, y, width, height, fill] of spritePixels(key)) {
      assert.ok(x >= 0 && y >= 0 && x + width <= 16 && y + height <= 20, `${key} ${x},${y}`);
      assert.match(fill, /^#[0-9a-f]{6}$/iu);
    }
    const face = spriteMark(key);
    assert.ok(face.x >= 3 && face.y >= 1 && face.x + 24 * face.scale <= 13 && face.y + 24 * face.scale <= 11, `${key} mark stays on the screen`);
    for (const role of ROLES) assert.ok(accessoryPixels(key, role).length > 0, `${key} ${role}`);
  }
  assert.equal(spriteMark('claude'), null);
  assert.equal(spriteMark('codex'), null);
  assert.equal(spriteMark('aider'), null);

  const crew = bandCrew();
  assert.equal(crew.length, 6 + Object.keys(MARKS).length);
  for (const member of crew) assert.ok(member.x - 8 * member.scale >= 0 && member.x + 8 * member.scale <= BAND_W, `${member.provider} on the band`);
  const spots = crew.map(member => Math.round(member.x));
  assert.equal(new Set(spots).size, spots.length, 'no two crew members stand in one spot');
});

test('card U6: the console fonts are local OFL files, and the CSS asks for no other host', async () => {
  for (const name of ['jersey-15', 'inter-tight', 'silkscreen']) {
    const bytes = await readFile(new URL(`../docs/brand/fonts/${name}.woff2`, import.meta.url));
    assert.equal(bytes.subarray(0, 4).toString('latin1'), 'wOF2', name);
  }
  for (const name of ['OFL-jersey15.txt', 'OFL-intertight.txt', 'OFL-silkscreen.txt']) {
    assert.match(await readFile(new URL(`../docs/brand/fonts/${name}`, import.meta.url), 'utf8'), /SIL Open Font License/u, name);
  }
  const css = await readFile(new URL('console.css', consoleDir), 'utf8');
  for (const url of css.matchAll(/url\("([^"]+)"\)/gu)) assert.match(url[1], /^\/console\/fonts\/[a-z0-9-]+\.woff2$/u);
  assert.doesNotMatch(await readFile(new URL('index.html', consoleDir), 'utf8'), /https?:\/\//u);
});
