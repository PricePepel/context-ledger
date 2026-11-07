// M0 benchmark: graph context versus the Markdown transcript handoff, measured end
// to end through the real HTTP API on synthetic two-party negotiations.
// Usage: node bench/m0.mjs [--seed N] [--sizes 10,50,200,1000] [--reps N]
//                         [--append K] [--json out.json] [--markdown docs/benchmark.md]
// Limits: sizes from 2 to 9215 turns (the revised packet must fit the v2 schema's 100
// nodes), import bodies up to 8 MiB, seeds from 0 to 4294967295.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { constants, cpus, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { handoffMarkdown } from '../src/handoff.mjs';
import { renderMarkdown } from './report.mjs';
import { deriveSeed, factCount, generateParty, packetFor, prng, shuffledPacket } from './synth.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
export const defaults = { seed: 42, sizes: [10, 50, 200, 1000], reps: 20, append: 10 };

// Prices from the cycle 5 research brief, seen 2026-11-07. Illustration only.
export const prices = [
  { model: 'Claude Opus 5.5', input: 4, cacheHit: 0.2, output: 20, verified: true, source: 'https://platform.claude.com/docs/en/about-claude/pricing' },
  { model: 'Claude Sonnet 5.5', input: 2, cacheHit: 0.1, output: 10, verified: true, source: 'https://platform.claude.com/docs/en/about-claude/pricing' },
  { model: 'GPT-5.5', input: 5, cacheHit: 0.5, output: 30, verified: false, source: 'https://www.llmreference.com/model/gpt-5.5/openai-api (aggregator)' },
];
export const pricesSeen = '2026-11-07';
const cacheMinimumTokens = 1024;
// Server and schema limits the benchmark must stay inside (src/server.mjs, schemas/semantic-graph-v2.schema.json).
export const limits = { maxNodes: 100, maxRequestBytes: 8 * 1024 * 1024, minSize: 2, maxSeed: 0xffffffff };
// factCount(size) planted facts plus the appended action must fit in maxNodes.
export const maxSize = (limits.maxNodes - 4) ** 2 - 1;
export const handledSignals = ['SIGINT', 'SIGTERM', 'SIGHUP'];

const estimateTokens = text => Math.ceil(text.length / 4);

// ---------------------------------------------------------------- server harness

async function startServer(database, onSpawn) {
  const child = spawn(process.execPath, [join(root, 'src/server.mjs')], {
    cwd: root,
    env: { ...process.env, PORT: '0', CONTEXT_LEDGER_DB: database },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  onSpawn(child);
  let output = '';
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server did not start within 10 s.')), 10_000);
    const onData = chunk => {
      output += chunk;
      const match = output.match(/listening at (http:\/\/127\.0\.0\.1:\d+)/u);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    };
    child.stdout.setEncoding('utf8').on('data', onData);
    child.stderr.setEncoding('utf8').on('data', onData);
    child.once('exit', code => {
      clearTimeout(timer);
      reject(new Error(`Server exited early with code ${code}.`));
    });
  }).catch(error => {
    child.kill();
    throw error;
  });
  return { child, base };
}

async function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM');
  await exited;
}

function client(base) {
  return async function api(method, path, body) {
    const headers = { origin: base };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok) throw new Error(`${method} ${path} failed with ${response.status}: ${data.error}`);
    return data;
  };
}

// ---------------------------------------------------------------- measurements

function commonPrefixBytes(a, b) {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index += 1;
  return index;
}

const ratio = (part, whole) => (whole ? Math.round((part / whole) * 1000) / 1000 : 0);

const idPlaceholder = '<id>';

/** Replace volatile IDs (session and graph hashes) with a fixed placeholder. */
function withIdsHeldConstant(text, ids) {
  let result = text;
  for (const id of ids) if (id) result = result.split(id).join(idPlaceholder);
  return result;
}

/**
 * Longest common prefix of `before` and `after`, reported in the units of the API meter
 * (UTF-16 code units of the original `after` text, estimated tokens = ceil(chars / 4)), so
 * prefix and total can be compared and priced together.
 *
 * With `ids`, both texts are compared with every ID replaced by one placeholder, but the
 * prefix and the share are mapped back to the original `after` text: each placeholder
 * inside the matching prefix counts as the full ID it replaced. The share therefore has
 * the same denominator as the as-is share.
 */
