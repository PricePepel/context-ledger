// The ledger graph: one column per party, one button per node, and an SVG layer under
// them for edges. Labels are transcript data, so they are set with textContent.

const svgNs = 'http://www.w3.org/2000/svg';
const clip = (text, max) => (Array.from(text).length > max ? `${Array.from(text).slice(0, max - 1).join('')}…` : text);
const providerNames = { claude: 'Claude Code', codex: 'Codex' };

function el(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function graphMeta(node) {
  if (node.superseded) return 'superseded';
  if (node.kind === 'question') return `${node.answered ? 'answered' : node.status} · to ${node.to}`;
  return node.status ?? '';
}

// Card P3: a reviewer's decision (demo only) follows the graph's own state.
const nodeMeta = node => [graphMeta(node), node.review?.decision ?? ''].filter(Boolean).join(' · ');
const shownLabel = node => (node.review?.decision === 'edited' ? node.review.label : node.label);

export function createBrain(container, { onSelect }) {
  const edgesSvg = document.createElementNS(svgNs, 'svg');
  edgesSvg.setAttribute('class', 'brain-edges');
  edgesSvg.setAttribute('aria-hidden', 'true');
  const columnsBox = el('div', 'brain-columns');
  const empty = el('p', 'brain-empty', 'Nothing published yet. When an agent publishes to the ledger, its nodes appear here.');
  container.replaceChildren(edgesSvg, columnsBox, empty);

  const buttons = new Map();
  let view = { columns: [], edges: [] };
  let selected = null;

  function nodeButton(node) {
    let button = buttons.get(node.key);
    if (!button) {
      button = el('button', 'node');
      button.type = 'button';
      button.dataset.key = node.key;
      const head = el('span', 'node-kind');
      head.append(el('span', 'node-kind-name'), el('span', 'node-mark'));
      button.append(head, el('span', 'node-label'), el('span', 'node-meta'));
      button.addEventListener('click', () => onSelect(node.key));
      // Drop the animation class when it ends, so a later redraw does not replay it.
      button.addEventListener('animationend', () => button.classList.remove('pop', 'pulse'));
      buttons.set(node.key, button);
    }
    const [kind, label, meta] = button.children;
    // Card G7 mark, as a word beside the kind, so it never relies on colour alone.
    kind.children[0].textContent = node.kind;
    kind.children[1].textContent = node.mark ? ` · ${node.mark}` : '';
    label.textContent = clip(shownLabel(node), 90);
    meta.textContent = nodeMeta(node);
    // An animation still running (pop or pulse) survives a redraw; animationend drops it.
    const running = ['pop', 'pulse'].filter(name => button.classList.contains(name));
    button.className = ['node', `kind-${node.kind}`, `mark-${node.mark ?? 'none'}`,
      node.superseded ? 'is-superseded' : '', node.answered ? 'is-answered' : '',
      node.review ? `review-${node.review.decision}` : '', node.key === selected ? 'is-selected' : '', ...running].filter(Boolean).join(' ');
    button.dataset.mark = node.mark ?? 'none';
    button.setAttribute('aria-pressed', String(node.key === selected));
    const state = nodeMeta(node);
    button.setAttribute('aria-label', `${node.kind}${node.mark ? `, ${node.mark}` : ''}: ${clip(shownLabel(node), 200)}${state ? ` (${state})` : ''}. Show evidence.`);
    return button;
  }

  function drawEdges() {
    const box = container.getBoundingClientRect();
    // Size to the columns, not the scroll box: the layer must not make room for itself.
    edgesSvg.setAttribute('width', String(columnsBox.scrollWidth));
    edgesSvg.setAttribute('height', String(columnsBox.offsetHeight));
    const paths = [];
    for (const edge of view.edges) {
      const from = buttons.get(edge.from);
      const to = buttons.get(edge.to);
      if (!from?.isConnected || !to?.isConnected) continue;
      const a = from.getBoundingClientRect();
      const b = to.getBoundingClientRect();
      const x = rect => rect.left - box.left + container.scrollLeft;
      const ay = a.top - box.top + container.scrollTop + a.height / 2;
      const by = b.top - box.top + container.scrollTop + b.height / 2;
      const path = document.createElementNS(svgNs, 'path');
      let d;
      if (edge.link && Math.abs(x(a) - x(b)) > a.width / 2) {
        // Across columns: leave from the facing sides with a gentle S-curve.
        const rightward = x(b) > x(a);
        const ax = rightward ? x(a) + a.width : x(a);
        const bx = rightward ? x(b) : x(b) + b.width;
        const bend = rightward ? 24 : -24;
        d = `M${ax},${ay} C${ax + bend},${ay} ${bx - bend},${by} ${bx},${by}`;
      } else {
        // Same column (stacked on a phone): bow out to the left.
        d = `M${x(a)},${ay} C${x(a) - 28},${ay} ${x(b) - 28},${by} ${x(b)},${by}`;
      }
      path.setAttribute('d', d);
      path.setAttribute('class', `edge edge-${edge.type}${edge.link ? ' edge-link' : ''}`);
      paths.push(path);
    }
    edgesSvg.replaceChildren(...paths);
  }

  new ResizeObserver(() => drawEdges()).observe(container);

  return {
    /** Draw the graph; keys in `pop` get the pop-in animation, `changed` a pulse. */
    render(next, { pop = new Set(), changed = new Set() } = {}) {
      view = next;
      // Moving a focused button blurs it, so keyboard users keep their place.
      const focusedKey = container.contains(document.activeElement) ? document.activeElement.dataset.key : undefined;
      const columns = next.columns.map(column => {
        const section = el('section', `brain-col provider-${column.provider}`);
        section.dataset.party = column.key;
        const heading = el('h3', 'brain-col-title');
        heading.append(el('span', 'brain-col-name', clip(column.label, 32)), el('span', 'brain-col-provider', providerNames[column.provider] ?? column.provider));
        const list = el('ol', 'brain-nodes');
        for (const node of column.nodes) {
          const item = el('li');
          const button = nodeButton(node);
          if (pop.has(node.key)) button.classList.add('pop');
          else if (changed.has(node.key)) button.classList.add('pulse');
          item.append(button);
          list.append(item);
        }
        section.append(heading, list);
        return section;
      });
      columnsBox.replaceChildren(...columns);
      const live = new Set(next.columns.flatMap(column => column.nodes.map(node => node.key)));
      for (const key of buttons.keys()) if (!live.has(key)) buttons.delete(key);
      empty.hidden = next.columns.length > 0;
      if (focusedKey) buttons.get(focusedKey)?.focus({ preventScroll: true });
      requestAnimationFrame(drawEdges);
    },
    element: key => buttons.get(key) ?? null,
    select(key) {
      selected = key;
      for (const [buttonKey, button] of buttons) {
        button.classList.toggle('is-selected', buttonKey === key);
        button.setAttribute('aria-pressed', String(buttonKey === key));
      }
    },
  };
}
