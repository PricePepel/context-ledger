// Panel switches (card U6): the header's Evidence and Activity buttons show or hide those
// panels in the right column. The choice is remembered per browser when storage allows;
// with both off, the office and the graph take the full width.
const KEY = 'ctm-console-panels';

function load() {
  let stored;
  try { stored = JSON.parse(localStorage.getItem(KEY)); } catch { return {}; }
  const pick = name => (stored?.[name] === false ? { [name]: false } : {});
  return stored && typeof stored === 'object' ? { ...pick('evidence'), ...pick('feed') } : {};
}

function save(state) {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* storage blocked: keep the choice for this visit only */ }
}

export function createPanels(root) {
  const buttons = [...root.querySelectorAll('button[data-panel]')];
  const layout = root.querySelector('.console');
  const state = { evidence: true, feed: true, ...load() };

  const apply = () => {
    for (const button of buttons) {
      const name = button.dataset.panel;
      const on = state[name] !== false;
      button.setAttribute('aria-pressed', String(on));
      root.getElementById(name).hidden = !on;
    }
    layout.classList.toggle('no-side', buttons.every(button => state[button.dataset.panel] === false));
  };

  const set = (name, on) => { state[name] = on; save(state); apply(); };
  for (const button of buttons) {
    button.addEventListener('click', () => set(button.dataset.panel, button.getAttribute('aria-pressed') !== 'true'));
  }
  apply();
  return { show: name => { if (state[name] === false) set(name, true); } };
}
