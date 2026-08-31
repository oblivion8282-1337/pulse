/**
 * Fernsteuerung — geteilte Zwischenablage, Renderer-Hälfte.
 *
 * **Dieses Modul parst den Rahmen NICHT.** Es kennt Sitzung, Rolle und
 * Träger-Platz und reicht die Nutzlast unverändert durch: hinaus an den
 * Gateway, herein an die Plattform-Brücke. Dieselbe Linie wie „der Gateway
 * parst Frames nicht" — und derselbe Grund: das Format lebt an genau einer
 * Stelle im Baum (`streaming/pulse-ablage`). Eine zweite Prüfung hier wäre die
 * Sprachgrenze, an der das Zeigerbild schon einmal durch beide Testnetze
 * gerutscht ist: die Rust-Seite hielt die Kurzform fest, die TS-Seite
 * verlangte die Langform, beide grün, niemand sah hinüber.
 *
 * **Drei Dinge passieren hier sehr wohl**, und alle drei, weil sie nur hier
 * entscheidbar sind:
 *
 * 1. die Selbstdrosselung (`ablageDrossel.ts`) — Pflicht des Senders, weil der
 *    Gateway Überzähliges still verwirft;
 * 2. die **Trägerwahl** (`ablageTraeger.ts`) — auf dem Host läuft ein
 *    Sidecar-Prozess je Stream-Platz, die Zwischenablage ist maschinenweit,
 *    und nur hier laufen die Plätze zusammen (dieselbe Auflösung wie beim
 *    Vorrang);
 * 3. der **Vorhalt** (`ablageVorhalt.ts`) — was eintrifft, bevor es ein Ziel
 *    gibt, wartet, statt verloren zu gehen.
 *
 * Rolle: **beide** Seiten tun dasselbe. Anders als bei `zeigerform.ts` (nur der
 * Host meldet) und `vorrang.ts` (nur der Host meldet) ist die Zwischenablage
 * symmetrisch — jede Seite kündigt an und jede Seite ruft ab. Verschieden ist
 * nur, WO die eigene Hälfte läuft: beim Steuernden im Player-Fenster, beim
 * Host im Sidecar des Träger-Platzes.
 */

import type { RemoteSignalKind } from '$lib/ws/handlers/types';
import { Drossel } from './ablageDrossel';
import { anstossHuelle, leitungsHuelle } from './ablageHuelle';
import { ablageAnPlattform, aufAblageEreignisse } from './ablagePlatform';
import { traegerWaehlen } from './ablageTraeger';
import { Vorhalt } from './ablageVorhalt';
import { WachtSchalter } from './wachten';

type SignalSender = (kind: RemoteSignalKind, data: unknown) => boolean;

/**
 * Wie oft der Host nachsieht, ob sein Träger-Stream noch läuft.
 *
 * **Nur das Netz, nicht der Regelweg.** Der Regelweg ist ereignisgetrieben:
 * jeder hereinkommende Rahmen prüft den Träger mit. Dieser Takt deckt den
 * einen Fall ab, in dem gar nichts fliesst — der Träger-Stream endet, und
 * anschliessend kopiert der Host etwas, ohne dass die Gegenseite vorher
 * gesendet hätte. Ohne ihn bliebe das unangekündigt, bis das nächste Mal etwas
 * hereinkommt.
 *
 * **Chromium drosselt Zeitgeber in verdeckten Fenstern auf einen Lauf je
 * Minute**, und der Host spielt womöglich im Vollbild (dieselbe Falle wie in
 * `wachten.ts`). Ein spät bemerkter Trägerwechsel kostet eine verspätete
 * Ankündigung — die Richtung des Irrtums ist damit die richtige: es wird
 * weniger geteilt als möglich, nie mehr.
 */
const TRAEGER_TAKT_MS = 2_000;