export function prefixStability(before, after, ids) {
  const left = ids ? withIdsHeldConstant(before, ids) : before;
  const right = ids ? withIdsHeldConstant(after, ids) : after;
  const bytes = commonPrefixBytes(left, right);
  // Back to characters, dropping a code point the byte prefix may have cut in half.
  const prefix = Buffer.from(right, 'utf8').subarray(0, bytes).toString('utf8').replace(/\uFFFD$/u, '');
  let chars = prefix.length;
  if (ids) {
    const lengths = new Set(ids.filter(Boolean).map(id => id.length));
    if (lengths.size !== 1) throw new Error('IDs held constant must all have one length.');
    const [idLength] = lengths;
    const placeholders = prefix.split(idPlaceholder).length - 1;
    chars += placeholders * (idLength - idPlaceholder.length);
  }
  const total = after.length;
  chars = Math.min(chars, total);
  const tokens = Math.ceil(chars / 4);
  return { prefixChars: chars, newChars: total, share: ratio(chars, total), prefixTokensEstimate: tokens, cacheEligible: tokens >= cacheMinimumTokens };
}

/** Shares of characters that usually tokenize densely, to show which way chars/4 may err. */
function contentMix(text) {
  const characters = [...text];
  const count = pattern => characters.filter(character => pattern.test(character)).length;
  return {
    punctuationShare: ratio(count(/[\p{P}\p{S}]/u), characters.length),
    digitShare: ratio(count(/\p{Nd}/u), characters.length),
    nonAsciiShare: ratio(count(/[^\p{ASCII}]/u), characters.length),
  };
}

function contextRecall(text, facts) {
  const lines = text.split('\n');
  const found = facts.filter(fact => lines.some(line => line.startsWith(`- ${fact.id}`)
    && line.includes(`: ${fact.label} (`)
    && line.slice(line.lastIndexOf('(')).split(/[ ()]/u).includes(`L${fact.line}`)));
  return { planted: facts.length, found: found.length, recall: ratio(found.length, facts.length) };
}

function handoffRecall(markdown, facts) {
  const sections = new Map();
  let current;
  for (const line of markdown.split('\n')) {
    const header = line.match(/^## (?:user|assistant) \u00b7 line (\d+)$/u);
    if (header) {
      current = Number(header[1]);
      sections.set(current, []);
    } else if (current !== undefined) {
      sections.get(current).push(line);
    }
  }
  const found = facts.filter(fact => sections.get(fact.line)?.join('\n').includes(fact.label));
  return { planted: facts.length, found: found.length, recall: ratio(found.length, facts.length) };
}

function linkRecall(text, links, otherParty) {
  const found = links.filter(link => text.includes(`- ${link.from} ${link.type} ${otherParty}:${link.to}\n`));
  return { planted: links.length, found: found.length, recall: ratio(found.length, links.length) };
}

function percentile(samples, p) {
  const sorted = [...samples].sort((a, b) => a - b);
  return Math.round(sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] * 100) / 100;
}

async function timed(reps, call) {
  const samples = [];
  for (let rep = 0; rep < reps; rep += 1) {
    const start = performance.now();
    await call();
    samples.push(performance.now() - start);
  }
  return { p50: percentile(samples, 0.5), p95: percentile(samples, 0.95), reps };
}

/**
 * Input cost per 1,000 handoffs. Uncached prices the base output. Steady state prices
 * the next request, the revised output, with its cache-eligible stable prefix at the
 * cache-hit rate and the rest at the base rate. Prefix and total share one unit
 * (estimated tokens from UTF-16 characters), and the prefix never exceeds the total.
 */
export function costs({ handoffTokens, graphTokens, revisedHandoffTokens, revisedGraphTokens, graphPrefixTokens, handoffPrefixTokens }) {
  const perThousand = (tokens, price) => Math.round(tokens * price) / 1000; // tokens * $/MTok * 1000 calls / 1e6
  const steady = (total, prefix, price) => {
    const cachedTokens = prefix >= cacheMinimumTokens ? Math.min(prefix, total) : 0;
    return Math.round(cachedTokens * price.cacheHit + (total - cachedTokens) * price.input) / 1000;
  };
  return prices.map(price => ({
    model: price.model,
    verified: price.verified,
    handoffUncached: perThousand(handoffTokens, price.input),
    graphUncached: perThousand(graphTokens, price.input),
    graphSteadyState: steady(revisedGraphTokens, graphPrefixTokens, price),
    handoffSteadyStateIdsConstant: steady(revisedHandoffTokens, handoffPrefixTokens, price),
  }));
}

