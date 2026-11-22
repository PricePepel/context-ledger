// P1f: the browser's sign-in session. The secret lives in this origin's localStorage,
// which the browser keeps apart by scheme, host and port, and goes to the ledger only in
// the X-Context-Ledger-Session header of this page's own requests. It is not a cookie,
// because browsers send cookies to every port on 127.0.0.1. Loaded before app.js and
// the console's modules; the sign-in page stores the secret, a 401 forgets it.
(() => {
  const key = 'context-ledger-session';
  const header = 'X-Context-Ledger-Session';
  const pattern = /^[A-Za-z0-9_-]{43}$/u;
  const read = () => {
    try {
      const value = localStorage.getItem(key);
      return value !== null && pattern.test(value) ? value : undefined;
    } catch {
      return undefined;
    }
  };
  const ledgerSession = Object.freeze({
    /** The given headers, plus the session header when this browser is signed in. */
    headers(extra) {
      const value = read();
      return value === undefined ? { ...extra } : { ...extra, [header]: value };
    },
    /** Keeps a session secret from POST /api/session; false when storage refused it. */
    store(value) {
      if (typeof value !== 'string' || !pattern.test(value)) return false;
      try {
        localStorage.setItem(key, value);
        return true;
      } catch {
        return false;
      }
    },
    /**
     * Drops the stored secret after the ledger refused a request, given the headers that
     * request was sent with: only when storage still holds the secret they carried, so a
     * late 401 for an old session never signs out a newer one (P1f review).
     */
    forget(sentHeaders) {
      const sent = sentHeaders?.[header];
      if (sent === undefined || read() !== sent) return;
      try {
        localStorage.removeItem(key);
      } catch {
        // Storage is unavailable, so there is nothing to forget.
      }
    },
  });
  Object.defineProperty(globalThis, 'ledgerSession', { value: ledgerSession });
})();
