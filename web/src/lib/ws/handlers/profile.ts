/**
 * `profile_statement_rejected` — der Gateway hat das mitgeschickte
 * Profil-Statement abgelehnt (Signaturen-Verifikation fehlgeschlagen,
 * typischerweise ein Statement aus der Zeit vor einer Cloud-Schlüssel-
 * erneuerung).
 *
 * Bis 2026-09-18 blieb die Ablehnung stumm (nur Server-Log): derselbe
 * Klient reichte bei jeder (Re-)Verbindung dasselbe Statement erneut an —
 * stündlich, solange die Session hielt — und der Profil-Cache des Servers
 * (Anzeigename, Avatar, Farben) veraltete für diesen Nutzer. Der Handler
 * löst das Selbstheilen aus: frisches Statement von der Cloud holen, den
 * Store ersetzen und EINMAL auf derselben Verbindung nachschieben. Der
 * Retry-Guard liegt an der Connection (ein Retry je Socket).
 */
import { registerWsHandler } from '../handler-registry';
import { gatewayForServer } from '../connection';
import { dispatchingServerId } from '../gateway-connection';

export function register(): void {
  registerWsHandler('profile_statement_rejected', () => {
    const sid = dispatchingServerId();
    if (!sid) return;
    let conn;
    try {
      conn = gatewayForServer(sid);
    } catch {
      return; // Server-Eintrag weg (Race mit Remove) — nächster Connect versucht es erneut
    }
    void conn?.profilStatementErneuern();
  });
}
