/**
 * Fernsteuerung — **die Form des Host-Zeigers**, vom Host zum Steuernden.
 *
 * Das Cursor-Echo nimmt den Zeiger des Hosts aus dem Bild, damit der Steuernde
 * nur seinen eigenen, verzögerungsfreien sieht
 * (`streaming/win-hq-sidecar/src/capture/cursorsteuerung.rs`). Mit ihm
 * verschwindet aber alles, was ein Zeiger sonst noch erzählt: I-Balken über
 * Text, Doppelpfeil an Kanten, Hand über Verweisen, Wartekringel. Dieses Modul
 * holt genau das zurück — als **Namen**, nicht als Bild:
 *
 * * **Host:** hört die `remote_pointer`-Meldungen seiner Sidecars mit (dieselbe
 *   Brücke wie alle Sidecar-Ereignisse) und schickt jeden Wechsel als
 *   `remote_signal` der Art 'zeiger' an den Steuernden.
 * * **Steuernder:** reicht den Namen ins Player-Fenster, wo winit die Form auf
 *   den lokalen Zeiger setzt (`streaming/pulse-player/src/app/eingabe.rs`).
 *
 * ## Warum Namen und nicht Pixel
 *
 * Ein Name kostet ein paar Byte je Wechsel, und gezeichnet wird weiter der
 * lokale Zeiger — also ohne Verzögerung, in der Zeigergröße und dem Thema des
 * Steuernden, und **plattformübergreifend**: winit übersetzt dieselbe
 * CSS-Namensliste unter Windows in `IDC_*`, unter macOS in `NSCursor`, unter
 * Linux in die Namen des installierten Zeiger-Themas. Ein Linux-Rechner, der
 * einen Windows-Rechner steuert, bekommt so seinen eigenen I-Balken. Der Preis
 * ist, dass nur Standardformen tragen; ein Spiel mit eigenem Zeiger fällt auf
 * `default`.
 *
 * ## Warum überhaupt ein Filter hier
 *
 * Die Form kommt über den Gateway vom Gegenüber und ist damit Fremdeingabe wie
 * jede andere. Der Player deutet sie zwar selbst und kennt Unbekanntes nicht —
 * aber was nicht auf der Liste steht, hat auch nichts im IPC zum Hauptprozess
 * verloren. **Die Liste ist an drei Stellen dieselbe** und muss synchron
 * bleiben: hier, im Sidecar (`remote_input/zeigerform.rs::abbildung`) und im
 * Player (`app/zeigerform.rs`). Die beiden Rust-Enden hält je ein Test
 * fest; hier gibt es keinen (kein Vitest im Web), dafür stammt der Typ
 * [`Zeigerform`] aus derselben Liste — ein hier erfundener Name fiele erst beim
 * Player auf, und zwar als wortloser Standardpfeil.
 */

import type { RemoteSignalKind } from '$lib/ws/handlers/types';
import { aufSidecarEreignisse } from './sidecarInput';

type SignalSender = (kind: RemoteSignalKind, data: unknown) => boolean;
type Senke = (form: Zeigerform) => void;

/**
 * Die Formen, die über die Leitung dürfen — Namen aus der CSS-Zeigerliste, die
 * winit auf allen drei Plattformen kennt.
 */
const FORMEN = [
  'default',
  'text',
  'pointer',
  'wait',
  'progress',
  'crosshair',
  'help',
  'not-allowed',
  'ew-resize',
  'ns-resize',
  'nwse-resize',
  'nesw-resize',
  'move',
] as const;

export type Zeigerform = (typeof FORMEN)[number];

/** Was gilt, solange nichts Gültiges gemeldet wurde. */
const VORGABE: Zeigerform = 'default';

function istForm(wert: unknown): wert is Zeigerform {
  return typeof wert === 'string' && (FORMEN as readonly string[]).includes(wert);
}

/**
 * Nach wie vielen Millisekunden ohne Wechsel dieselbe Form erneut hinausgeht.
 *
 * Der Sidecar wiederholt sie je Sekunde; ohne diese Auffrischung hier wäre das
 * wirkungslos, denn der Wechselfilter unten verschluckte die Wiederholung. Und
 * ohne Wiederholung bliebe ein Wechsel, den der Sekundendeckel des Gateways
 * still verworfen hat, für den Rest der Sitzung verloren — der Steuernde
 * behielte den I-Balken, während der Host längst wieder auf dem Desktop steht.
 * Etwas unter einer Sekunde, damit die Auffrischung des Sidecars nicht
 * regelmäßig knapp danebenfällt.
 */
const AUFFRISCH_MS = 900;

