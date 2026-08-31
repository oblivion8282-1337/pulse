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
import { anstossHuelle, leitungsHuelle } from './ablageHuelle';
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
  /** Die eigene Rolle dieser Sitzung. Geht an die Plattform-Brücke mit, statt
   *  im Hauptprozess aus der Sitzungsnummer geraten zu werden — ein Host, der
   *  nebenbei den Strom eines Dritten im nativen Player anschaut, trägt auch
   *  dort eine Sitzungsnummer, und daraus liesse sich fälschlich 'controller'
   *  folgern. Der Renderer kennt seine Rolle, er muss sie nicht erschliessen. */
  #rolle: 'host' | 'controller' = 'host';
  /** Lief `start()` seit dem letzten `stop()`? Verhindert, dass ein `stop()`
   *  ohne vorausgehenden `start()` (z. B. beim Aufräumen einer nie aktiv
   *  gewordenen Sitzung) der eigenen Plattform ein Eigentum meldet, das sie
   *  nie hatte. */
  #aktiv = false;

  start(rolle: 'host' | 'controller', sendSignal: SignalSender): void {
    this.#rolle = rolle;
    this.#sendSignal = sendSignal;
    this.#aktiv = true;
    // Die Plattform-Brücke meldet, was ihr Ende hinausschicken will. Im
    // Browser und in einer älteren Shell gibt es sie nicht — dann bleibt es
    // still, wie überall in dieser Schicht.
    this.#abmelden = aufAblageEreignisse((data) => this.hinaus(data));
  }

  stop(): void {
    if (this.#aktiv) {
      // Anstoss nach unten, nie über die Leitung: Eigentum abgeben und den
      // gemerkten Vorbestand zurückschreiben (`Eigentum::freigeben`). Ohne
      // das bliebe die lokale Ablage des Nutzers leer, obwohl die Sitzung
      // vorbei ist — genau der Schaden, gegen den der Vorbestand-Mechanismus
      // gebaut wurde.
      void ablageAnPlayer(this.#rolle, this.#fensterSitzung, anstossHuelle('ende'));
    }
    this.#abmelden?.();
    this.#abmelden = null;
    this.#sendSignal = null;
    this.#drossel = new Drossel();
    this.#aktiv = false;
  }

  /** Anstoss nach unten, nie über die Leitung: nach einem geglückten Reclaim
   *  den eigenen Stand erneut ankündigen. `pulse-ablage` kennt diesen Rahmen
   *  nicht — er geht nie an die Gegenseite, nur an die eigene Plattform.
   *
   *  Ohne diesen Ruf hält die Gegenseite ein Versprechen auf eine Generation,
   *  die hier nach dem Reclaim niemand mehr kennt: jedes Einfügen antwortete
   *  danach `veraltet`, und die Ablage wäre für den Rest der Sitzung still
   *  tot. */
  neuBitte(): void {
    if (!this.#aktiv) return;
    void ablageAnPlayer(this.#rolle, this.#fensterSitzung, anstossHuelle('neu_bitte'));
  }

  /** Die Nummer des Player-Fensters nachliefern, sobald es offen ist (nur
   *  Steuernder) — s. Modulkopf. `null`/Auslassen setzt sie auf „keines".
   *
   *  **Es genügt IRGENDEIN Fenster dieser Sitzung.** Welche Sitzung die Ablage
   *  hält, entscheidet der Player selbst (`App::ablage` löst auf
   *  `ablage_traeger` auf) — hier wird nur zugestellt. Vorher zeigte diese
   *  Nummer auf das erste Fenster und traf den Träger nur, solange dessen
   *  Erfassung geglückt war; scheiterte sie für genau dieses Fenster, lief
   *  jeder hereinkommende Rahmen ins Leere („Einfügen tut nichts, Kopieren
   *  schon").
   *
   *  **Offen für 1b-2:** ein `neu` der Gegenseite, das VOR dem ersten
   *  `setSenke` eintrifft, ist unwiederbringlich verloren (`session 0` kennt
   *  der Player nicht). Heute folgenlos, weil die Host-Seite noch fehlt und
   *  vor dem Player-Fenster niemand ankündigt — mit dem Host-Sidecar aus
   *  Plan 1b-2 wird es scharf und ist dort zu lösen, nicht hier. */
  setSenke(fensterSitzung: number | null): void {
    this.#fensterSitzung = fensterSitzung ?? 0;
  }

  /** Ein `remote_signal` der Art 'ablage' vom Gegenüber. Ungeprüft weiter an
   *  die Plattform — sie hat den Parser.
   *
   *  **In der Leitungs-Hülle**, und das ist der ganze Schutz: die Nutzlast
   *  liegt danach unter `rahmen`, wo ein interner Anstoss nie steht. Ohne sie
   *  ginge die rohe `data` der Gegenstelle durch dieselbe Tür wie `neuBitte`
   *  und `stop` — ein fremdes `{"t":"ende"}` schaltete die Zwischenablage für
   *  den Rest der Sitzung ab (s. `ablageHuelle.ts`). */
  _signal(data: unknown): void {
    if (data === null || data === undefined) return;
    void ablageAnPlayer(this.#rolle, this.#fensterSitzung, leitungsHuelle(data));
  }

  /** Ein Rahmen der eigenen Seite hinaus. `false`, wenn er die Drossel nicht
   *  passiert hat oder keine Sitzung läuft.
   *
   *  **Der Rückgabewert ist eine Auskunft, kein Auftrag zum Wiederholen** —
   *  und das ist hier die Wahrheit statt einer Absichtserklärung: der einzige
   *  Aufrufer ist die Rückmeldung der Plattform-Brücke (`start`), und die
   *  kann einen Rahmen nicht noch einmal erzeugen. Ein abgelehnter Rahmen ist
   *  damit endgültig weg.
   *
   *  **Deshalb sitzt die Vorsorge in der Drossel, nicht hier:** sie lässt eine
   *  ganze Lieferung durch, statt sie in der Mitte zu zerschneiden (s.
   *  `ablageDrossel.ts`). Fällt ein Stück, ist nicht ein Stück weg, sondern
   *  die ganze Lieferung — drüben läuft dann `ABRUF_FRIST` (2 s) voll, und auf
   *  Windows und macOS steht das einfügende Programm diese 2 s. */
  hinaus(data: unknown): boolean {
    if (!this.#sendSignal) return false;
    if (!this.#drossel.darf(Date.now())) return false;
    return this.#sendSignal('ablage', data);
  }
}

export const remoteAblage = new RemoteAblage();
