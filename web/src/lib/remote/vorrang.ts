/**
 * Fernsteuerung — **Vorrang des Hosts**: der Streamer behält das letzte Wort.
 *
 * Regt sich der Host selbst an Maus oder Tastatur, verwirft sein Sidecar die
 * Fremdeingabe, bis er einige Sekunden Ruhe gegeben hat
 * (`streaming/win-hq-sidecar/src/remote_input/wache.rs`). Die Sitzung läuft
 * dabei weiter — es ist ein Stummschalten, kein Abbruch.
 *
 * Dieses Modul ist der Weg von dort zum Steuernden, und er hat zwei Hälften:
 *
 * * **Host:** hört die `remote_state`-Meldungen seiner Sidecars mit (die kommen
 *   über dieselbe Brücke wie alle Sidecar-Ereignisse), führt sie über alle
 *   Stream-Plätze zusammen und schickt jeden Wechsel als `remote_signal` an den
 *   Steuernden. **Und er sperrt selbst**: solange irgendein Platz Vorrang
 *   meldet, kommt gar keine Fremdeingabe mehr durch (s. unten).
 * * **Steuernder:** zeigt den Vorrang im Statistik-Feld an — ohne diese Auskunft
 *   sieht er wie ein Verbindungsabbruch aus — und **zieht beim Ende das
 *   Gehaltene nach**.
 *
 * ## Warum der Host zusätzlich selbst sperrt
 *
 * Die Wache sitzt im Sidecar, und Windows fährt **je Stream-Platz einen eigenen
 * Sidecar-Prozess**. Jeder stellt seine Wache erst auf, wenn er sein erstes
 * Hello sieht. Ein Steuernder, der am `vorrang`-Signal auf die Millisekunde
 * genau erfährt, wann der Host eingreift, könnte deshalb auf einen Platz
 * ausweichen, dessen Wache noch gar nicht steht — und dort die Restzeit des
 * Fensters weiterarbeiten, auf dem Bildschirm, auf den der Host gerade nicht
 * schaut (Bughunt 2026-08-14). Die Zusage lautet aber „der Host behält seinen
 * **Rechner**", nicht „diesen einen Bildschirm". Deshalb liegt hier eine
 * maschinenweite Sperre über allen Plätzen; die Sidecars bleiben die
 * fail-closed-Grenze je Platz, diese Stelle bindet sie zusammen.
 *
 * ## Warum das Nachziehen sein muss
 *
 * Über die Leitung gehen Ereignisse, keine Zustände. Hält der Steuernde W, ging
 * dafür genau ein „W runter" hinaus; der Host gibt beim Übernehmen alles frei
 * (sonst liefe die Figur weiter, während er selbst arbeitet). Danach entsteht
 * beim Steuernden kein neues Ereignis, weil sich für seinen Finger nichts
 * geändert hat — die Taste bliebe tot, bis er sie loslässt und neu drückt.
 *
 * Was gehalten wird, weiß die Buchführung des Eingabewegs (`buchfuehrung.ts`).
 *
 * ## Warum der Signalweg
 *
 * Der DataChannel des Eingabewegs ist eine Einbahnstraße (Steuernder → Host).
 * Der `remote_signal`-Weiterleiter des Gateways trägt dagegen in beide
 * Richtungen und ist an die per Consent bestätigte Sitzung gebunden. Er
 * verwirft allerdings über seinem Sekundendeckel **still** — deshalb wiederholt
 * der Sidecar einen geltenden Vorrang einmal je Sekunde, deshalb **reicht der
 * Host diese Wiederholung durch** (gedeckelt, s. [`./vorrangTakt`]) statt sie
 * am Flankenfilter zu verschlucken, und deshalb steht hier eine Geduld, die
 * einen verlorenen Schluss auffängt.
 */

import type { RemoteSignalKind } from '$lib/ws/handlers/types';
import { remoteP2P } from './p2p';
import { aufSidecarEreignisse } from './sidecarInput';
import { VorrangBuch, hostMeldungWeiterreichen, restZeit } from './vorrangTakt';
import { WachtSchalter, anfrageFrist } from './wachten';

