import { labelText, visibleText } from './text.mjs';

function fencedText(text) {
  const visible = visibleText(text);
  let fenceLength = 3;
  for (const run of visible.matchAll(/~+/g)) {
    fenceLength = Math.max(fenceLength, run[0].length + 1);
  }
  const fence = '~'.repeat(fenceLength);
  return [fence + 'text', visible, fence];
}

// One line with nothing invisible: a path cannot start a heading of its own or hide
// characters, and Markdown in it (strikethrough ~ included) is shown literally.
const markdownText = text => labelText(text).replace(/[\\`*_{}[\]<>()!&#~]/g, '\\$&');

/** The heading of one turn; an agent message (card I3) names its author and recipient. */
export function turnHeading({ role, line, author, recipient }) {
  const who = role === 'agent' ? `agent ${markdownText(author)} to ${markdownText(recipient)}` : role;
  return '## ' + who + ' · line ' + line;
}

/** Render an imported session as the cited Markdown packet the CLI prints. */
export function handoffMarkdown(session) {
  const source = visibleText(session.source).replace(/[\\`*_{}[\]<>()!&]/g, '\\$&');
  const turns = session.messages.flatMap(message => [
    '',
    turnHeading(message),
    '',
    ...fencedText(message.text),
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
