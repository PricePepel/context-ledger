import { parseArgs } from 'node:util';

const usage = 'Usage: npm run ledger -- search [--provider claude|codex] [query]\n' +
  '       npm run ledger -- handoff <session-id>';

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
  throw new Error(usage);
}

function visibleText(text) {
  return text.replace(/\r\n/g, '\n').replace(/\p{Cc}/gu, character => {
    if (character === '\n' || character === '\t') return character;
    return '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0');
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
  const { action, path } = command(process.argv.slice(2));
  const port = Number(process.env.PORT ?? 4317);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT.');
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${port}${path}`, {
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw new Error(`Cannot reach Context Ledger on port ${port}. Start it with npm start.`);
  }
  if (response.status === 404) throw new Error('Session not found.');
  if (!response.ok) throw new Error(`Context Ledger returned HTTP ${response.status}.`);
  const data = await response.json();
  console.log(action === 'search' ? JSON.stringify(data.sessions, null, 2) : handoff(data.session));
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