type SignalSender = (kind: RemoteSignalKind, data: unknown) => boolean;
type FrameSender = (frames: string[]) => void;

/**
 * Wie lange der Steuernde ohne Auffrischung noch an einen Vorrang glaubt.
 *
 * **Gerechnet wird mit dem Takt des SENDERS, nicht mit dem Deckel des Hosts.**
 * Der Sidecar wiederholt einen geltenden Vorrang je Sekunde
 * (`vorrangTakt.ts::SIDECAR_TAKT_MS`); `AUFFRISCH_MS` (0,9 s) begrenzt das
 * Durchreichen nur nach oben und macht daraus keine 0,9 s. Zwei verlorene
 * Auffrischungen ergeben deshalb ein Schweigen von 3 × 1 s — mit den früheren
 * 3 s Geduld war das exakt der Grenzfall, und `vorrang.rs::tick()` überspringt
 * seinen Zähler zusätzlich, wenn die Sitzungssperre gerade belegt ist, der
 * Abstand wächst unter Eingabelast also über eine Sekunde. Vier Sekunden
 * lassen zwei Verluste sicher durchgehen.
 *
 * **Nach oben ist sie auch nicht frei:** sie ist die Zeit, die ein Steuernder
 * im schlimmsten Fall fälschlich für gesperrt hält, nachdem der Host längst
 * freigegeben hat. Deshalb eine Sekunde Reserve und nicht fünf.
 *
 * Läuft sie ab, gilt der Vorrang als beendet — und wird nachgezogen. Kommt
 * danach doch noch eine Auffrischung, gilt er wieder; ein überzähliges
 * Nachziehen behauptet nur Tasten erneut, die der Host ohnehin gerade
 * verwirft.
 *
 * (Dieser Zeitgeber ist der einzige hier, und er ist nur das Netz — der
 * Regelweg ist ereignisgetrieben. Chromium drosselt Zeitgeber in verdeckten
 * Fenstern, s. `wachten.ts`; ein spät auslösendes Netz ist hinnehmbar, ein
 * spät bemerkter Vorrang wäre es nicht.)
 */
const GEDULD_MS = 4_000;

/** Was im Statistik-Feld des Player-Fensters steht, solange der Host übernimmt. */
function anzeige(restMs: number): string {
  const sekunden = Math.max(1, Math.round(restMs / 1000));
  return `Der Streamer steuert gerade selbst (bis zu ${sekunden} s)`;
}

class RemoteVorrang {
  #rolle: 'controller' | 'host' | null = null;
  #sendSignal: SignalSender | null = null;
  #sendInput: FrameSender | null = null;
  /** Abmelder der Sidecar-Ereignisse (nur beim Host gesetzt). */
  #abmelden: (() => void) | null = null;
  /**
   * Die Plätze, die gerade Vorrang melden, samt Sendetakt — reine Rechnung,
   * deshalb nebenan und prüfbar ([`./vorrangTakt`]).
   */
  readonly #buch = new VorrangBuch();
  #aktiv = false;
  /** Netz für einen verlorenen Schluss (s. [`GEDULD_MS`]), nur beim Steuernden. */
  readonly #geduld = new WachtSchalter();

  /**
   * Gilt gerade ein Vorrang?
   *
   * Beim Host ist das die **maschinenweite Sperre**: `handlers/remote.ts` lässt
   * daran keine Fremdeingabe mehr durch, gleich für welchen Platz.
   */
  get aktiv(): boolean {
    return this.#aktiv;
  }

  /** Mit dem Übergang der Sitzung nach 'active' rufen — wie `remoteP2P.start`. */
  start(rolle: 'controller' | 'host', sendSignal: SignalSender, sendInput: FrameSender): void {
    this.stop();
    this.#rolle = rolle;
    this.#sendSignal = sendSignal;
    this.#sendInput = sendInput;
    if (rolle !== 'host') return;
    this.#abmelden = aufSidecarEreignisse((ev) => this.#vomSidecar(ev));
  }

