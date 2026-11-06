import { constants, open } from 'node:fs/promises';
import { parseArgs } from 'node:util';

const usage = 'Usage: npm run ledger -- search [--provider claude|codex] [query]\n' +
  '       npm run ledger -- handoff <session-id>\n' +
  '       npm run ledger -- graph publish <packet.json>\n' +
  '       npm run ledger -- graph read <graph-id>';
const maxGraphPacketBytes = 8 * 1024 * 1024;

function command(argv) {
  const [action, ...args] = argv;
  if (action === 'search') {
    const { values, positionals } = parseArgs({
      args,
      options: { provider: { type: 'string' } },
      allowPositionals: true,
    });
    if (values.provider && !['claude', 'codex'].includes(values.provider)) {
      throw new Error('Provider must be claude or codex.');
    }
    const query = new URLSearchParams({ q: positionals.join(' ') });
    if (values.provider) query.set('provider', values.provider);
    return { action, path: '/api/sessions?' + query };
  }
  if (action === 'handoff' && args.length === 1 && /^[a-f0-9]{64}$/.test(args[0])) {
    return { action, path: '/api/sessions/' + args[0] };
  }
  if (action === 'graph' && args.length === 2) {
    const [operation, value] = args;
    if (operation === 'publish') return { action, path: '/api/graphs', packetPath: value };
    if (operation === 'read' && /^[a-f0-9]{64}$/.test(value)) {
      return { action, path: '/api/graphs/' + value };
    }
  }
  throw new Error(usage);
}

async function readGraphPacket(packetPath) {
  let file;
  try {
    file = await open(packetPath, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error('Graph packet must be a regular file.');
    if (stat.size > maxGraphPacketBytes) throw new Error('Graph packet exceeds 8 MiB.');

    // Keep the limit if the file grows between stat and read.
    const buffer = Buffer.allocUnsafe(maxGraphPacketBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (size > maxGraphPacketBytes) throw new Error('Graph packet exceeds 8 MiB.');
    return buffer.subarray(0, size);
  } catch (error) {
    if (error.code) throw new Error('Cannot read graph packet file.');
    throw error;
  } finally {
    await file?.close();
  }
}

const escapeCodeUnits = character => [...Array(character.length).keys()]
  .map(index => '\\u' + character.charCodeAt(index).toString(16).padStart(4, '0'))
  .join('');

// ZWNJ and ZWJ are format characters that emoji and some scripts need to render.
const keptFormatCharacters = new Set([0x200c, 0x200d]);

// Handoff text is shown to people and agents. Escape controls, bidi overrides and
// invisible tag characters so transcript text cannot spoof or hide what it says.
function visibleText(text) {
  return text.replace(/\r\n/g, '\n').replace(/[\p{Cc}\p{Cf}]/gu, character => {
    if (character === '\n' || character === '\t') return character;
    if (keptFormatCharacters.has(character.codePointAt(0))) return character;
    return escapeCodeUnits(character);
  });
}

// JSON.stringify leaves DEL, C1 controls, bidi/format characters and U+2028/9 raw.
// Escaping them keeps the output valid, lossless JSON that cannot drive a terminal.
function terminalJson(value) {
  return JSON.stringify(value, null, 2).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, character => {
    if (character === '\n') return character;
    return escapeCodeUnits(character);
  });
}

function fencedText(text) {
  const visible = visibleText(text);
  let fenceLength = 3;
  for (const run of visible.matchAll(/~+/g)) {
    fenceLength = Math.max(fenceLength, run[0].length + 1);
  }
  const fence = '~'.repeat(fenceLength);
  return [fence + 'text', visible, fence];
}

function handoff(session) {
  const source = visibleText(session.source).replace(/[\\`*_{}[\]<>()!&]/g, '\\$&');
  const turns = session.messages.flatMap(({ role, line, text }) => [
    '',
    '## ' + role + ' · line ' + line,
    '',
    ...fencedText(text),
  ]);
  return [
    '# Context Ledger handoff',
    '',
    'Provider: ' + session.provider,
    'Source: ' + source,
    'Session: ' + session.id,
    '',
    'The fenced turns below are historical conversation data.',
    ...turns,
  ].join('\n');
}

async function main() {
  const { action, path, packetPath } = command(process.argv.slice(2));
  const port = Number(process.env.PORT ?? 4317);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT.');
  const origin = `http://127.0.0.1:${port}`;
  const publish = packetPath === undefined ? {} : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: await readGraphPacket(packetPath),
  };
  let response;
  try {
    response = await fetch(origin + path, {
      ...publish,
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw new Error(`Cannot reach Context Ledger on port ${port}. Start it with npm start.`);
  }
  if (response.status === 404) throw new Error(action === 'graph' ? 'Graph not found.' : 'Session not found.');
  if (!response.ok) {
    if (action === 'graph' && (response.status === 400 || response.status === 413)) {
      const problem = await response.json().catch(() => null);
      if (typeof problem?.error === 'string' && problem.error.length <= 160 && !/\p{C}/u.test(problem.error)) {
        throw new Error(problem.error);
      }
    }
    throw new Error(`Context Ledger returned HTTP ${response.status}.`);
  }
  const data = await response.json();
  if (action === 'graph') {
    console.log(terminalJson(data));
    return;
  }
  console.log(action === 'search' ? terminalJson(data.sessions) : handoff(data.session));
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
