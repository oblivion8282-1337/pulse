/**
 * Darf dieser Rechner ohne Rückfrage zustimmen?
 *
 * Drei Bedingungen, alle drei fail-closed:
 *
 * * `freigabe` — der Server hat eine Dauerfreigabe aufgelöst, die diese Anfrage
 *   deckt. Nur er kann das: Rollen sind dem Client für fremde Communities
 *   unbekannt.
 * * `aktiv` — der Hauptschalter am Gerät. Ein physischer Notaus, der nichts
 *   vom Server weiss; er sticht immer.
 * * `geladen` — der gespeicherte Stand ist gelesen. Ein Rennen zwischen einer
 *   hereinkommenden Anfrage und dem Laden darf nicht zugunsten der Anfrage
 *   ausgehen.
 *
 * Importfrei, damit Nodes Testläufer sie laden kann.
 */
export function selbsttaetig(s: {
  geladen: boolean;
  aktiv: boolean;
  freigabe: boolean;
}): boolean {
  return s.geladen && s.aktiv && s.freigabe;
}
