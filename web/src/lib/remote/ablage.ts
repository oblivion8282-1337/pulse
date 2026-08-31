/**
 * Fernsteuerung — geteilte Zwischenablage, Renderer-Hälfte.
 *
 * **Dieses Modul parst den Rahmen NICHT.** Es kennt Sitzung und Rolle und
 * reicht die Nutzlast unverändert durch: hinaus an den Gateway, herein an die
 * Plattform-Brücke. Dieselbe Linie wie „der Gateway parst Frames nicht" — und
 * derselbe Grund: das Format lebt an genau einer Stelle im Baum
 * (`streaming/pulse-ablage`). Eine zweite Prüfung hier wäre die Sprachgrenze,
 * an der das Zeigerbild schon einmal durch beide Testnetze gerutscht ist: die
 * Rust-Seite hielt die Kurzform fest, die TS-Seite verlangte die Langform,
 * beide grün, niemand sah hinüber.
 *
 * **Was hier sehr wohl passiert:** die Selbstdrosselung
 * (`ablageDrossel.ts`) — sie ist Pflicht des Senders, weil der Gateway
 * Überzähliges still verwirft.
 *
 * Rolle: **beide** Seiten tun dasselbe. Anders als bei `zeigerform.ts` (nur der
 * Host meldet) und `vorrang.ts` (nur der Host meldet) ist die Zwischenablage
 * symmetrisch — jede Seite kündigt an und jede Seite ruft ab.
 *
 * **Die Sitzungsnummer fürs Player-Fenster kommt nach.** Genau wie bei
 * `zeigerform.ts::setSenke`: die Sitzung beginnt, bevor der Steuernde ein
 * Player-Fenster offen hat, also liefert dessen Halter die Fensternummer erst
 * nach, sobald sie feststeht (`setSenke`). Beim Host bleibt sie 0 — dort gibt
 * es kein Player-Fenster, die Nummer geht dort ungenutzt durch bis zur Weiche
 * im Hauptprozess (`desktop/electron/ablageWeiche.ts`).
 */

import type { RemoteSignalKind } from '$lib/ws/handlers/types';
import { Drossel } from './ablageDrossel';
import { ablageAnPlayer, aufAblageEreignisse } from './ablagePlatform';

type SignalSender = (kind: RemoteSignalKind, data: unknown) => boolean;

class RemoteAblage {
  #sendSignal: SignalSender | null = null;
  #abmelden: (() => void) | null = null;
  #drossel = new Drossel();
  /** Sitzungsnummer des Player-Fensters, in das ein hereinkommender Rahmen
   *  geht — nur beim Steuernden gesetzt, und erst, sobald sein Fenster offen
   *  ist (s. Modulkopf). 0 = kein Fenster bekannt. */
  #fensterSitzung = 0;

  start(_rolle: 'host' | 'controller', sendSignal: SignalSender): void {
    this.#sendSignal = sendSignal;
    // Die Plattform-Brücke meldet, was ihr Ende hinausschicken will. Im
    // Browser und in einer älteren Shell gibt es sie nicht — dann bleibt es
    // still, wie überall in dieser Schicht.
    this.#abmelden = aufAblageEreignisse((data) => this.hinaus(data));
  }

  stop(): void {
    this.#abmelden?.();
    this.#abmelden = null;
    this.#sendSignal = null;
    this.#drossel = new Drossel();
  }

  /** Die Nummer des Player-Fensters nachliefern, sobald es offen ist (nur
   *  Steuernder) — s. Modulkopf. `null`/Auslassen setzt sie auf „keines". */
  setSenke(fensterSitzung: number | null): void {
    this.#fensterSitzung = fensterSitzung ?? 0;
  }

  /** Ein `remote_signal` der Art 'ablage' vom Gegenüber. Ungeprüft weiter an
   *  die Plattform — sie hat den Parser. */
  _signal(data: unknown): void {
    if (data === null || data === undefined) return;
    void ablageAnPlayer(this.#fensterSitzung, data);
  }

  /** Ein Rahmen der eigenen Seite hinaus. `false`, wenn er die Drossel nicht
   *  passiert hat oder keine Sitzung läuft — der Aufrufer wiederholt ihn
   *  dann selbst, statt ihn still zu verlieren. */
  hinaus(data: unknown): boolean {
    if (!this.#sendSignal) return false;
    if (!this.#drossel.darf(Date.now())) return false;
    return this.#sendSignal('ablage', data);
  }
}

export const remoteAblage = new RemoteAblage();
