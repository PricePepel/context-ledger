import { spawn } from 'node:child_process';
import { once } from 'node:events';

// A minimal stdio MCP client for tests: one JSON-RPC message per line in each direction.
// Auto-start is off unless a test asks for it, so a test never starts a stray ledger.
export function startMcp(port, env = {}) {
  const child = spawn(process.execPath, ['src/mcp.mjs'], {
    env: { ...process.env, PORT: String(port), CONTEXT_LEDGER_AUTOSTART: '0', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const messages = [];
  const nonProtocol = [];
  const waiters = [];
  let stdout = '';
  let stderr = '';

  const deliver = () => {
    for (const waiter of [...waiters]) {
      const message = messages.find(candidate => !candidate.claimed && waiter.match(candidate.value));
      if (!message) continue;
      message.claimed = true;
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(message.value);
    }
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    stdout += chunk;
    let newline;
    while ((newline = stdout.indexOf('\n')) !== -1) {
      const line = stdout.slice(0, newline);
      stdout = stdout.slice(newline + 1);
      try {
        const value = JSON.parse(line);
        if (value?.jsonrpc !== '2.0') throw new Error('not JSON-RPC');
        messages.push({ value, line, claimed: false });
      } catch {
        nonProtocol.push(line);
      }
    }
    deliver();
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = once(child, 'exit');

  const client = {
    child,
    messages: () => messages.map(message => message.value),
    lines: () => messages.map(message => message.line),
    nonProtocol: () => [...nonProtocol, ...(stdout ? [stdout] : [])],
    stderr: () => stderr,
    write(text) {
      child.stdin.write(text);
    },
    send(message) {
      child.stdin.write(JSON.stringify(message) + '\n');
    },
    waitFor(match, timeout = 5000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out waiting for an MCP message.')), timeout);
        waiters.push({ match, resolve: value => { clearTimeout(timer); resolve(value); } });
        deliver();
      });
    },
    request(id, method, params) {
      const message = { jsonrpc: '2.0', id, method };
      if (params !== undefined) message.params = params;
      client.send(message);
      return client.waitFor(candidate => candidate.id === id);
    },
    call(id, name, args) {
      return client.request(id, 'tools/call', args === undefined ? { name } : { name, arguments: args })
        .then(response => response.result);
    },
    async close() {
      child.stdin.end();
      const [code] = await exited;
      return code;
    },
    exited,
  };
  return client;
}