const orderKey = packet => JSON.stringify([packet.nodes.map(node => [node.id, node.evidenceLines]), packet.edges, packet.links ?? []]);

/** Fail before any import when a size would break a server or schema limit. */
export function checkInputs({ seed, sizes, append }) {
  if (!Number.isInteger(seed) || seed < 0 || seed > limits.maxSeed) throw new RangeError(`--seed must be an integer from 0 to ${limits.maxSeed}.`);
  if (!Number.isInteger(append) || append < 1) throw new RangeError('--append must be an integer of at least 1.');
  if (!Array.isArray(sizes) || sizes.length === 0) throw new RangeError('--sizes needs at least one size.');
  for (const size of sizes) {
    if (!Number.isInteger(size) || size < limits.minSize || size > maxSize) {
      throw new RangeError(`--sizes ${size} is out of range: sizes run from ${limits.minSize} to ${maxSize} turns, `
        + `because the revised packet (about sqrt(turns) + 5 nodes) must fit the v2 schema limit of ${limits.maxNodes} nodes.`);
    }
    for (const key of ['a', 'b']) {
      const generated = generateParty(key, size, seed, append);
      const body = JSON.stringify({ provider: generated.party.provider, source: generated.party.source, transcript: generated.extended });
      if (Buffer.byteLength(body, 'utf8') > limits.maxRequestBytes) {
        throw new RangeError(`--sizes ${size} makes an import body larger than the server's 8 MiB request limit.`);
      }
    }
  }
}

// ---------------------------------------------------------------- one size