  /** Sitzungsende — der eine Ausgang, wie bei `remoteP2P.stop`. */
  stop(): void {
    // Die übernommene Anzeige selbst zurückgeben. `#reset` ruft dieses `stop`
    // VOR `remoteP2P.stop()`, damit hier noch der echte Eingabeweg-Text
    // dahinter steht — andersherum bekäme der Steuernde eine leere Anzeige
    // (Bughunt 2026-08-14).
    if (this.#aktiv && this.#rolle === 'controller') remoteP2P.anzeigeUebernehmen(null);
    this.#geduld.aus();
    this.#abmelden?.();
    this.#abmelden = null;
    this.#rolle = null;
    this.#sendSignal = null;
    this.#sendInput = null;
    this.#buch.leeren();
    this.#aktiv = false;
  }

  /**
   * Ein `remote_signal` der Art 'vorrang' vom Gegenüber (Zuordnung zur Sitzung
   * prüft der Handler).
   *
   * **Nur der Steuernde hört zu.** Der Host ist die Quelle dieser Auskunft;
   * ein 'vorrang' in seine Richtung kann nur aus einem selbstgebauten Client
   * kommen und hat dort nichts zu bestellen.
   */
  _signal(data: unknown): void {
    if (this.#rolle !== 'controller') return;
    if (!data || typeof data !== 'object') return;
    const d = data as { aktiv?: unknown; rest_ms?: unknown };
    if (typeof d.aktiv !== 'boolean') return;
    this.#setzen(d.aktiv, restZeit(d.rest_ms));
  }

  // ── Host-Seite ────────────────────────────────────────────────────────────

  #vomSidecar(ev: unknown): void {
    // Hier steht bewusst KEINE Bedingung mehr ausser der Rolle: die
    // Entscheidung, ob eine Meldung hinausgeht, liegt vollständig in
    // [`hostMeldungWeiterreichen`] — dort ist sie geprüft. Vorher stand sie
    // hier, und ein wieder eingesetzter Flankenfilter blieb von allen Tests
    // unbemerkt (Prüferbefund 2026-08-19). `vorrang-takt.test.ts` hält diese
    // Verdrahtung jetzt fest.
    if (this.#rolle !== 'host') return;
    const aktiv = hostMeldungWeiterreichen(
      this.#buch,
      ev,
      Date.now(),
      (signal) => this.#sendSignal?.('vorrang', signal) !== false,
    );
    if (aktiv !== null) this.#aktiv = aktiv;
  }

  // ── Steuernden-Seite ──────────────────────────────────────────────────────

  #setzen(aktiv: boolean, restMs: number): void {
    // Die Geduld wird bei JEDER Auffrischung neu gestellt, auch wenn sich am
    // Zustand nichts ändert — sie misst das Schweigen, nicht den Wechsel.
    if (aktiv) {
      this.#geduld.an(() =>
        anfrageFrist(GEDULD_MS, () => {
          console.info('[remote-vorrang] keine Auffrischung mehr — Vorrang gilt als beendet');
          this.#setzen(false, 0);
        }),
      );
    } else {
      this.#geduld.aus();
    }
    if (aktiv === this.#aktiv) return;
    this.#aktiv = aktiv;
    remoteP2P.anzeigeUebernehmen(aktiv ? anzeige(restMs) : null);
    if (aktiv) {
      console.info('[remote-vorrang] Der Host hat übernommen — Eingabe wird verworfen');
      return;
    }
    console.info('[remote-vorrang] Der Host gibt wieder frei — Gehaltenes wird nachgezogen');
    // Den gehaltenen Zustand erneut behaupten. Denselben Baustein benutzt der
    // Rückfall auf den Serverweg (`session.svelte.ts::sendInput`): auch dort
    // gibt ein Hello beim Host alles frei.
    for (const buendel of remoteP2P.nachziehBuendel()) this.#sendInput?.(buendel);
  }
}

export const remoteVorrang = new RemoteVorrang();
