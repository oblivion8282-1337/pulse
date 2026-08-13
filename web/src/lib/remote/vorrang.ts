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
 * * **Host:** hört die `remote_state`-Meldungen seines Sidecars mit (die kommen
 *   über dieselbe Brücke wie alle Sidecar-Ereignisse) und schickt jeden Wechsel
 *   als `remote_signal` an den Steuernden.
 * * **Steuernder:** zeigt den Vorrang im Statistik-Feld an — ohne diese Auskunft
 *   sieht er wie ein Verbindungsabbruch aus — und **zieht beim Ende das
 *   Gehaltene nach**.
 *
 * ## Warum das Nachziehen sein muss
 *
 * Über die Leitung gehen Ereignisse, keine Zustände. Hält der Steuernde W, ging
 * dafür genau ein „W runter" hinaus; der Host gibt beim Übernehmen alles frei
 * (sonst liefe die Figur weiter, während er selbst arbeitet). Danach ist am Host
 * nichts gedrückt, am Rechner des Steuernden liegt der Finger aber weiter auf W
 * — und weil sich für den Finger nichts geändert hat, entsteht dort auch kein
 * neues Ereignis. Ohne Nachziehen bliebe die Taste tot, bis der Nutzer sie
 * loslässt und neu drückt.
 *
 * Was gehalten wird, weiß die Buchführung des Eingabewegs (`buchfuehrung.ts`) —
 * sie bucht, was WIRKLICH hinausging, auch die während des Vorrangs verworfenen
 * Nachrichten. Wer währenddessen losgelassen hat, steht dort nicht mehr drin.
 *
 * ## Warum der Signalweg
 *
 * Der DataChannel des Eingabewegs ist eine Einbahnstraße (Steuernder → Host).
 * Der `remote_signal`-Weiterleiter des Gateways trägt dagegen in beide
 * Richtungen, ist an die per Consent bestätigte Sitzung gebunden und
 * gedeckelt — für zwei Nachrichten je Übernahme genau richtig.
 */

import type { RemoteSignalKind } from '$lib/ws/handlers/types';
import { remoteP2P } from './p2p';

type SignalSender = (kind: RemoteSignalKind, data: unknown) => boolean;
type FrameSender = (frames: string[]) => void;

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
  return {
    aktiv: m.state === 'host_active',
    restMs: typeof m.hold_ms === 'number' && m.hold_ms > 0 ? m.hold_ms : 0,
  };
}

class RemoteVorrang {
  #rolle: 'controller' | 'host' | null = null;
  #sendSignal: SignalSender | null = null;
  #sendInput: FrameSender | null = null;
  /** Abmelder der Sidecar-Ereignisse (nur beim Host gesetzt). */
  #abmelden: (() => void) | null = null;
  /**
   * Welche Stream-Plätze gerade Vorrang melden.
   *
   * **Warum eine Menge und kein Schalter:** je Platz läuft ein eigener
   * Sidecar-Prozess mit eigener Wache, und alle sehen denselben Host. Ihre
   * Meldungen kommen dicht hintereinander — ein einzelner Schalter würde vom
   * `live` des einen Platzes zurückgesetzt, während der andere noch
   * übernommen hat, und die Anzeige flackerte. „Vorrang gilt, solange
   * irgendein Platz ihn meldet" ist die sichere Lesart.
   */
  readonly #plaetze = new Set<number>();
  #aktiv = false;

  /** Gilt gerade ein Vorrang? Für die Anzeige an anderer Stelle. */
  get aktiv(): boolean {
    return this.#aktiv;
  }

  /** Mit dem Übergang der Sitzung nach 'active' rufen — wie `remoteP2P.start`. */
  start(
    rolle: 'controller' | 'host',
    sendSignal: SignalSender,
    sendInput: FrameSender,
  ): void {
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
    // Die übernommene Anzeige selbst zurückgeben, statt sich darauf zu
    // verlassen, dass `remoteP2P.stop()` vorher lief: endete eine Sitzung
    // mitten in einem Vorrang, bliebe sonst „Der Streamer steuert gerade
    // selbst" über der nächsten stehen.
    if (this.#aktiv && this.#rolle === 'controller') remoteP2P.anzeigeUebernehmen(null);
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
    const restMs = typeof d.rest_ms === 'number' && d.rest_ms > 0 ? d.rest_ms : 0;
    this.#setzen(d.aktiv, restMs);
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
    if (meldung.aktiv) this.#plaetze.add(platz);
    else this.#plaetze.delete(platz);

    const aktiv = this.#plaetze.size > 0;
    if (aktiv === this.#aktiv) return;
    this.#aktiv = aktiv;
    // Der Steuernde erfährt es; hier ist nichts weiter zu tun — der Host
    // bemerkt seine eigene Übernahme daran, dass sein Rechner gehorcht.
    //
    // Geht die Meldung nicht hinaus (Verbindungs-Blip), wird sie NICHT
    // wiederholt: der Vorrang selbst hängt nicht an ihr — er wirkt im Sidecar —,
    // und ein echter Abriss beendet die Sitzung ohnehin über die
    // Verbindungswacht. Verloren wäre nur die Anzeige und, beim Ende, das
    // Nachziehen einer gehaltenen Taste. Das gehört ins Log, nicht in eine
    // Wiederholungsschleife, die im schlimmsten Fall gegen einen toten Socket
    // läuft.
    if (this.#sendSignal?.('vorrang', { aktiv, rest_ms: meldung.restMs }) === false) {
      console.warn('[remote-vorrang] Meldung ging nicht hinaus — der Steuernde sieht sie nicht');
    }
  }

  // ── Steuernden-Seite ──────────────────────────────────────────────────────

  #setzen(aktiv: boolean, restMs: number): void {
    if (aktiv === this.#aktiv) return;
    this.#aktiv = aktiv;
    remoteP2P.anzeigeUebernehmen(aktiv ? anzeige(restMs) : null);
    if (aktiv) {
      console.info('[remote-vorrang] Der Host hat übernommen — Eingabe wird verworfen');
      return;
    }
    console.info('[remote-vorrang] Der Host gibt wieder frei — Gehaltenes wird nachgezogen');
    // Nachziehen, was der Nutzer noch physisch hält (s. Modulkopf). Ohne
    // gehaltene Tasten ist die Liste leer und es geht nichts hinaus.
    for (const buendel of remoteP2P.nachziehBuendel()) this.#sendInput?.(buendel);
  }
}

export const remoteVorrang = new RemoteVorrang();
