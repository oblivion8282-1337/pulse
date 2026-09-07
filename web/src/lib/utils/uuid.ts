/**
 * UUID v4, auch außerhalb von Secure Contexts.
 *
 * `crypto.randomUUID()` gibt es nur unter HTTPS oder localhost — die Dev-WebView
 * der Android-Hülle läuft aber auf `http://10.0.2.2:5173`, und dort warf jeder
 * Aufruf eine TypeError, die die App beim Boot komplett sterben ließ (die
 * Serverliste braucht beim Start eine lokale ID). `crypto.getRandomValues`
 * existiert dagegen überall; der Fallback ist das MDN-Muster dazu.
 */
export function neueUuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) =>
    (
      Number(c) ^
      (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (Number(c) / 4)))
    ).toString(16),
  );
}
