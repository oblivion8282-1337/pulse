/**
 * "In der Cloud registriert & auffindbar" — ehrlicher Ersatz für den früheren
 * Erreichbarkeits-Selbsttest (der nur TCP-1936 probte, eine für App-Host-
 * Streaming irrelevante Tür → Dauer-Fehlalarm "Streaming betroffen").
 *
 * Wirklich prüfbares Signal: der direct-adapter im Server-Container checkt
 * periodisch bei der Cloud ein (Directory-Heartbeat). Klappt das, funktioniert
 * der Ausgang UND Freunde finden den Server im Telefonbuch.
 *
 * Abfrage: GET /api/auth/me/instances/{id}/direct-endpoint (Session-Cookie,
 * routes_selfhost_directory.py). Antwort trägt `online` (Heartbeat jünger als
 * directory_online_threshold_seconds = 300s → true).
 *
 * Reine Klassifikation, keine Electron-Imports → node:test-bar.
 */

/** null = kein eindeutiges Signal (Session-/Netz-/Serverfehler) → fail-safe,
 *  die UI zeigt dann nichts. Nur eine echte 200-Antwort ergibt einen Boolean. */
export function classifyCloudStatus(status: number, body: unknown): boolean | null {
  if (status !== 200) return null;
  const online = (body as { online?: unknown } | null)?.online;
  return online === true;
}
