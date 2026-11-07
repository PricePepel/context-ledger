// M0 benchmark: graph context versus the Markdown transcript handoff, measured end
// to end through the real HTTP API on synthetic two-party negotiations.
// Usage: node bench/m0.mjs [--seed N] [--sizes 10,50,200,1000] [--reps N]
//                         [--append K] [--json out.json] [--markdown docs/benchmark.md]
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { handoffMarkdown } from '../src/handoff.mjs';
import { renderMarkdown } from './report.mjs';
import { factCount, generateParty, packetFor, prng, shuffledPacket } from './synth.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
export const defaults = { seed: 42, sizes: [10, 50, 200, 1000], reps: 20, append: 10 };

// Prices from the cycle 5 research brief, seen 2026-11-07. Illustration only.
export const prices = [
  { model: 'Claude Opus 5.5', input: 4, cacheHit: 0.2, verified: true, source: 'https://platform.claude.com/docs/en/about-claude/pricing' },
  { model: 'Claude Sonnet 5.5', input: 2, cacheHit: 0.1, verified: true, source: 'https://platform.claude.com/docs/en/about-claude/pricing' },
  { model: 'GPT-5.5', input: 5, cacheHit: 0.5, verified: false, source: 'https://www.llmreference.com/model/gpt-5.5/openai-api (aggregator)' },
];
export const pricesSeen = '2026-11-07';
const cacheMinimumTokens = 1024;

const estimateTokens = text => Math.ceil(text.length / 4);

// ---------------------------------------------------------------- server harness

async function startServer(database) {
  const child = spawn(process.execPath, [join(root, 'src/server.mjs')], {
    cwd: root,
    env: { ...process.env, PORT: '0', CONTEXT_LEDGER_DB: database },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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

function prefixStability(before, after) {
  const bytes = commonPrefixBytes(before, after);
  const total = Buffer.byteLength(after, 'utf8');
  const tokens = Math.ceil(bytes / 4);
  return { prefixBytes: bytes, newBytes: total, share: ratio(bytes, total), prefixTokensEstimate: tokens, cacheEligible: tokens >= cacheMinimumTokens };
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

function costs(handoffTokens, graphTokens, prefixTokens) {
  const cachedPrefix = prefixTokens >= cacheMinimumTokens ? prefixTokens : 0;
  const perThousand = (tokens, price) => Math.round(tokens * price) / 1000; // tokens * $/MTok * 1000 calls / 1e6
  return prices.map(price => ({
    model: price.model,
    verified: price.verified,
    handoffUncached: perThousand(handoffTokens, price.input),
    graphUncached: perThousand(graphTokens, price.input),
    graphSteadyState: Math.round((cachedPrefix * price.cacheHit + (graphTokens - cachedPrefix) * price.input)) / 1000,
  }));
}

// ---------------------------------------------------------------- one size

async function measureSize(api, size, { seed, reps, append }) {
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

  const shuffleRng = prng((seed ^ (size * 7919)) >>> 0);
  const parties = {};
  for (const [generated, session, packet, graph] of [[generatedA, sessionA, packetA, graphA], [generatedB, sessionB, packetB, graphB]]) {
    const name = generated.party.name;
    const { context } = await api('GET', `/api/graphs/${graph.id}/context`);
    const stored = (await api('GET', `/api/sessions/${session.id}`)).session;
    const handoff = handoffMarkdown(stored);
    if (handoff.length !== context.meter.handoffCharacters) throw new Error('Handoff rendering does not match the API meter.');

    // Order invariance: a shuffled copy must be the same graph with the same bytes.
    const reordered = (await api('POST', '/api/graphs', shuffledPacket(packet, shuffleRng))).graph;
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
        handoff: prefixStability(handoff, revisedHandoff),
        revisedRecall: contextRecall(revisedContext.text, [...generated.facts, generated.appended]),
      },
      orderInvariance: {
        sameGraphId: reordered.id === graph.id,
        identicalContext: reorderedContext.text === context.text,
      },
      costPerThousandHandoffsUsd: costs(context.meter.handoffTokens, context.meter.graphTokens, graphPrefix.prefixTokensEstimate),
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

function gitCommit() {
  try {
    return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'unknown';
  }
}

/**
 * Run the benchmark. Returns the report, its Markdown rendering and the harness
 * details (temp directory and server PID) so tests can check the cleanup.
 */
export async function runBenchmark(options = {}) {
  const { seed, sizes, reps, append } = { ...defaults, ...options };
  const tempDir = mkdtempSync(join(tmpdir(), 'context-ledger-bench-'));
  const database = join(tempDir, 'bench.sqlite');
  let server;
  const cleanup = () => {
    server?.child.kill();
    rmSync(tempDir, { recursive: true, force: true });
  };
  process.once('SIGINT', cleanup);
  try {
    server = await startServer(database);
    const api = client(server.base);
    const results = [];
    for (const size of sizes) results.push(await measureSize(api, size, { seed, reps, append }));
    const report = {
      benchmark: 'context-ledger M0',
      seed,
      sizes,
      reps,
      appendTurns: append,
      command: `node bench/m0.mjs --seed ${seed} --sizes ${sizes.join(',')} --reps ${reps} --append ${append}`,
      machine: { node: process.version, platform: `${process.platform} ${process.arch}`, cpu: cpus()[0]?.model ?? 'unknown', cpus: cpus().length },
      gitCommit: gitCommit(),
      date: new Date().toISOString().slice(0, 10),
      tokenEstimate: 'ceil(UTF-16 code units / 4); an estimate, not a tokenizer count',
      cacheMinimumTokens,
      prices: { seen: pricesSeen, models: prices },
      results,
    };
    return { report, markdown: renderMarkdown(report), harness: { tempDir, serverPid: server.child.pid } };
  } finally {
    await stopServer(server?.child);
    rmSync(tempDir, { recursive: true, force: true });
    process.removeListener('SIGINT', cleanup);
  }
}

/** The report without fields that legitimately differ between runs. */
export function deterministicPart(report) {
  const { machine: _machine, gitCommit: _commit, date: _date, ...rest } = report;
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
  const { report, markdown } = await runBenchmark(options);
  if (values.json) writeFileSync(values.json, JSON.stringify(report, null, 2) + '\n');
  if (values.markdown) writeFileSync(values.markdown, markdown);
  for (const result of report.results) {
    const teo = result.parties.teo;
    console.log(`size ${result.size}: handoff ${teo.size.handoffCharacters} chars, graph ${teo.size.graphCharacters} chars, `
      + `saved ${teo.size.savedShare} (est.), recall ${teo.recall.graph.recall}/${teo.recall.handoff.recall}, `
      + `prefix ${teo.cachePrefix.graph.share} vs ${teo.cachePrefix.handoff.share}, `
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