async function measureSize(api, size, { seed, reps, append, beforeSize }) {
  await beforeSize?.(size);
  const generatedA = generateParty('a', size, seed, append);
  const generatedB = generateParty('b', size, seed, append);
  const importParty = (generated, transcript) => api('POST', '/api/import', {
    provider: generated.party.provider, source: generated.party.source, transcript,
  }).then(data => data.session);

  const sessionA = await importParty(generatedA, generatedA.base);
  const sessionB = await importParty(generatedB, generatedB.base);
  const packetA = packetFor(generatedA, sessionA.id);
  const graphA = (await api('POST', '/api/graphs', packetA)).graph;
  const packetB = packetFor(generatedB, sessionB.id, { linkTo: graphA.id, otherFacts: generatedA.facts });
  const graphB = (await api('POST', '/api/graphs', packetB)).graph;
  const room = (await api('POST', '/api/rooms', { graphIds: [graphB.id, graphA.id] })).room;

  const shuffleRng = prng(deriveSeed(seed, 16 + size));
  const parties = {};
  for (const [generated, session, packet, graph] of [[generatedA, sessionA, packetA, graphA], [generatedB, sessionB, packetB, graphB]]) {
    const name = generated.party.name;
    const { context } = await api('GET', `/api/graphs/${graph.id}/context`);
    const stored = (await api('GET', `/api/sessions/${session.id}`)).session;
    const handoff = handoffMarkdown(stored);
    if (handoff.length !== context.meter.handoffCharacters) throw new Error('Handoff rendering does not match the API meter.');

    // Order invariance: a shuffled copy must be the same graph with the same bytes.
    const shuffledCopy = shuffledPacket(packet, shuffleRng);
    const reordered = (await api('POST', '/api/graphs', shuffledCopy)).graph;
    const reorderedContext = (await api('GET', `/api/graphs/${reordered.id}/context`)).context;

    // Cache-prefix stability: append turns, re-import (a new session, since session
    // IDs hash the transcript), publish a revision with one more action node.
    const appendedSession = await importParty(generated, generated.extended);
    const revisedPacket = packetFor(generated, appendedSession.id, {
      linkTo: packet.links ? graphA.id : undefined, otherFacts: generatedA.facts, extra: [generated.appended],
    });
    const revised = (await api('POST', '/api/graphs', revisedPacket)).graph;
    const revisedContext = (await api('GET', `/api/graphs/${revised.id}/context`)).context;
    const revisedHandoff = handoffMarkdown((await api('GET', `/api/sessions/${appendedSession.id}`)).session);
    const graphPrefix = prefixStability(context.text, revisedContext.text);
    const handoffPrefix = prefixStability(handoff, revisedHandoff);
    // The same comparison with session and graph IDs replaced by one placeholder on both
    // sides, so a single changed ID line does not decide the result.
    const ids = [session.id, appendedSession.id, graph.id, revised.id];
    const graphPrefixIdsConstant = prefixStability(context.text, revisedContext.text, ids);
    const handoffPrefixIdsConstant = prefixStability(handoff, revisedHandoff, ids);
    const sessionLineEnd = handoff.indexOf('\n', handoff.indexOf(`Session: ${session.id}`));

    const factsWithAppended = [...generated.facts];
    parties[name] = {
      provider: generated.party.provider,
      sessionId: session.id,
      graphId: graph.id,
      transcriptBytes: Buffer.byteLength(generated.base, 'utf8'),
      messages: stored.messageCount,
      nodes: packet.nodes.length,
      edges: packet.edges.length,
      links: packet.links?.length ?? 0,
      size: {
        handoffCharacters: context.meter.handoffCharacters,
        graphCharacters: context.meter.graphCharacters,
        characterRatio: ratio(context.meter.graphCharacters, context.meter.handoffCharacters),
        handoffTokensEstimate: context.meter.handoffTokens,
        graphTokensEstimate: context.meter.graphTokens,
        savedShare: context.meter.savedShare,
        meterMethod: context.meter.method,
      },
      contentMix: { handoff: contentMix(handoff), graph: contentMix(context.text) },
      recall: {
        graph: contextRecall(context.text, factsWithAppended),
        handoff: handoffRecall(handoff, factsWithAppended),
        ...(packet.links ? { links: linkRecall(context.text, packet.links, generatedA.party.name) } : {}),
      },
      cachePrefix: {
        appendedTurns: append,
        revisedGraphId: revised.id,
        graph: graphPrefix,
        handoff: handoffPrefix,
        handoffPrefixEndsInSessionLine: handoffPrefix.prefixChars < sessionLineEnd,
        idsHeldConstant: { graph: graphPrefixIdsConstant, handoff: handoffPrefixIdsConstant },
        revisedRecall: contextRecall(revisedContext.text, [...generated.facts, generated.appended]),
      },
      orderInvariance: {
        // Independent check that the shuffle really changed the input order.
        inputReordered: orderKey(shuffledCopy) !== orderKey(packet),
        sameGraphId: reordered.id === graph.id,
        // Implied by sameGraphId: the store keeps the first row for an ID, so this
        // re-reads the same row. Kept as an end-to-end guard, not a separate guarantee.
        identicalContext: reorderedContext.text === context.text,
      },
      costPerThousandHandoffsUsd: costs({
        handoffTokens: context.meter.handoffTokens,
        graphTokens: context.meter.graphTokens,
        revisedHandoffTokens: estimateTokens(revisedHandoff),
        revisedGraphTokens: revisedContext.meter.graphTokens,
        graphPrefixTokens: graphPrefix.prefixTokensEstimate,
        handoffPrefixTokens: handoffPrefixIdsConstant.prefixTokensEstimate,
      }),
    };
  }

  const latency = {
    publish: await timed(reps, () => api('POST', '/api/graphs', packetB)),
    context: await timed(reps, () => api('GET', `/api/graphs/${graphB.id}/context`)),
    roomOpen: await timed(reps, () => api('POST', '/api/rooms', { graphIds: [graphB.id, graphA.id] })),
  };

  return {
    size,
    factsPerParty: factCount(size),
    roomId: room.id,
    proposals: room.proposals.length,
    proposalTypes: [...new Set(room.proposals.map(proposal => proposal.type))].sort(),
    parties,
    latencyMs: latency,
  };
}

// ---------------------------------------------------------------- run

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

/** HEAD plus whether files that shape the numbers have uncommitted changes. */
function gitState() {
  try {
    const commit = git(['rev-parse', '--short=12', 'HEAD']);
    const dirty = git(['status', '--porcelain', '--', 'bench', 'src', 'schemas', 'package.json']) !== '';
    return { commit, dirty };
  } catch {
    return { commit: 'unknown', dirty: true };
  }
}

/**
 * Run the benchmark. Returns the report, its Markdown rendering and the harness
 * details (temp directory and server PID) so tests can check the cleanup.
 */
