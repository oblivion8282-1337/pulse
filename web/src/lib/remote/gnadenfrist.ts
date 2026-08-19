/**
 * Fernsteuerung — reine Buchführung der Gnadenfrist nach einem
 * Verbindungsabriss.
 *
 * **Warum es das überhaupt gibt** (Bughunt 2026-08-19): der Gateway beendete
 * bis dahin jede laufende Fernsteuer-Sitzung, sobald der Socket EINER Seite
 * abriss — sofort, ohne jede Gnadenfrist. Auf dem gemeinsamen Remote-Dev-Stack
 * (Electron → lokales Vite als Umweg → Internet → Hetzner) passiert genau das
 * alle paar Minuten, unabhängig davon, was gerade getan wird: jeder
 * Backend-Sync auf dem Stack lädt `uvicorn --reload` neu und trennt dabei
 * JEDEN angeschlossenen Socket, ein Neustart brauchte am 2026-08-19 gemessen
 * bis zu 8 Sekunden. Eine laufende Sitzung starb an genau so einem Wackler
 * nach 37 Sekunden — nicht weil irgendetwas an der Steuerung kaputt war,
 * sondern weil die Fehlertoleranz null war.
 *
 * **Die Gegenmaßnahme läuft in zwei Hälften.** Serverseitig hält
 * `remote_reconnect_registry.py` eine Sitzung nach einem Abriss noch
 * `REMOTE_DISCONNECT_GRACE_S` offen, statt sie sofort abzubauen. Hier steht
 * die GLEICHE Frist für die Client-Seite — sie muss mindestens so lang sein,
 * sonst gibt der Client lokal auf, während der Server noch bereit wäre, den
 * Reconnect anzunehmen. Reine Rechnung mit der Uhr von außen (`jetztMs`),
 * damit der Test sie stellen kann — Muster wie `vorrangTakt.ts::VorrangBuch`,
 * aus demselben Grund: `wachten.ts` importiert `$lib/ws/connection` und ist
 * damit für Nodes Testläufer (`pnpm test:unit`, erweiterungslose
 * Laufzeit-Importe unerreichbar) nicht direkt prüfbar.
 */

/**
 * Wie lange der Client nach einem Verbindungsabriss auf einen erfolgreichen
 * Reconnect + `remote_reclaim` wartet, bevor er die Sitzung wie bisher sofort
 * beendet.
 *
 * **Muss zur Server-Frist passen** (`remote_reconnect_registry.py::
 * REMOTE_DISCONNECT_GRACE_S`, Vorgabe ebenfalls 10 s) — mit etwas Vorsprung,
 * nicht weniger: gibt der Client HIER zuerst auf, hätte der Server einen
 * Reconnect vielleicht noch angenommen, und die Sitzung stirbt trotzdem, nur
 * eine Idee später als heute. Der Vorsprung deckt die Zeit, die die
 * `remote_reclaim`-Antwort selbst noch unterwegs ist.
 *
 * **Warum 10 statt 30 (wie bei Watch-Party):** eine gehaltene Taste des
 * Steuernden bleibt am Host bis zum Ablauf der Frist wörtlich gedrückt, wenn
 * der Steuernde ausgerechnet mittendrin die Verbindung verliert und nicht
 * wiederkommt — das ist der Preis jeder Gnadenfrist hier, nicht nur dieser.
 * 10 Sekunden decken den am 2026-08-19 gemessenen schlimmsten Fall (zwei
 * `uvicorn --reload`-Läufe kurz hintereinander, 8 s bis zum Reconnect) mit
 * Rand, ohne die Taste unnötig lang hängen zu lassen.
 */
export const CLIENT_GRACE_MS = 12_000;

/** Serverseitige Frist — nur zur Dokumentation der Beziehung hier gespiegelt;
 *  die tatsächliche Zahl gilt in `remote_reconnect_registry.py`. Ein Test hält
 *  fest, dass sie unter [`CLIENT_GRACE_MS`] bleibt. */
export const SERVER_GRACE_S = 10;

/**
 * Reine Zustandsverwaltung: wann eine Gnadenfrist abläuft, und ob ein
 * verspätetes Wiederaufleben noch zählt.
 *
 * **Wiederholte Abrisse verlängern, statt die alte Frist zu Ende laufen zu
 * lassen** — flatternde Verbindungen (am 2026-08-19 im Log: mehrere Abrisse
 * binnen Sekunden) bekommen so bei jedem Versuch die volle Frist, nicht eine
 * schrumpfende. Genau das Muster, das die Sitzung retten soll.
 */
export class Gnadenfrist {
  #ablaeuftMs: number | null = null;
  /** Zählt jeden `verloren()`-Aufruf hoch — ein spät eintreffendes Ergebnis
   *  eines ÄLTEREN Reconnect-Versuchs (Generation stimmt nicht mehr) darf die
   *  Frist eines NEUEREN Abrisses nicht fälschlich beenden. */
  #generation = 0;

  /** Verbindung weg — Frist ab jetzt scharf. Liefert die Generation, mit der
   *  ein späterer [`wiederhergestellt`]/[`abgelaufen`]-Aufruf sich ausweisen
   *  muss, um noch zu zählen. */
  verloren(jetztMs: number, graceMs = CLIENT_GRACE_MS): number {
    this.#ablaeuftMs = jetztMs + graceMs;
    return ++this.#generation;
  }

  /** Erfolgreich wiederaufgelebt (Reconnect + `remote_reclaim` angenommen) —
   *  nur wirksam, wenn `generation` noch die aktuelle ist. Ein Erfolg zu einem
   *  längst durch einen neueren Abriss überholten Versuch zählt nicht: sonst
   *  löschte ein spätes Echo die Frist des Abrisses, der gerade läuft. */
  wiederhergestellt(generation: number): void {
    if (generation !== this.#generation) return;
    this.#ablaeuftMs = null;
  }

  /** Läuft gerade eine Frist? */
  get aktiv(): boolean {
    return this.#ablaeuftMs !== null;
  }

  /** Ist die Frist zu `jetztMs` abgelaufen, ohne dass ein Wiederaufleben sie
   *  gelöscht hat? Ein Aufruf ohne laufende Frist ist immer `false` — es gibt
   *  nichts, das abgelaufen sein könnte. */
  abgelaufen(jetztMs: number): boolean {
    return this.#ablaeuftMs !== null && jetztMs >= this.#ablaeuftMs;
  }
}
