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
