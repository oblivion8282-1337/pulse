/**
 * Fernsteuerung — die Wachten einer Sitzung.
 *
 * Drei kleine Aufpasser, die der Session-Store (`session.svelte.ts`) je nach
 * Phase an- und abschaltet. Sie liegen hier, weil sie zusammen mehr Platz
 * einnehmen als die Zustandsmaschine selbst, und weil keiner von ihnen etwas
 * über die Zustandsmaschine wissen muss: jeder bekommt seine Verbindung und
 * seinen Rückruf herein und gibt seinen Abbruch zurück.
 *
 * Alle drei arbeiten auf einer FESTGEHALTENEN Verbindung (`GatewayConnection`),
 * nicht auf dem `gateway`-Proxy: eine Sitzung gehört zu genau dem Server, auf
 * dem sie zustande kam — der Proxy zeigt dagegen immer auf den gerade aktiven
 * (Begründung ausführlich im Store bei `#conn`).
 */

import type { GatewayConnection } from '$lib/ws/connection';

/** Jede Wacht liefert die Funktion, die sie wieder abstellt. Zweimal gerufen
 *  ist folgenlos. */
export type Abbruch = () => void;

/**
 * Platz für genau EINE laufende Wacht.
 *
 * Der Store schaltet jede seiner Wachten je nach Phase mehrfach an und aus.
 * Ohne diesen Halter braucht jede ein eigenes Feld plus ein An/Aus-Paar, das
 * dreimal wortgleich dasselbe tut: die vorige abstellen, die neue merken.
 *
 * [`an`] stellt die vorige ab, BEVOR es die neue startet — nicht danach. Sonst
 * liefen zwei Wachten kurz nebeneinander, und bei einer, die sich beim Start
 * irgendwo einträgt (`fehlerWacht`), hinge die Reihenfolge des Ab- und
 * Anmeldens am Innenleben des Abonnements.
 */
export class WachtSchalter {
  #ab: Abbruch | null = null;

  an(starten: () => Abbruch): void {
    this.aus();
    this.#ab = starten();
  }

  aus(): void {
    this.#ab?.();
    this.#ab = null;
  }
}

/**
 * Verbindung weg = Sitzung weg.
 *
 * Der Gateway beendet jede Sitzung eines abgerissenen Sockets sofort und ohne
 * Schonfrist (`cleanup_remote_on_disconnect`) — nur erfährt genau die Seite,
 * deren Socket abriss, davon nichts mehr. Ohne diese Wacht bliebe beim Host das
 * Warnbanner stehen, beim Steuernden liefe die Erfassung weiter, und der
 * Sidecar hielte alles Gedrückte fest.
 *
 * **Ereignis statt Takt.** Bis 2026-08-12 fragte diese Wacht den Zustand jede
 * Sekunde ab. Das ist ausgerechnet im Normalfall unzuverlässig: der Host spielt
 * im Vollbild, das Pulse-Fenster ist verdeckt oder minimiert, und Chromium
 * drosselt dort jeden Zeitgeber auf höchstens einen Lauf pro Minute — der erste
 * Reconnect-Backoff ist aber genau 1000 ms (`api/constants.ts`), sodass der
 * Abriss zwischen zwei Läufen komplett verschwinden konnte. Ereignisse werden
 * nicht gedrosselt, deshalb hängt die Wacht jetzt an `conn.onClose`.
 *
 * Der Zustand wird zusätzlich EINMAL sofort geprüft: die Verbindung kann
 * bereits weg sein, wenn die Wacht startet — dann käme nie ein Ereignis mehr.
 * `beiVerlust` läuft in dem Fall noch aus diesem Ruf heraus (der Aufrufer,
 * `WachtSchalter.an`, verträgt das: er räumt die vorige Wacht vorher ab).
 */
export function verbindungsWacht(
  conn: GatewayConnection | null,
  beiVerlust: () => void,
): Abbruch {
  if (!istOffen(conn)) {
    beiVerlust();
    return () => {};
  }
  const ab = conn?.onClose(beiVerlust);
  return () => ab?.();
}

/** Ein Wurf zählt als „nicht offen": die Verbindung wurde abgeräumt (abgemeldet
 *  / Server-Eintrag entfernt), und das ist für die Sitzung dasselbe wie ein
 *  Abriss. */
function istOffen(conn: GatewayConnection | null): boolean {
  try {
    return conn?.state === 'open';
  } catch {
    return false;
  }
}

/** Frist für eine unbeantwortete Anfrage. */
export function anfrageFrist(ms: number, beiAblauf: () => void): Abbruch {
  const timer = setTimeout(beiAblauf, ms);
  return () => clearTimeout(timer);
}

/**
 * Die Fernsteuerungs-Fehler (`op:'error'`, Codes 4050–4059) der übergebenen
 * Verbindung.
 *
 * NUR dieser Bereich: ein beliebiger anderer `error`-Frame (fehlgeschlagener
 * Chat-Send, Rate-Limit) würde sonst im langen Warte-auf-Consent-Fenster die
 * Anfrage fälschlich abbrechen.
 */
export function fehlerWacht(
  conn: GatewayConnection | null,
  beiFehler: (code: number, msg: string) => void,
): Abbruch {
  const ab = conn?.on((evt) => {
    if (evt.op === 'error' && evt.code >= 4050 && evt.code <= 4059) {
      beiFehler(evt.code, evt.msg);
    }
  });
  return () => ab?.();
}
