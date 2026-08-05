/**
 * Wiedereinstieg bei anhaltendem Einfrieren — die Entscheidung, nicht ihre
 * Ausführung.
 *
 * **Die Lücke, die das schliesst.** Bis 2026-08-05 gab es für ein Einfrieren
 * MITTEN in der Wiedergabe keinen einzigen Ausweg:
 *
 * * Der Startup-Watchdog (`STALL_RECONNECT_MS` in `hqStreamManager`) entwaffnet
 *   sich dauerhaft, sobald EIN Bild dekodiert hat — genau so ist er gemeint, er
 *   soll einen kurzen Aussetzer mitten im Bild nicht bekämpfen.
 * * Der Verbindungs-Handler feuert nie, weil die PeerConnection `connected`
 *   bleibt: es kommen ja weiter Pakete, nur wird nichts mehr daraus.
 *
 * Ein Decoder, der aussteigt, fällt damit in ein Loch, aus dem ihn nichts mehr
 * herausholt. Der Zuschauer sieht ein Standbild, `framesReceived` läuft weiter,
 * und jede Kennzahl ausser dieser sieht gesund aus. Genau das Muster steht in
 * der 10-Bit-Messakte (`browser-2026-08-01-windows-av1-10bit.json`), tritt aber
 * nicht nur dort auf — ein VAAPI-/D3D11-Decoder kann aus jedem Grund aufgeben.
 *
 * **Warum eine frische Verbindung und nicht nur ein Vollbild.** Ein Vollbild
 * fordert der Browser längst selbst an (PLI), und zwar ohne Unterlass — es
 * hilft eben nicht, wenn der DECODER hin ist und nicht der Strom. Was hilft,
 * ist ein neuer Decoder, und den gibt es nur mit einer neuen PeerConnection.
 *
 * Eigene Datei, weil hier reine Politik steht (Zähler, Fristen, Grenzen) und
 * keine Zeile davon die WHEP-Sitzung kennt — `hqStreamManager` hält die
 * Verbindung, dieses Modul nur die Entscheidung.
 */
import type { StreamStats } from './whep-stats';

/**
 * Wie lange eingefroren, bevor die Sitzung erneuert wird.
 *
 * `frozen` bedeutet bereits „`framesReceived` steigt, `framesDecoded` nicht,
 * seit mindestens 2 s" (s. `whep-stats.ts`) — hier wird also noch einmal
 * gewartet, statt sofort zu handeln. Sechs Sekunden, weil kurze Aussetzer
 * (Vollbild unterwegs, Netzstoss) sich in dieser Zeit von selbst erledigen und
 * ein Neuaufbau teurer wäre als das Problem.
 */
const FREEZE_RECYCLE_SECONDS = 6;

/**
 * Wie oft höchstens. Danach eine Fehlermeldung statt eines weiteren Versuchs:
 * liegt die Ursache dauerhaft beim Zuschauer (Treiber, Bittiefe, kaputter
 * Decoder-Pfad), wäre jeder weitere Aufbau nur eine Endlosschleife — und jede
 * davon kostet den SENDER ein Vollbild, das alle anderen Zuschauer mitbezahlen.
 */
export const FREEZE_RECYCLE_MAX = 3;

/**
 * Nach so langer störungsfreier Wiedergabe zählt die Sperre wieder von vorn.
 *
 * Ohne das wäre ein Stream, der nach zwei Stunden zum dritten Mal kurz hängt,
 * endgültig verloren — obwohl die drei Ereignisse nichts miteinander zu tun
 * haben. Die Grenze soll „dieselbe Ursache immer wieder" treffen, nicht „drei
 * unabhängige Wackler an einem Abend".
 */
const FREEZE_RECYCLE_FORGET_MS = 120_000;

/** `weiter` = nichts tun, `erneuern` = neue Sitzung, `aufgeben` = Fehler. */
export type FreezeDecision = 'weiter' | 'erneuern' | 'aufgeben';

/**
 * Zählt Wiedereinstiege und entscheidet, ob noch einer erlaubt ist.
 *
 * Bewusst NICHT pro Sitzung neu angelegt: nach jedem Neuaufbau stünde die Zahl
 * wieder auf null und die Grenze griffe nie.
 */
export class FreezeRecycler {
  #recycles = 0;
  #lastRecycleAt = 0;

  /** Wie oft schon erneuert wurde — für die Log-Zeile des Aufrufers. */
  get versuche(): number {
    return this.#recycles;
  }

  decide(stats: StreamStats, now: number): FreezeDecision {
    if (!stats.frozen) {
      // Lange genug sauber gelaufen? Dann zählt die Sperre wieder von vorn.
      if (this.#recycles > 0 && now - this.#lastRecycleAt > FREEZE_RECYCLE_FORGET_MS) {
        this.#recycles = 0;
      }
      return 'weiter';
    }
    if (stats.freezeSeconds < FREEZE_RECYCLE_SECONDS) return 'weiter';
    if (this.#recycles >= FREEZE_RECYCLE_MAX) return 'aufgeben';
    this.#recycles += 1;
    this.#lastRecycleAt = now;
    return 'erneuern';
  }
}
