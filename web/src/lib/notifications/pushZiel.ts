/**
 * Ziel-Validierung für Push-/Notification-Klicks (Security-Scan 2026-09-18).
 *
 * `target_url` kommt aus der Server-Push-Payload — wer das sendende Backend
 * kontrolliert (kompromittierter auth-svc, Self-Host-Betreiber), schreibt dort
 * beliebige URLs hinein. Unvalidiert landen sie in `clients.openWindow()`
 * (Service-Worker) bzw. `goto()` (Electron-Notify-Pfad): Phishing aus einer
 * „vertrauenswürdigen" Notification heraus.
 *
 * Erlaubt sind NUR Same-Origin-In-App-Pfade: führender `/`, aber nie `//`
 * (protokoll-relativ) und kein Backslash (Browser werten `\` in special
 * schemes wie `/` — `/\evil.com` wäre protokoll-relativ). Ein Doppelpunkt
 * mitten im Pfad ist harmlos (Schema-Erkennung greift nur am Anfang).
 *
 * Spiegel-Inline-Kopie im Service-Worker (`service-worker.ts`) — synchron
 * halten (dessen Bundle importiert bewusst nur `$service-worker`).
 */

export function istInAppZiel(u: string | null | undefined): u is string {
  return (
    typeof u === 'string' && u.startsWith('/') && !u.startsWith('//') && !u.includes('\\')
  );
}
