// The proof panel: the cited transcript turns of one node, with the cited lines
// marked. Every transcript string is set with textContent, never parsed as HTML.
import { evidenceTurns, turnSpeaker, visibleText } from './model.mjs';

const providerNames = { claude: 'Claude Code', codex: 'Codex' };
function el(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

const lineList = lines => lines.map(line => `L${line}`).join(', ');
// Card P2b: a version 3 node can cite artifacts beside (or instead of) transcript lines.
const artifactText = artifact => visibleText(`${artifact.kind} ${artifact.repo}@${artifact.ref}`);

export function createEvidence(panel, { loadSession }) {
  const heading = panel.querySelector('#evidence-heading');
  const meta = panel.querySelector('#evidence-meta');
  const status = panel.querySelector('#evidence-status');
  const turns = panel.querySelector('#evidence-turns');
  let request = 0;
  const intro = { heading: heading.textContent, status: status.textContent };

  return {
    /** Back to the empty panel, with an optional note. */
    clear(note) {
      request += 1;
      heading.textContent = intro.heading;
      meta.replaceChildren();
      turns.replaceChildren();
      status.textContent = note ?? intro.status;
      panel.classList.remove('is-open');
    },

    async show({ entry, node }) {
      const ticket = ++request;
      heading.textContent = visibleText(node.label);
      meta.replaceChildren(
        el('span', 'evidence-tag', node.kind),
        el('span', '', `${entry.label} · ${providerNames[entry.provider] ?? entry.provider}`),
        ...(node.evidenceLines.length ? [el('span', '', `cites ${lineList(node.evidenceLines)}`)] : []),
        ...(node.artifacts ?? []).map(artifact => el('span', 'evidence-artifact', `cites ${artifactText(artifact)}`)),
      );
      turns.replaceChildren();
      panel.classList.add('is-open');
      if (!node.evidenceLines.length) {
        status.textContent = 'This node cites artifacts only, listed above; no transcript line.';
        return;
      }
      status.textContent = 'Reading the cited lines…';
      try {
        const session = await loadSession(entry.sessionId);
        if (ticket !== request) return;
        const shown = evidenceTurns(session.messages, node.evidenceLines);
        turns.replaceChildren(...shown.map(turn => {
          const item = el('li', turn.cited ? 'turn is-cited' : 'turn');
          const head = el('p', 'turn-head');
          head.append(el('span', 'turn-line', `L${turn.line}`), el('span', 'turn-role', turnSpeaker(turn)));
          if (turn.cited) head.append(el('span', 'turn-cited', 'cited'));
          const body = el(turn.cited ? 'mark' : 'p', 'turn-text', turn.text);
          item.append(head, body);
          return item;
        }));
        const found = shown.filter(turn => turn.cited).length;
        status.textContent = `${session.source} · ${found} of ${node.evidenceLines.length} cited ${node.evidenceLines.length === 1 ? 'line' : 'lines'} shown, with the turns around them.`;
      } catch (error) {
        if (ticket === request) status.textContent = `Could not read the transcript: ${error.message}`;
      }
    },
  };
}
