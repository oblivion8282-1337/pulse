/**
 * Namen des Container-Wegs je Benutzer-Welt (aus containerBackendManager.ts
 * herausgezogen, Größen-Policy). Keine Electron-Imports.
 */

import { readdirSync } from 'node:fs';

export const CONTAINER_NAME = 'pulse-host';
export const DATA_VOLUME = 'pulse-host-data';

// ── Benutzer-Welten ─────────────────────────────────────────────────────────
// Jedes Cloud-Konto bekommt auf diesem Gerät seine EIGENE Welt: eigener
// Container-Name, eigenes Daten-Volume, eigene Env-Datei. Umgeschaltet wird
// über die Anmeldung in der Server-App (`setzeContainerWelt`) — der Container
// des abgemeldeten Benutzers wird gestoppt, sein Volume (und damit seine
// Communities) bleibt unangetastet und ist bei der nächsten Anmeldung wieder
// da. `null` = die Legacy-Welt (Suffix-los): der Bestands-Server der ersten
// Stunde gehört dem Konto, das auch die unverschlüsselten Bestands-Creds
// besitzt — so bleibt die bestehende Installation ohne Migration erhalten.
let containerWelt: string | null = null;

export function setzeContainerWelt(key: string | null): void {
  containerWelt = key;
}

export function containerName(): string {
  return CONTAINER_NAME + (containerWelt ? `-${containerWelt}` : '');
}

export function datenVolume(): string {
  return DATA_VOLUME + (containerWelt ? `-${containerWelt}` : '');
}

/** Welt-Verzeichnisname für die Env-Datei (unter userData) — dasselbe Namens-
 *  schema wie der Container der Welt. */
export function weltVerzeichnis(): string {
  return containerName();
}

/** Lief auf diesem Rechner schon einmal ein Server? Ein Welt-Verzeichnis
 *  unter userData entsteht beim ersten start() — fehlt jedes, ist dies sicher
 *  kein Bestandsrechner (Runtime-Wahl, runtimeWahl.ts). */
export function frueherGestartet(userData: string): boolean {
  try {
    return readdirSync(userData).some((n) => n.startsWith(CONTAINER_NAME));
  } catch {
    return false;
  }
}
