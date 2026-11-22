// P1f: the sign-in page. It takes the one-time code from its own address, drops it from
// the address bar and this history entry, and trades it once at POST /api/session for a
// session secret that session.js keeps in this origin's storage.
const status = document.getElementById('sign-in-status');
const codes = new URLSearchParams(location.search).getAll('code');
history.replaceState(null, '', '/login');
const linkFailure = 'This sign-in link was already used, has expired or is not valid. Run npm run ledger -- login for a new one.';

async function signIn() {
  if (codes.length !== 1) {
    status.textContent = linkFailure;
    return;
  }
  const response = await fetch('/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: codes[0] }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    status.textContent = typeof body.error === 'string' ? body.error : linkFailure;
    return;
  }
  if (!globalThis.ledgerSession.store(body.session)) {
    status.textContent = 'This browser would not keep the sign-in. Allow site data for this address and open a new link.';
    return;
  }
  location.replace('/');
}

signIn().catch(() => {
  status.textContent = 'Cannot reach Context Ledger. Check that it is running and open a new link.';
});