export async function runBenchmark(options = {}) {
  const { seed, sizes, reps, append, beforeSize, log } = { ...defaults, ...options };
  checkInputs({ seed, sizes, append });
  const tempDir = mkdtempSync(join(tmpdir(), 'context-ledger-bench-'));
  const database = join(tempDir, 'bench.sqlite');
  const harness = { tempDir, serverPid: undefined };
  let child;
  let server;
  // A signal ends the run: kill the server, delete the temp database, write nothing
  // and exit with 128 + signal number, as the shell would.
  let interrupted = false;
  const onSignal = signal => {
    if (interrupted) return;
    interrupted = true;
    const finish = () => {
      rmSync(tempDir, { recursive: true, force: true });
      process.stderr.write(`bench: interrupted by ${signal}; server stopped, temp database removed, no report written.\n`);
      process.exit(128 + constants.signals[signal]);
    };
    if (!child || child.exitCode !== null || child.signalCode !== null) return finish();
    // Wait for the exit so this process reaps the child, with a short fallback.
    child.once('exit', finish);
    setTimeout(finish, 2000);
    child.kill('SIGKILL');
  };
  for (const signal of handledSignals) process.on(signal, onSignal);
  log?.(`bench: temp directory ${tempDir}`);
  try {
    server = await startServer(database, spawned => {
      child = spawned;
      harness.serverPid = spawned.pid;
    });
    log?.(`bench: server pid ${server.child.pid} at ${server.base}`);
    const api = client(server.base);
    const results = [];
    for (const size of sizes) results.push(await measureSize(api, size, { seed, reps, append, beforeSize }));
    const git = gitState();
    const report = {
      benchmark: 'context-ledger M0',
      seed,
      sizes,
      reps,
      appendTurns: append,
      command: `node bench/m0.mjs --seed ${seed} --sizes ${sizes.join(',')} --reps ${reps} --append ${append}`,
      machine: { node: process.version, platform: `${process.platform} ${process.arch}`, cpu: cpus()[0]?.model ?? 'unknown', cpus: cpus().length },
      gitCommit: git.commit,
      gitDirty: git.dirty,
      date: new Date().toISOString().slice(0, 10),
      tokenEstimate: 'ceil(UTF-16 code units / 4); an estimate, not a tokenizer count',
      cacheMinimumTokens,
      prices: { seen: pricesSeen, models: prices },
      results,
    };
    return { report, markdown: renderMarkdown(report), harness };
  } catch (error) {
    error.harness = harness;
    throw error;
  } finally {
    await stopServer(child);
    rmSync(tempDir, { recursive: true, force: true });
    for (const signal of handledSignals) process.removeListener(signal, onSignal);
  }
}

/** The report without fields that legitimately differ between runs. */
export function deterministicPart(report) {
  const { machine: _machine, gitCommit: _commit, gitDirty: _dirty, date: _date, ...rest } = report;
  return { ...rest, results: rest.results.map(({ latencyMs: _latency, ...result }) => result) };
}

async function main() {
  const { values } = parseArgs({
    options: {
      seed: { type: 'string' }, sizes: { type: 'string' }, reps: { type: 'string' },
      append: { type: 'string' }, json: { type: 'string' }, markdown: { type: 'string' },
    },
  });
  const integer = (value, name, minimum) => {
    const number = Number(value);
    if (!Number.isInteger(number) || number < minimum) throw new Error(`--${name} must be an integer of at least ${minimum}.`);
    return number;
  };
  const options = {
    seed: values.seed === undefined ? defaults.seed : integer(values.seed, 'seed', 0),
    sizes: values.sizes === undefined ? defaults.sizes : values.sizes.split(',').map(size => integer(size, 'sizes', 2)),
    reps: values.reps === undefined ? defaults.reps : integer(values.reps, 'reps', 1),
    append: values.append === undefined ? defaults.append : integer(values.append, 'append', 1),
  };
  const { report, markdown } = await runBenchmark({ ...options, log: message => console.error(message) });
  if (values.json) writeFileSync(values.json, JSON.stringify(report, null, 2) + '\n');
  if (values.markdown) writeFileSync(values.markdown, markdown);
  for (const result of report.results) {
    const teo = result.parties.teo;
    console.log(`size ${result.size}: handoff ${teo.size.handoffCharacters} chars, graph ${teo.size.graphCharacters} chars, `
      + `saved ${teo.size.savedShare} (est.), recall ${teo.recall.graph.recall}/${teo.recall.handoff.recall}, `
      + `prefix graph ${teo.cachePrefix.graph.share} vs handoff ${teo.cachePrefix.handoff.share} as is, `
      + `${teo.cachePrefix.idsHeldConstant.graph.share} vs ${teo.cachePrefix.idsHeldConstant.handoff.share} with IDs constant, `
      + `context p50 ${result.latencyMs.context.p50} ms`);
  }
  if (!values.json && !values.markdown) console.log('Add --json <file> or --markdown <file> to save the full report.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