class RemoteAblage {
  #sendSignal: SignalSender | null = null;
  #abmelden: (() => void) | null = null;
  #drossel = new Drossel();
  /** Sitzungsnummer des Player-Fensters, in das ein hereinkommender Rahmen
   *  geht — nur beim Steuernden gesetzt, und erst, sobald sein Fenster offen
   *  ist. 0 = kein Fenster bekannt. */
  #fensterSitzung = 0;
  /** Stream-Platz des Sidecars, der beim Host die Ablage hält. `null` = keiner
   *  (kein Stream läuft). */
  #traeger: number | null = null;
  /** Welche Stream-Plätze gerade laufen — hereingereicht, nicht importiert:
   *  die Fernsteuerung soll nichts über den Streaming-Zustand wissen müssen
   *  ausser dieser einen Zahlenliste. */
  #plaetze: () => number[] = () => [];
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
  /** Was hereinkam, bevor es ein Ziel gab (s. `ablageVorhalt.ts`). */
  readonly #vorhalt = new Vorhalt();
  /** Der Takt, der den Träger nachhält (nur Host, s. [`TRAEGER_TAKT_MS`]). */
  readonly #wacht = new WachtSchalter();

  /**
   * `plaetze` liefert die gerade laufenden Stream-Plätze
   * (`$lib/stream/state.svelte::runningStreamSlots`) und wird **nur beim Host**
   * gebraucht. Hereingereicht statt importiert, damit dieses Modul nicht am
   * Streaming-Zustand hängt — dieselbe Zurückhaltung wie bei
   * `remoteInputHost.ts::belegt`.
   */
  start(rolle: 'host' | 'controller', sendSignal: SignalSender, plaetze?: () => number[]): void {
    this.#rolle = rolle;
    this.#sendSignal = sendSignal;
    this.#plaetze = plaetze ?? (() => []);
    this.#aktiv = true;
    // Die Plattform-Brücke meldet, was ihr Ende hinausschicken will. Im
    // Browser und in einer älteren Shell gibt es sie nicht — dann bleibt es
    // still, wie überall in dieser Schicht.
    this.#abmelden = aufAblageEreignisse(rolle, (data, slot) => this.#vonUnten(data, slot));
    if (rolle !== 'host') return;
    this.#traegerPruefen();
    this.#wacht.an(() => {
      const takt = setInterval(() => this.#traegerPruefen(), TRAEGER_TAKT_MS);
      return () => clearInterval(takt);
    });
  }

  stop(): void {
    if (this.#aktiv && this.#zielBekannt()) {
      // Anstoss nach unten, nie über die Leitung: Eigentum abgeben und den
      // gemerkten Vorbestand zurückschreiben (`Eigentum::freigeben`). Ohne
      // das bliebe die lokale Ablage des Nutzers leer, obwohl die Sitzung
      // vorbei ist — genau der Schaden, gegen den der Vorbestand-Mechanismus
      // gebaut wurde.
      void this.#hinunter(anstossHuelle('ende'));
    }
    this.#wacht.aus();
    this.#abmelden?.();
    this.#abmelden = null;
    this.#sendSignal = null;
    this.#drossel = new Drossel();
    this.#plaetze = () => [];
    this.#traeger = null;
    // Was noch wartet, gehört einer Sitzung, die es nicht mehr gibt.
    this.#vorhalt.leeren();
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
    void this.#hinunter(anstossHuelle('neu_bitte'));
  }

  /** Die Nummer des Player-Fensters nachliefern, sobald es offen ist (nur
   *  Steuernder). `null`/Auslassen setzt sie auf „keines".
   *
   *  **Es genügt IRGENDEIN Fenster dieser Sitzung.** Welche Sitzung die Ablage
   *  hält, entscheidet der Player selbst (`App::ablage` löst auf
   *  `ablage_traeger` auf) — hier wird nur zugestellt.
   *
   *  **Und hier wird der Vorhalt zugestellt** (Befund aus Plan 1b-1): die
   *  Fernsteuerungs-Sitzung beginnt, bevor der Steuernde ein Player-Fenster
   *  hat. Ein `neu` des Hosts, das in dieses Fenster fällt, ging bis 1b-1 an
   *  Sitzung 0 und war unwiederbringlich weg — nachfragen lässt es sich nicht,
   *  weil `neu_bitte` lokal ist. */
  setSenke(fensterSitzung: number | null): void {
    this.#fensterSitzung = fensterSitzung ?? 0;
    if (this.#zielBekannt()) this.#vorhaltZustellen();
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
    // Der Regelweg der Trägerwahl: jeder hereinkommende Rahmen sieht nach.
    if (this.#rolle === 'host') this.#traegerPruefen();
    void this.#hinunter(leitungsHuelle(data));
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
   *  **Deshalb sitzt die Vorsorge in der Drossel, nicht hier:** sie lässt die
   *  Lieferung, die ihre Grenze überschreitet, am Stück durch, statt sie in
   *  der Mitte zu zerschneiden (s. `ablageDrossel.ts`) — eine je Fenster, mehr
   *  gibt der Gateway-Deckel nicht her. Fällt ein Stück, ist nicht ein Stück
   *  weg, sondern die ganze Lieferung: drüben läuft dann `ABRUF_FRIST` (2 s)
   *  voll, und auf Windows und macOS steht das einfügende Programm diese
   *  2 s. */
  hinaus(data: unknown): boolean {
    if (!this.#sendSignal) return false;
    if (!this.#drossel.darf(Date.now())) return false;
    return this.#sendSignal('ablage', data);
  }

  /** Ein Ereignis der eigenen Plattform. `slot` ist der Stream-Platz, von dem
   *  es kommt (`null` beim Player).
   *
   *  **Der Filter ist das Netz unter der Trägerwahl:** wach ist ohnehin nur
   *  der gewählte Sidecar (erst `beginn` stellt seinen Fensterfaden auf).
   *  Bliebe ein früherer Träger doch noch am Melden, kündigte er der
   *  Gegenseite einen zweiten, konkurrierenden Stand an. */
  #vonUnten(data: unknown, slot: number | null): void {
    if (this.#rolle === 'host' && slot !== null && slot !== this.#traeger) return;
    this.hinaus(data);
  }

  /** Steht fest, wohin ein Wert hinunter geht? */
  #zielBekannt(): boolean {
    return this.#rolle === 'host' ? this.#traeger !== null : this.#fensterSitzung !== 0;
  }

  /** Einen Wert an die eigene Plattform geben — oder zurückhalten, solange es
   *  kein Ziel gibt. */
  async #hinunter(data: unknown): Promise<boolean> {
    if (!this.#zielBekannt()) {
      this.#vorhalt.zurueckhalten(data);
      return false;
    }
    return ablageAnPlattform(
      this.#rolle,
      this.#rolle === 'controller' ? this.#fensterSitzung : 0,
      data,
      this.#traeger ?? 0,
    );
  }

  #vorhaltZustellen(): void {
    for (const wert of this.#vorhalt.abholen()) void this.#hinunter(wert);
  }

  /**
   * Wer hält die Ablage dieser Maschine? Nur beim Host.
   *
   * Wechselt der Träger, bekommt der neue Prozess `beginn` — **erst das stellt
   * seinen Fensterfaden auf**, vorher rührt er die Zwischenablage nicht an.
   * Dem alten wird nichts geschickt: gewechselt wird genau dann, wenn sein
   * Stream endete, und der Windows-Sidecar beendet sich danach selbst
   * (`dispatch.rs`) — ein Auftrag an ihn startete einen frischen Prozess, nur
   * um ihm zu sagen, dass er nichts zu tun hat.
   */
  #traegerPruefen(): void {
    const neu = traegerWaehlen(this.#plaetze(), this.#traeger);
    if (neu === this.#traeger) return;
    this.#traeger = neu;
    if (neu === null) return;
    void this.#hinunter(anstossHuelle('beginn'));
    this.#vorhaltZustellen();
  }
}

export const remoteAblage = new RemoteAblage();
