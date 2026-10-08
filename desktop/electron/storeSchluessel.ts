/**
 * Welche Store-Schlüssel verschlüsselt liegen und welche der Renderer nie
 * lesen darf — als Regel über die Schlüsselform, nicht als Liste fester Namen.
 *
 * Warum Regel statt Liste (Scan 2026-10-08): Seit den Benutzer-Welten
 * (2026-10-01) liegen die Server-Zugangsdaten je Konto unter
 * `pulse.host.creds.<userId>`. Sperrliste und Verschlüsselungsliste kannten
 * nur den suffixlosen Namen — `client_secret` + `relay_tunnel_token` lagen
 * dadurch im Klartext auf der Platte und waren über `store:get` für jede im
 * Server-Fenster geladene Seite lesbar. Eine Liste exakter Namen veraltet
 * still, sobald ein Schlüssel ein Suffix bekommt; ein Präfix nicht.
 *
 * Importfrei — der Node-Testläufer prüft die Regeln ohne Electron.
 */

/** Schlüssel, die über safeStorage verschlüsselt abgelegt werden.
 *
 * * `pulse.host.creds` und `pulse.host.creds.<userId>` — Pairing des
 *   Server-Modus (`client_secret`, `relay_tunnel_token`).
 * * `pulse.host.auth` — dauerhafter Cloud-Login der Server-App (Access- und
 *   Refresh-Token, 30 Tage Kontozugang).
 * * `custom_servers` — LEGACY, kann auf Alt-Installationen Stream-Keys tragen.
 */
export function istGeheimerSchluessel(key: string): boolean {
  return (
    key === 'pulse.host.creds' ||
    key.startsWith('pulse.host.creds.') ||
    key === 'pulse.host.auth' ||
    key === 'custom_servers'
  );
}

/** Schlüssel, die der Renderer über keinen `store:*`-Lesekanal bekommt.
 *
 * Der ganze Namensraum `pulse.host.*` gehört dem Main-Prozess (Zugangsdaten,
 * Login, aktive Welt, Backup-Zeitpunkt); der Renderer liest keinen davon —
 * er bekommt den bereinigten Zustand über die `host:*`-Kanäle. */
export function istRendererGesperrt(key: string): boolean {
  return key.startsWith('pulse.host.');
}
