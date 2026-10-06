/**
 * Presigned-Objekt-URLs auf die Origin des Clients umschreiben (nur Dev).
 *
 * Im Dev-Stack signiert der chat-gateway Anhang-URLs für Garage direkt
 * (`S3_PUBLIC_ENDPOINT=http://127.0.0.1:9000`) — eine Adresse, die ein
 * Client-Gerät nie erreicht (localhost/Loopback) und die als http neben
 * einer https-Seite ohnehin Mixed-Content wäre. Der Vite-Proxy bedient
 * denselben Pfad unter der Dev-Origin und stellt den signierten Host
 * wieder her (changeOrigin, s. vite.config.ts) — also reicht es, den
 * Origin-Teil auf `location.origin` umzuschreiben; Pfad und Signatur-
 * Query bleiben unangetastet.
 *
 * Nur Loopback-Hosts werden umgeschrieben und nur im Dev-Build — in Prod
 * (howispulse.com) wie im Self-Host ist die vom Server gelieferte URL
 * bereits same-origin oder bewusst fremd, und ein Eingriff wäre falsch.
 */
export function devS3Url(url: string): string {
  if (!import.meta.env.DEV) return url;
  try {
    const u = new URL(url, location.origin);
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') {
      return new URL(u.pathname + u.search, location.origin).toString();
    }
  } catch {
    /* keine parsebare URL — unverändert durchreichen */
  }
  return url;
}