class RemoteZeigerform {
  #rolle: 'controller' | 'host' | null = null;
  #sendSignal: SignalSender | null = null;
  /** Abmelder der Sidecar-Ereignisse (nur beim Host gesetzt). */
  #abmelden: (() => void) | null = null;
  /** Wohin die Form beim Steuernden geht (Player-Fenster) — best-effort. */
  #senke: Senke | null = null;
  /** Zuletzt gemeldete bzw. gesetzte Form. */
  #form: Zeigerform = VORGABE;
  /** Wann der Host zuletzt gesendet hat (`Date.now()`), 0 = noch nie. */
  #gesendetMs = 0;

  /** Mit dem Übergang der Sitzung nach 'active' rufen — wie `remoteP2P.start`. */
  start(rolle: 'controller' | 'host', sendSignal: SignalSender): void {
    this.stop();
    this.#rolle = rolle;
    this.#sendSignal = sendSignal;
    if (rolle !== 'host') return;
    this.#abmelden = aufSidecarEreignisse((ev) => this.#vomSidecar(ev));
  }

  /** Sitzungsende — der eine Ausgang, wie bei `remoteP2P.stop`. */
  stop(): void {
    // Den Zeiger des Steuernden zurückgeben, bevor die Senke fällt: sonst
    // behielte sein Fenster die letzte Form der Sitzung. Der Player setzt beim
    // Ende der Erfassung ebenfalls zurück — doppelt, weil die beiden Wege
    // (Sitzungsende, Fenster zu) nicht immer in derselben Reihenfolge laufen.
    if (this.#rolle === 'controller' && this.#form !== VORGABE) this.#senke?.(VORGABE);
    this.#abmelden?.();
    this.#abmelden = null;
    this.#rolle = null;
    this.#sendSignal = null;
    this.#form = VORGABE;
    this.#gesendetMs = 0;
  }

  /**
   * Wohin die Form beim Steuernden fließt. Wird beim Setzen sofort mit dem
   * aktuellen Stand beliefert — das Player-Fenster hängt sich später an als die
   * Sitzung beginnt, und ohne die Nachlieferung bliebe die erste Form liegen,
   * bis sich zufällig etwas ändert. Gleiche Schiene wie
   * `remoteP2P.setStatusSink`.
   */
  setSenke(senke: Senke | null): void {
    this.#senke = senke;
    if (senke && this.#rolle === 'controller') senke(this.#form);
  }

  /**
   * Ein `remote_signal` der Art 'zeiger' vom Gegenüber (Zuordnung zur Sitzung
   * prüft der Handler).
   *
   * **Nur der Steuernde hört zu.** Der Host ist die Quelle dieser Auskunft; ein
   * 'zeiger' in seine Richtung kann nur aus einem selbstgebauten Client kommen
   * und hat dort nichts zu bestellen.
   */
  _signal(data: unknown): void {
    if (this.#rolle !== 'controller') return;
    if (!data || typeof data !== 'object') return;
    const form = (data as { form?: unknown }).form;
    // Unbekannte Form → Standardpfeil, nicht ignorieren: eine ausgedachte
    // Form soll nicht die letzte gültige stehen lassen.
    const gueltig = istForm(form) ? form : VORGABE;
    if (gueltig === this.#form) return;
    this.#form = gueltig;
    this.#senke?.(gueltig);
  }

  // ── Host-Seite ────────────────────────────────────────────────────────────

  #vomSidecar(ev: unknown): void {
    if (this.#rolle !== 'host') return;
    if (!ev || typeof ev !== 'object') return;
    const m = ev as { ev?: unknown; shape?: unknown };
    if (m.ev !== 'remote_pointer') return;
    // Was der eigene Sidecar meldet, ist nicht Fremdeingabe — geprüft wird es
    // trotzdem, damit eine ältere oder neuere Sidecar-Fassung nichts über die
    // Leitung schiebt, das die Gegenseite nicht deuten kann.
    const form = istForm(m.shape) ? m.shape : VORGABE;
    const jetzt = Date.now();
    // Der Zeiger ist maschinenweit einer, aber bei mehreren Streams meldet ihn
    // jeder Sidecar-Prozess für sich. Deshalb wird hier zusammengefasst: der
    // Wechsel geht sofort hinaus, die Auffrischung höchstens im Takt von
    // `AUFFRISCH_MS` — sonst ginge sie mit jedem Platz einzeln hinaus.
    if (form === this.#form && jetzt - this.#gesendetMs < AUFFRISCH_MS) return;
    this.#form = form;
    this.#gesendetMs = jetzt;
    // Geht die Meldung nicht hinaus (Verbindungs-Blip), wird sie hier NICHT
    // wiederholt: der Sidecar meldet je Sekunde erneut, und die nächste
    // Auffrischung holt es nach. Eine falsche Zeigerform ist zudem der
    // harmloseste Verlust dieser Sitzung — sie kostet Rückmeldung, keine
    // Eingabe.
    this.#sendSignal?.('zeiger', { form });
  }
}

export const remoteZeigerform = new RemoteZeigerform();
