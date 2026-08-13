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
 * der Sidecar einen geltenden Vorrang einmal je Sekunde, und deshalb steht hier
 * eine Geduld, die einen verlorenen Schluss auffängt.
 */

import type { RemoteSignalKind } from '$lib/ws/handlers/types';
import { remoteP2P } from './p2p';
import { WachtSchalter, anfrageFrist } from './wachten';

type SignalSender = (kind: RemoteSignalKind, data: unknown) => boolean;
type FrameSender = (frames: string[]) => void;

/**
 * Wie lange der Steuernde ohne Auffrischung noch an einen Vorrang glaubt.
 *
 * Der Sidecar wiederholt ihn je Sekunde; drei Sekunden Schweigen heißen also,
 * dass Meldungen verlorengehen oder der Sidecar weg ist. Dann wird der Vorrang
 * als beendet behandelt — und nachgezogen. Kommt danach doch noch eine
 * Auffrischung, gilt er wieder; ein überzähliges Nachziehen behauptet nur
 * Tasten erneut, die der Host ohnehin gerade verwirft.
 *
 * (Dieser Zeitgeber ist der einzige hier, und er ist nur das Netz — der
 * Regelweg ist ereignisgetrieben. Chromium drosselt Zeitgeber in verdeckten
 * Fenstern, s. `wachten.ts`; ein spät auslösendes Netz ist hinnehmbar, ein
 * spät bemerkter Vorrang wäre es nicht.)
 */
const GEDULD_MS = 3_000;

/** Obergrenze für eine gemeldete Restzeit — die Wache hält Sekunden, nicht
 *  Tage. Schützt die Anzeige vor `Infinity` und absurden Zahlen. */
const REST_MAX_MS = 60_000;

/** Eine gemeldete Restzeit auf etwas Anzeigbares bringen. */
function restZeit(wert: unknown): number {
  if (typeof wert !== 'number' || !Number.isFinite(wert) || wert <= 0) return 0;
  return Math.min(wert, REST_MAX_MS);
}

/** Was im Statistik-Feld des Player-Fensters steht, solange der Host übernimmt. */
function anzeige(restMs: number): string {
  const sekunden = Math.max(1, Math.round(restMs / 1000));
  return `Der Streamer steuert gerade selbst (bis zu ${sekunden} s)`;
}

/** Die Meldung des Sidecars, auf das Nötige eingedampft. `null` = geht uns
 *  nichts an (etwa `input_error` — den behandelt der fail-closed-Weg). */
function ausMeldung(ev: unknown): { aktiv: boolean; restMs: number } | null {
  if (!ev || typeof ev !== 'object') return null;
  const m = ev as { ev?: unknown; state?: unknown; hold_ms?: unknown };
  if (m.ev !== 'remote_state') return null;
  if (m.state !== 'host_active' && m.state !== 'live') return null;
  return { aktiv: m.state === 'host_active', restMs: restZeit(m.hold_ms) };
}

class RemoteVorrang {
  #rolle: 'controller' | 'host' | null = null;
  #sendSignal: SignalSender | null = null;
  #sendInput: FrameSender | null = null;
  /** Abmelder der Sidecar-Ereignisse (nur beim Host gesetzt). */
  #abmelden: (() => void) | null = null;
  /**
   * Welche Stream-Plätze gerade Vorrang melden, und **bis wann** ihre Meldung
   * noch gilt.
   *
   * **Warum je Platz:** je Platz läuft ein eigener Sidecar-Prozess mit eigener
   * Wache, und alle sehen denselben Host. Ihre Meldungen kommen dicht
   * hintereinander — ein einzelner Schalter würde vom `live` des einen Platzes
   * zurückgesetzt, während der andere noch übernommen hat.
   *
   * **Warum mit Verfallszeit** (Bughunt 2026-08-14): ein Platz verließ die
   * Menge früher nur über sein eigenes `live`. Endete sein Stream *während*
   * eines Vorrangs — etwa weil der Host mit genau dieser Handbewegung den
   * zweiten Stream beendet —, kam dieses `live` nie: der Sidecar fährt herunter
   * und meldet nichts mehr. Der Vorrang klemmte dann für den Rest der Sitzung
   * auf „aktiv", die Anzeige blieb stehen, und vor allem lief das Nachziehen
   * nie wieder. Ein Platz, dessen Meldung nicht aufgefrischt wird, fällt jetzt
   * von selbst heraus.
   */
  readonly #plaetze = new Map<number, number>();
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
    const bruecke = typeof window !== 'undefined' ? window.pulse?.gsr : undefined;
    if (typeof bruecke?.onEvent !== 'function') return;
    this.#abmelden = bruecke.onEvent((ev) => this.#vomSidecar(ev));
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
    this.#plaetze.clear();
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
    const meldung = ausMeldung(ev);
    if (meldung === null || this.#rolle !== 'host') return;
    const slot = (ev as { slot?: unknown }).slot;
    // Ohne Platz in der Meldung zählt sie als Platz 0 — die Brücke hängt ihn
    // an jedes Sidecar-Ereignis an, aber darauf zu BAUEN hieße, dass eine
    // ältere Shell den Vorrang wortlos verlöre.
    const platz = typeof slot === 'number' && Number.isInteger(slot) ? slot : 0;
    const jetzt = Date.now();
    if (meldung.aktiv) {
      // Die Auffrischung kommt je Sekunde; die Restzeit plus eine Sekunde
      // Reserve ist die Zeit, nach der diese Meldung als überholt gilt.
      this.#plaetze.set(platz, jetzt + meldung.restMs + 1_000);
    } else {
      this.#plaetze.delete(platz);
    }
    // Verfallene Plätze aussortieren — hier statt in einem Zeitgeber, weil
    // Chromium Zeitgeber in verdeckten Fenstern drosselt und der Host
    // typischerweise im Vollbild spielt (s. `wachten.ts`). Solange irgendein
    // Sidecar lebt, kommt je Sekunde ein Ereignis; stirbt der letzte, bleibt
    // die Sperre stehen, bis das nächste Ereignis sie räumt — und ohne
    // laufenden Sidecar kommt ohnehin keine Eingabe mehr durch.
    for (const [p, bis] of this.#plaetze) {
      if (bis <= jetzt) this.#plaetze.delete(p);
    }

    const aktiv = this.#plaetze.size > 0;
    if (aktiv === this.#aktiv) return;
    this.#aktiv = aktiv;
    // Der Steuernde erfährt es; hier ist nichts weiter zu tun — der Host
    // bemerkt seine eigene Übernahme daran, dass sein Rechner gehorcht.
    //
    // Geht die Meldung nicht hinaus (Verbindungs-Blip), wird sie hier NICHT
    // wiederholt: das tut der Sidecar von sich aus je Sekunde, solange der
    // Vorrang gilt. Ein stiller Verlust im Gateway-Deckel heilt darüber
    // ebenfalls — deshalb steht hier nur eine Zeile fürs Protokoll.
    if (this.#sendSignal?.('vorrang', { aktiv, rest_ms: meldung.restMs }) === false) {
      console.warn('[remote-vorrang] Meldung ging nicht hinaus — der Steuernde sieht sie nicht');
    }
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
