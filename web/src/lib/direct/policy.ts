/**
 * Reine Entscheidungslogik der Direktpfad-Weiche (kein IO, kein Store) —
 * bewusst pur gehalten, damit sie ohne echtes App-Host-Gerät nachvollzieh-
 * und testbar bleibt.
 *
 * User-Entscheidung 2026-07-13: App-Host-Instanzen (origin='app_host') haben
 * KEINEN Relay-Fallback mehr — Text/Login liefe sonst doch über die Cloud.
 * Der Direktpfad ist für sie der einzige Weg; scheitert er, gibt es einen
 * harten, erklärten Fehlerzustand statt eines stillen Cloud-Umwegs.
 * VPS-Self-Hosts (origin='vps' oder unbekannt/Alt-Eintrag) bleiben unberührt:
 * ihr Hostname IST ihr Weg, der Direktpfad nur eine Optimierung.
 */

export type DirectFailureReason = 'offline' | 'ice-failed' | 'fingerprint-mismatch';

/** Minimalform eines ServerEntry, gegen die die Weiche entscheidet. */
export interface DirectPolicyServer {
  isCloud?: boolean;
  instance_id?: string | null;
  origin?: 'vps' | 'app_host' | null;
}

/**
 * True, wenn dieser Server AUSSCHLIESSLICH über den Direktpfad erreichbar
 * sein darf (kein Relay-/Hostname-Fallback). Nur explizit als 'app_host'
 * markierte Einträge — `origin` fehlt bei Alt-Einträgen (vor der
 * hydrateFromBackend-Anreicherung) und heißt dann bewusst "wie bisher".
 */
export function isDirectOnly(server: DirectPolicyServer | null | undefined): boolean {
  return !!server && !server.isCloud && !!server.instance_id && server.origin === 'app_host';
}

/**
 * True, wenn ein 404 des Telefonbuch-Lookups für diese Sitzung als endgültig
 * gelten darf — dann muss der Klient nicht alle 60 s erneut fragen.
 *
 * Das gilt für VPS-Self-Hosts: deren `direct-adapter` legt sich mangels
 * Relay-Token schlafen (`infra/self-host/s6/…/direct-adapter/run`), es
 * entsteht also nie ein Eintrag, und der Direktpfad ist für sie ohnehin nur
 * eine Optimierung. **Nicht** für App-Host-Instanzen: deren Server-App kann
 * nach dem Seitenaufruf starten und ihren ersten Heartbeat senden — ein
 * dauerhaft gemerktes 404 liesse sie für die ganze Sitzung offline aussehen.
 *
 * Nur 404 zählt. Ein 401 (Cloud-Sitzung noch nicht da) oder 5xx sagt nichts
 * über den Eintrag aus und bleibt der kurzen Wiederholung überlassen.
 *
 * Das 404 der Route deckt zwei weitere Fälle mit ab (ungültige Kennung und
 * fehlende Mitgliedschaft — 404 statt 403 gegen Existence-Leak, s.
 * `routes_selfhost_directory.py`). Beide sitzungsweit zu merken kostet
 * höchstens die Optimierung: der Hostname bleibt der Weg des VPS.
 */
export function fehlenderEintragIstDauerhaft(
  status: number,
  server: DirectPolicyServer | null | undefined
): boolean {
  return status === 404 && !isDirectOnly(server);
}

/**
 * Fehler-Mapping der drei Direktpfad-Fehlzustände auf i18n-Key-Namen
 * (das UI ruft `m[key]()` auf — hier nur die pure Zuordnung):
 *  - offline: Telefonbuch meldet die Instanz als offline → bestehende
 *    Offline-Anzeige ("Server ist offline").
 *  - ice-failed: Telefonbuch online, aber die WebRTC-Verhandlung scheiterte
 *    (Netzwerk lässt Direktverbindungen vermutlich nicht zu).
 *  - fingerprint-mismatch: TOFU-Pin weicht ab → sichtbarer Vertrauens-Dialog
 *    (kein stiller Fallback, kein console.warn mehr).
 */
export function directFailureMessageKey(
  reason: DirectFailureReason
): 'direct_error_offline' | 'direct_error_ice' | 'direct_error_fingerprint' {
  if (reason === 'offline') return 'direct_error_offline';
  if (reason === 'ice-failed') return 'direct_error_ice';
  return 'direct_error_fingerprint';
}
