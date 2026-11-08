import { visibleText } from './text.mjs';

function fencedText(text) {
  const visible = visibleText(text);
  let fenceLength = 3;
  for (const run of visible.matchAll(/~+/g)) {
    fenceLength = Math.max(fenceLength, run[0].length + 1);
  }
  const fence = '~'.repeat(fenceLength);
  return [fence + 'text', visible, fence];
}

/** Render an imported session as the cited Markdown packet the CLI prints. */
export function handoffMarkdown(session) {
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
