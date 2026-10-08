/**
 * Grenzen für die Host-Relays (udpRelay.ts, udpGateway.ts): je Absender
 * entsteht dort ein eigener Socket bzw. eine eigene TCP-Verbindung. Ohne
 * Obergrenze genügt eine Paketflut mit wechselnden Absenderports aus dem LAN,
 * um die Ephemeral-Ports des Hosts zu erschöpfen (Windows: ~16 000 im
 * Vorgabebereich 49152–65535) — danach bekäme auch der Rest des Rechners
 * keine ausgehende Verbindung mehr.
 *
 * Zwei Riegel: eine Peer-Obergrenze je Listener (älteste Pipe weicht, LRU)
 * und eine Bremse für NEUE Peers je Quell-IP und Sekunde. Die Zahlen sind
 * Schätzungen, nicht gemessen: ein Raum mit vielen Teilnehmern braucht je
 * Teilnehmer und Port EINE Pipe, ein ICE-Lauf je Gerät eine Handvoll neue
 * Peers in der ersten Sekunde. Keine Electron-Imports.
 */

/** Höchstzahl gleichzeitiger Peers je Listener. */
export const MAX_PEERS = 256;
/** Höchstzahl NEUER Peers je Quell-IP innerhalb eines Fensters. */
export const MAX_NEUE_PEERS_JE_IP = 32;
export const BREMSFENSTER_MS = 1_000;

/** Zählt neue Peers je Quell-IP in einem festen Zeitfenster. */
export class NeuePeerBremse {
  private fenster = new Map<string, { start: number; anzahl: number }>();
  private readonly max: number;
  private readonly fensterMs: number;
  constructor(max = MAX_NEUE_PEERS_JE_IP, fensterMs = BREMSFENSTER_MS) {
    this.max = max;
    this.fensterMs = fensterMs;
  }

  /** true = darf einen neuen Peer anlegen. */
  erlaube(ip: string, jetzt = Date.now()): boolean {
    const f = this.fenster.get(ip);
    if (!f || jetzt - f.start >= this.fensterMs) {
      // Alte Fenster mit abräumen, damit die Map nicht selbst zur Flut wird.
      if (this.fenster.size > 1024) {
        for (const [k, v] of this.fenster) if (jetzt - v.start >= this.fensterMs) this.fenster.delete(k);
      }
      this.fenster.set(ip, { start: jetzt, anzahl: 1 });
      return true;
    }
    if (f.anzahl >= this.max) return false;
    f.anzahl += 1;
    return true;
  }
}

/** Legt `wert` unter `key` an; ist die Map voll, weicht der älteste Eintrag
 *  (Map hält Einfügereihenfolge — `beruehre` schiebt einen Treffer ans Ende).
 *  Liefert den verdrängten Wert zum Schließen zurück. */
export function lruEinfuegen<V>(map: Map<string, V>, key: string, wert: V, max = MAX_PEERS): V | null {
  let verdraengt: V | null = null;
  if (map.size >= max) {
    const aeltester = map.keys().next();
    if (!aeltester.done) {
      verdraengt = map.get(aeltester.value) ?? null;
      map.delete(aeltester.value);
    }
  }
  map.set(key, wert);
  return verdraengt;
}

/** Treffer ans Ende schieben (zuletzt benutzt). */
export function beruehre<V>(map: Map<string, V>, key: string, wert: V): void {
  map.delete(key);
  map.set(key, wert);
}

/** Log-Drossel: höchstens eine Zeile je Schlüssel und Intervall. Für
 *  Laufzeitfehler der Listener (ENETUNREACH nach WLAN-Wechsel/Resume kommt
 *  sonst für jedes einzelne Paket). */
export function gedrosselt(
  log: (msg: string) => void,
  intervallMs = 30_000,
): (schluessel: string, msg: string) => void {
  const zuletzt = new Map<string, number>();
  return (schluessel, msg) => {
    const jetzt = Date.now();
    const t = zuletzt.get(schluessel);
    if (t !== undefined && jetzt - t < intervallMs) return;
    zuletzt.set(schluessel, jetzt);
    log(msg);
  };
}
