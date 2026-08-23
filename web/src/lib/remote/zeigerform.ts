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
 * * **Steuernder:** reicht ihn ins Player-Fenster, wo winit die Form auf den
 *   lokalen Zeiger setzt (`streaming/pulse-player/src/app/eingabe.rs`).
 *
 * ## Warum bevorzugt Namen und nicht Pixel
 *
 * Ein Name kostet ein paar Byte je Wechsel, und gezeichnet wird weiter der
 * lokale Zeiger — also ohne Verzögerung, in der Zeigergröße und dem Thema des
 * Steuernden, und **plattformübergreifend**: winit übersetzt dieselbe
 * CSS-Namensliste unter Windows in `IDC_*`, unter macOS in `NSCursor`, unter
 * Linux in die Namen des installierten Zeiger-Themas. Ein Linux-Rechner, der
 * einen Windows-Rechner steuert, bekommt so seinen eigenen I-Balken.
 *
 * Nur trägt der Name allein die dreizehn Formen, die Windows selbst mitbringt.
 * Die Rasierklinge einer Schnittanwendung, der Werkzeugzeiger einer
 * Bildbearbeitung, der Achsenzeiger eines 3D-Programms fielen früher alle auf
 * `default`. Für die schickt der Host deshalb zusätzlich das **Bild**
 * (`streaming/win-hq-sidecar/src/remote_input/zeigerpixel.rs`), und dieses Modul
 * reicht es mit durch. Der Name bleibt trotzdem immer dabei — er ist der
 * Rückfall, wenn das Bild fehlt oder sich drüben nicht bauen lässt.
 *
 * ## Warum überhaupt ein Filter hier
 *
 * Die Form kommt über den Gateway vom Gegenüber und ist damit Fremdeingabe wie
 * jede andere. Der Player deutet sie zwar selbst und kennt Unbekanntes nicht —
 * aber was nicht auf der Liste steht, hat auch nichts im IPC zum Hauptprozess
 * verloren. **Die Liste ist an drei Stellen dieselbe** und muss synchron
 * bleiben: hier, im Sidecar (`remote_input/zeigerform.rs::abbildung`) und im
 * Player (`app/zeigerform.rs`). Die beiden Rust-Enden hält je ein Test fest;
 * hier trägt sie der Typ [`Zeigerform`] — ein hier erfundener Name fiele erst
 * beim Player auf, und zwar als wortloser Standardpfeil.
 *
 * ## Der Rückfall, wenn der Host die Form gar nicht mehr kennt
 *
 * macOS liest die Zeigerform über eine von Apple **abgekündigte** Abfrage. Fällt
 * sie eines Tages aus, legt der Mac seinen Zeiger zurück ins Videobild und
 * meldet das als `remote_signal` der Art 'zeiger_im_bild' ([`_signalImBild`]);
 * der Player blendet dann seinen lokalen Zeiger aus, damit nicht zwei zu sehen
 * sind. Der Host-Zeiger ist danach formrichtig, aber der Hand um die
 * Übertragungszeit hinterher — schlechter, nicht kaputt. Die Entscheidung dazu
 * steht in [`./zeigerImBild`].
 *
 * **Die Prüfung des BILDES steht nebenan** ([`./zeigerbildPruefung`]), und
 * zwar, damit sie ausführbar ist: dieses Modul importiert `./sidecarInput` zur
 * Laufzeit, und ein solcher Import macht eine Datei für Nodes Testläufer
 * unerreichbar (er löst erweiterungslose Pfade nicht auf). Der Test dort prüft
 * gegen den Prüfstein `streaming/zeigerbild-formen.json`, also gegen die
 * Formen, die der SENDER erzeugt — nicht gegen ausgedachte.
 */

import type { RemoteSignalKind } from '$lib/ws/handlers/types';
import { aufSidecarEreignisse } from './sidecarInput';
import { pruefeBild, type Zeigerbild } from './zeigerbildPruefung';
import { ZeigerImBild, sidecarMeldungImBild } from './zeigerImBild';

export type { Zeigerbild };

type SignalSender = (kind: RemoteSignalKind, data: unknown) => boolean;
/**
 * Wohin Form und Bild beim Steuernden fließen. `imBild` ist der Rückfall: gilt
 * er, blendet der Player seinen lokalen Zeiger ganz aus und der Host-Zeiger
 * reitet im Videobild mit (s. [`./zeigerImBild`]). Die Form geht trotzdem mit —
 * sie gilt wieder, sobald der Rückfall endet.
 */
