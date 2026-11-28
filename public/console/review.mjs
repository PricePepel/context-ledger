// Card P3: the reviewer prototype. A person approves, edits or rejects a node beside its
// evidence. What each action means is still Ruslan's call, so nothing here writes to the
// ledger: reviews live in this browser's localStorage, keyed by graph ID and node ID.
// Shown in demo mode only. Labels are set with textContent, never parsed as HTML.

export const storageKey = 'ctm-console-reviews-v0';
export const maxLabel = 300;
const decisions = new Set(['approved', 'edited', 'rejected']);
const hidden = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/** A reviewer's label, trimmed, or null when it is empty, too long or holds hidden characters. */
export function cleanLabel(text) {
  const label = String(text ?? '').trim();
  if (!label || Array.from(label).length > maxLabel || hidden.test(label)) return null;
  return label;
}

const isReview = value => value !== null && typeof value === 'object' && decisions.has(value.decision)
  && (value.decision !== 'edited' || cleanLabel(value.label) === value.label);

/**
 * The reviews kept in `storage` (localStorage, or anything with getItem and setItem).
 * Bad stored data is dropped, and a storage that throws only loses persistence.
 */
export function createReviews(storage) {
  const reviews = new Map();
  const key = (graphId, nodeId) => JSON.stringify([String(graphId), String(nodeId)]);
  try {
    const stored = JSON.parse(storage?.getItem(storageKey) ?? '[]');
    if (Array.isArray(stored)) {
      for (const row of stored) {
        if (!Array.isArray(row) || row.length !== 3) continue;
        const [graphId, nodeId, review] = row;
        if (typeof graphId === 'string' && typeof nodeId === 'string' && isReview(review)) {
          reviews.set(key(graphId, nodeId), review.decision === 'edited'
            ? { decision: 'edited', label: review.label } : { decision: review.decision });
        }
      }
    }
  } catch { /* unreadable or blocked storage: start empty */ }

  function save() {
    const rows = [...reviews].map(([pair, review]) => [...JSON.parse(pair), review]);
    try { storage?.setItem(storageKey, JSON.stringify(rows)); } catch { /* kept for this session only */ }
  }

  return {
    get: (graphId, nodeId) => reviews.get(key(graphId, nodeId)) ?? null,
    /** Record a decision. An edit needs a clean label; returns false when it is refused. */
    decide(graphId, nodeId, decision, label) {
      if (decision !== 'approved' && decision !== 'rejected' && decision !== 'edited') return false;
      if (decision === 'edited') {
        const clean = cleanLabel(label);
        if (!clean) return false;
        reviews.set(key(graphId, nodeId), { decision, label: clean });
      } else {
        reviews.set(key(graphId, nodeId), { decision });
      }
      save();
      return true;
    },
    undo(graphId, nodeId) {
      if (reviews.delete(key(graphId, nodeId))) save();
    },
  };
}

/** The graph view with each node's review attached (null when it has none). */
export function withReviews(view, reviews) {
  return {
    ...view,
    columns: view.columns.map(column => ({
      ...column,
      nodes: column.nodes.map(node => ({ ...node, review: reviews.get(column.graphId, node.id) })),
    })),
  };
}

function el(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

const said = { approved: 'You approved this node.', rejected: 'You rejected this node.', edited: 'You edited this node\'s label.' };

/** The Review block in the evidence panel. `onChange` runs after every decision. */
export function createReviewPanel(container, { reviews, onChange }) {
  let current = null; // { graphId, nodeId, label }

  function button(text, onClick) {
    const element = el('button', 'review-button', text);
    element.type = 'button';
    element.addEventListener('click', onClick);
    return element;
  }

  function decide(decision, label) {
    if (!reviews.decide(current.graphId, current.nodeId, decision, label)) return false;
    onChange();
    draw('.review-undo');
    return true;
  }

  function editor() {
    const form = el('form', 'review-edit');
    const field = el('textarea', 'review-field');
    field.id = 'review-field';
    field.rows = 3;
    field.maxLength = maxLabel * 2;
    field.value = reviews.get(current.graphId, current.nodeId)?.label ?? current.label;
    const label = el('label', 'review-field-label', 'New label');
    label.htmlFor = field.id;
    const note = el('p', 'review-note');
    note.setAttribute('role', 'status');
    const save = el('button', 'review-button review-primary', 'Save');
    save.type = 'submit';
    const cancel = button('Cancel', () => draw('.review-edit-open'));
    const row = el('div', 'review-row');
    row.append(save, cancel);
    form.append(label, field, row, note);
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (!decide('edited', field.value)) note.textContent = `Use 1 to ${maxLabel} characters, with no hidden characters.`;
    });
    container.replaceChildren(el('h3', 'review-heading', 'Review'), form);
    field.focus();
  }

  function draw(focus) {
    container.hidden = !current;
    if (!current) return container.replaceChildren();
    const review = reviews.get(current.graphId, current.nodeId);
    const parts = [el('h3', 'review-heading', 'Review')];
    if (review) {
      parts.push(el('p', `review-state review-state-${review.decision}`, said[review.decision]));
      if (review.decision === 'edited') {
        parts.push(el('p', 'review-label', review.label));
      }
    }
    const row = el('div', 'review-row');
    row.append(
      button('Approve', () => decide('approved')),
      Object.assign(button('Edit', editor), { className: 'review-button review-edit-open' }),
      button('Reject', () => decide('rejected')),
    );
    if (review) {
      const undo = button('Undo', () => { reviews.undo(current.graphId, current.nodeId); onChange(); draw('.review-edit-open'); });
      undo.classList.add('review-undo');
      row.append(undo);
    }
    parts.push(row, el('p', 'review-note', 'Prototype: kept in this browser only. Nothing is sent to the ledger.'));
    container.replaceChildren(...parts);
    if (focus) container.querySelector(focus)?.focus();
  }

  return {
    /**
     * Point the block at a node snapshot. The same snapshot again is a no-op, so an open
     * edit form keeps its text; a new graph ID is a new snapshot and starts unreviewed.
     */
    show({ entry, node }) {
      if (current && current.graphId === entry.graph.id && current.nodeId === node.id && current.label === node.label) return;
      current = { graphId: entry.graph.id, nodeId: node.id, label: node.label };
      draw();
    },
    clear() {
      current = null;
      draw();
    },
  };
}