type Senke = (form: Zeigerform, bild?: Zeigerbild, imBild?: boolean) => void;

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
  /** Kennung des zuletzt gemeldeten bzw. gesetzten Bildes, '' = keines. */
  #bildId = '';
  /**
   * Das zuletzt gesetzte Bild — nur beim Steuernden, nur zum Nachliefern an ein
   * Fenster, das sich später anhängt (s. [`setSenke`]). Gehalten wird die
   * **Vollform**, sonst könnte das neue Fenster nichts damit anfangen: sein
   * Player hat noch keinen Vorrat, in den eine blosse Kennung greifen könnte.
   */
  #bild: Zeigerbild | undefined;
  /** Wann der Host zuletzt gesendet hat (`Date.now()`), 0 = noch nie. */
  #gesendetMs = 0;
  /**
   * Wann zuletzt ein **vollständiges** Bild hinausging (`Date.now()`).
   *
   * **Getrennt von [`#gesendetMs`], und aus demselben Grund wie `bild_takte`
   * im Sidecar:** ein gemeinsamer Zähler fällt bei jeder Meldung, und dann
   * frischt bei einem Zeiger, der öfter als der Auffrischtakt wechselt,
   * überhaupt nichts mehr auf — also gerade dort nicht, wo die Heilung
   * gebraucht wird (beim Fahren über eine Timeline wechselt der Zeiger
   * mehrmals je Sekunde).
   */
  #vollstaendigMs = 0;
  /**
   * Steht der Host-Zeiger gerade im Videobild statt in einer Formmeldung?
   * Eigener Baustein, weil dort auch das Zurücksetzen beim Sitzungsende sitzt
   * und geprüft wird (s. [`./zeigerImBild`]).
   */
  #imBild = new ZeigerImBild();

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
    //
    // **Der Rückfall gehört unbedingt dazu.** Lief er, ist der lokale Zeiger
    // des Steuernden gerade AUSGEBLENDET — bliebe er das, säße der Nutzer nach
    // dem Ende der Fernsteuerung ohne Zeiger vor seinem eigenen Rechner. Das
    // ist der schlimmste denkbare Ausgang dieser Funktion, und deshalb steht
    // die Rückstellung an derselben Stelle wie die der Form, nicht daneben.
    const rueckfallStand = this.#imBild.beenden();
    if (
      this.#rolle === 'controller' &&
      (this.#form !== VORGABE || this.#bildId || rueckfallStand)
    ) {
      this.#senke?.(VORGABE, undefined, false);
    }
    this.#abmelden?.();
    this.#abmelden = null;
    this.#rolle = null;
    this.#sendSignal = null;
    this.#form = VORGABE;
    this.#bildId = '';
    this.#bild = undefined;
    this.#gesendetMs = 0;
    this.#vollstaendigMs = 0;
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
    if (senke && this.#rolle === 'controller') {
      senke(this.#form, this.#bild, this.#imBild.aktiv);
    }
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
    const { form, bild } = data as { form?: unknown; bild?: unknown };
    // Unbekannte Form → Standardpfeil, nicht ignorieren: eine ausgedachte
    // Form soll nicht die letzte gültige stehen lassen. Für das Bild gilt
    // dasselbe: was die Prüfung nicht besteht, gibt es hier nicht.
    const gueltig = istForm(form) ? form : VORGABE;
    const gueltigesBild = pruefeBild(bild);
    const kennung = gueltigesBild?.id ?? '';
    // **Eine Wiederholung MIT Daten geht trotzdem durch.** Sie ist die
    // Auffrischung des Hosts, und sie ist der einzige Weg, auf dem sich ein
    // Bild heilt, das drüben fehlt — etwa weil der Player seinen Vorrat
    // geleert hat, während der Host es weiter für bekannt hält. Ohne diese
    // Ausnahme bliebe der Steuernde bis zum nächsten echten Wechsel beim
    // Standardpfeil. Reine Wiederholungen ohne Daten kosten dagegen nur IPC.
    if (gueltig === this.#form && kennung === this.#bildId && !gueltigesBild?.daten) return;
    this.#form = gueltig;
    this.#bildId = kennung;
    // Nur die Vollform aufheben: ein später angehängtes Fenster kann mit einer
    // blossen Kennung nichts anfangen, sein Player hat noch keinen Vorrat.
    // **Und das Gemerkte muss zur Kennung passen.** Bei der Kurzform `{id}`
    // steht das Bild nicht in der Meldung, sondern im Vorrat des Players —
    // hier bliebe sonst das Bild des VORIGEN Zeigers liegen, während `#bildId`
    // schon auf den neuen zeigt, und `setSenke` reichte einem zweiten
    // Player-Fenster die falsche Form. Passt die Kurzform zum Gemerkten, bleibt
    // es; sonst (und wenn das Bild ganz wegfällt) fällt es weg.
    if (gueltigesBild?.daten) this.#bild = gueltigesBild;
    else if (this.#bild?.id !== kennung) this.#bild = undefined;
    this.#senke?.(gueltig, gueltigesBild, this.#imBild.aktiv);
  }

  /**
   * Ein `remote_signal` der Art 'zeiger_im_bild' vom Gegenüber — der
   * **Rückfall**: der Host kann seine Zeigerform nicht mehr melden und hat
   * seinen Zeiger zurück ins Videobild gelegt.
   *
   * Der Player blendet daraufhin seinen lokalen Zeiger aus; sonst stünden zwei
   * Zeiger im Bild, und der falsche wäre der schnellere. Endet der Rückfall,
   * kommt der lokale zurück und die zuletzt gemeldete Form gilt wieder —
   * deshalb geht sie hier weiter mit.
   *
   * **Nur der Steuernde hört zu**, aus demselben Grund wie bei [`_signal`]: der
   * Host ist die Quelle dieser Auskunft.
   *
   * Die Deutung der Nutzlast steht in [`./zeigerImBild`] und ist bewusst
   * streng — im Zweifel gilt „Zeiger sichtbar".
   */
  _signalImBild(data: unknown): void {
    if (this.#rolle !== 'controller') return;
    // Wiederholungen schluckt der Baustein selbst; nur ein WECHSEL kostet IPC.
    if (!this.#imBild.signal(data)) return;
    this.#senke?.(this.#form, this.#bild, this.#imBild.aktiv);
  }

  // ── Host-Seite ────────────────────────────────────────────────────────────

  #vomSidecar(ev: unknown): void {
    if (this.#rolle !== 'host') return;
    if (!ev || typeof ev !== 'object') return;
    const m = ev as { ev?: unknown; shape?: unknown; bild?: unknown };
    // **Der Rückfall reist über denselben Weg**, aber mit eigener Art. Der
    // Sidecar meldet ihn als `remote_pointer_in_frame`, wenn seine Abfrage
    // nichts hergab und er den Host-Zeiger zurück ins Bild geschaltet hat.
    //
    // **Diese Weiterleitung fehlte bis zum 2026-08-23**, und das war eine
    // Lücke genau zwischen zwei Hälften: der Sidecar meldete, der Player
    // konnte es deuten, der README beschrieb es — nur reichte niemand es
    // weiter, und `#vomSidecar` verwarf die Art wortlos. Der Steuernde hätte
    // seinen Zeiger nie ausgeblendet und immer zwei gesehen. Kein Absturz,
    // keine Meldung: der Rückfall wäre stillschweigend wirkungslos gewesen.
    //
    // Nicht gedeutet wird hier: `aktiv` geht roh hinaus, die Gegenseite
    // entscheidet (`./zeigerImBild`). Ein zweiter Deutungsort wäre ein
    // zweiter Ort, an dem sich die Regel ändern kann.
    const imBild = sidecarMeldungImBild(ev);
    if (imBild !== null) {
      this.#sendSignal?.('zeiger_im_bild', { aktiv: imBild });
      return;
    }
    if (m.ev !== 'remote_pointer') return;
    // Was der eigene Sidecar meldet, ist nicht Fremdeingabe — geprüft wird es
    // trotzdem, damit eine ältere oder neuere Sidecar-Fassung nichts über die
    // Leitung schiebt, das die Gegenseite nicht deuten kann.
    const form = istForm(m.shape) ? m.shape : VORGABE;
    const bild = pruefeBild(m.bild);
    const kennung = bild?.id ?? '';
    const jetzt = Date.now();
    // Der Zeiger ist maschinenweit einer, aber bei mehreren Streams meldet ihn
    // jeder Sidecar-Prozess für sich. Deshalb wird hier zusammengefasst: der
    // Wechsel geht sofort hinaus, die Auffrischung höchstens im Takt von
    // `AUFFRISCH_MS` — sonst ginge sie mit jedem Platz einzeln hinaus. Der
    // Wechsel misst sich an Form UND Bildkennung: zwei Werkzeugzeiger desselben
    // Programms tragen beide den Namen `default`.
    const gleich = form === this.#form && kennung === this.#bildId;
    // Ein vollständiges Bild geht auch dann durch, wenn sich sonst nichts
    // geändert hat: es ist die Auffrischung des Sidecars, und die ist der eine
    // Weg, auf dem ein drüben fehlendes Bild wieder ankommt. Die Sperre gilt
    // dabei getrennt (s. [`#vollstaendigMs`]) — sonst schluckte ein schnell
    // wechselnder Zeiger jede Auffrischung, weil die gemeinsame Sperre nie
    // abläuft.
    const istAuffrischung = Boolean(bild?.daten);
    const sperreMs = istAuffrischung ? this.#vollstaendigMs : this.#gesendetMs;
    if (gleich && jetzt - sperreMs < AUFFRISCH_MS) return;
    this.#form = form;
    this.#bildId = kennung;
    this.#gesendetMs = jetzt;
    if (istAuffrischung) this.#vollstaendigMs = jetzt;
    // Geht die Meldung nicht hinaus (Verbindungs-Blip), wird sie hier NICHT
    // wiederholt: der Sidecar meldet je Sekunde erneut, und die nächste
    // Auffrischung holt es nach. Eine falsche Zeigerform ist zudem der
    // harmloseste Verlust dieser Sitzung — sie kostet Rückmeldung, keine
    // Eingabe.
    this.#sendSignal?.('zeiger', bild ? { form, bild } : { form });
  }
}

export const remoteZeigerform = new RemoteZeigerform();
