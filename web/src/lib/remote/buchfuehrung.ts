/**
 * Fernsteuerung — was der Steuernde laut den GESENDETEN Frames gerade hält.
 *
 * Herausgelöst aus `p2p.ts`, weil inzwischen zwei Dinge daran hängen und nur
 * eines davon der Transport ist:
 *
 * * **Transportwechsel nur in Ruhe** (`p2p.ts`): gewechselt wird erst, wenn
 *   nichts gedrückt ist — sonst überholt ein über den Serverweg abgeschicktes
 *   Drücken das Hello des DataChannels, und die Taste bleibt am fremden
 *   Rechner unten.
 * * **Nachziehen nach dem Vorrang des Hosts** (`vorrang.ts`): der Host gibt
 *   beim Übernehmen alles frei; hält der Steuernde danach noch W, entsteht bei
 *   ihm kein neues Ereignis — der Druck muss aus dieser Buchführung
 *   nachgereicht werden.
 *
 * Gebucht wird, was WIRKLICH hinausging, unabhängig vom Träger. Frame-Layout
 * aus `streaming/pulse-player/src/fernsteuerung/rahmen.rs`; unlesbare Frames
 * werden ignoriert — sie zu bewerten ist Sache des Sidecars (fail-closed).
 */

/** Opcodes des Wire-Protokolls v2, soweit hier gedeutet. */
const OP_HELLO = 0x00;
const OP_MAUS_ABS = 0x01;
const OP_MAUS_REL = 0x02;
const OP_KNOPF = 0x03;
const OP_TASTE = 0x05;

/**
 * Der Handschlag-Frame: Opcode 0x00 + Fassung 2 (`rahmen.rs`). Normal erzeugt
 * ihn der pulse-player beim Einschalten der Erfassung; beim Transportwechsel
 * muss er hier entstehen, denn der Player weiß nichts vom Träger.
 */
const HELLO_FRAME_B64 = btoa(String.fromCharCode(OP_HELLO, 0x02));

/** Wie lange nach einem im Strom gesehenen Player-Hello NICHT auf den Kanal
 *  gewechselt wird — eine WS-Laufzeit plus Reserve (s. `p2p.ts::senden`). */
const HELLO_WECHSEL_SPERRE_MS = 300;

/**
 * Höchstzahl Frames je Nachricht — Spiegel der Gateway-Grenze
 * (`ws_remote_input.py`), an der der Sidecar fail-closed ist.
 *
 * Steht HIER und wird von `p2p.ts` mitbenutzt: seit dem Nachziehen brauchen
 * beide Dateien dieselbe Zahl, und zwei Kopien im selben Verzeichnis laufen
 * auseinander. Wäre die Kopie hier die größere, wiese der Gateway ausgerechnet
 * die Nachzieh-Nachricht mit 4050 ab und die gehaltenen Tasten kämen nicht
 * zurück.
 */
export const MAX_FRAMES = 32;

function frame(...bytes: number[]): string {
  return btoa(String.fromCharCode(...bytes));
}

export class Gedruecktbuch {
  /** Was laut den gesendeten Frames unten ist ('k<scan>' / 'b<btn>'). */
  readonly #unten = new Set<string>();
  /** Letzte gesendete absolute Zeigerlage (roher Base64-Frame). */
  #letzteAbsB64: string | null = null;
  /** Wann zuletzt ein Player-Hello vorbeikam (`performance.now()`). */
  #helloGesehenAm: number | null = null;

  /** Ist gerade nichts gedrückt? Bedingung für den Transportwechsel. */
  get ruhig(): boolean {
    return this.#unten.size === 0;
  }

  /** Liegt ein Player-Hello so kurz zurück, dass es noch unterwegs sein kann? */
  get helloFrisch(): boolean {
    return (
      this.#helloGesehenAm !== null &&
      performance.now() - this.#helloGesehenAm < HELLO_WECHSEL_SPERRE_MS
    );
  }

  leeren(): void {
    this.#unten.clear();
    this.#letzteAbsB64 = null;
    this.#helloGesehenAm = null;
  }

  /**
   * Was ein Transportwechsel dem Host als Erstes schickt: das Hello — und,
   * wenn bekannt, die letzte absolute Zeigerlage gleich hinterher.
   *
   * **Warum die Lage dazugehört** (Bughunt 2026-08-13): Das Hello leert beim
   * Host auch die gemerkte Zeigerlage, und ohne gültige Lage feuert laut
   * Wire-Spec kein Knopf und kein Rad. Der Player stellt seinem eigenen Hello
   * deshalb eine Lage nach; der Transportwechsel kennt sie nur aus der
   * Buchführung — steht der Zeiger gerade still und der Nutzer klickt, wäre
   * der Klick sonst still verschluckt. Ohne bekannte Lage bleibt es beim
   * nackten Hello (gleiches Verhalten wie ein frischer Player-Strom vor der
   * ersten Bewegung).
   */
  helloBuendel(): string[] {
    return this.#letzteAbsB64 === null
      ? [HELLO_FRAME_B64]
      : [HELLO_FRAME_B64, this.#letzteAbsB64];
  }

  /**
   * Den gehaltenen Zustand erneut behaupten — für die Rückkehr aus dem Vorrang
   * des Hosts (`vorrang.ts`).
   *
   * **Kein Hello davor.** Der Vorrang legt die Sitzung nicht still, der Host
   * bleibt begrüßt; ein Hello wäre ein neuer Eingabestrom und gäbe genau das
   * frei, was hier gerade wiederhergestellt wird.
   *
   * **Eine Zeigerlage geht IMMER voran — auch wenn gar nichts gehalten wird.**
   * Der Host entwertet seine gemerkte Lage beim Übernehmen und stellt sie von
   * sich aus nie wieder her; ohne gültige Lage feuert dort weder Knopf noch
   * Rad. Bis zum Bughunt 2026-08-14 stand die Lage nur bei gehaltenen Knöpfen
   * voran, und das ließ den häufigsten Fall offen: wer nach einem Vorrang
   * weiterscrollt oder an Ort und Stelle klickt, ohne die Maus zu bewegen,
   * dessen Eingaben wurden **still verschluckt** — die Fernsteuerung meldete
   * „läuft", tat aber nichts, bis der Zeiger sich um ein Pixel bewegte. Der
   * Player erfindet keine Bewegungsframes, es kommt also nichts nach.
   *
   * Woher die Lage kommt, hängt an der Betriebsart:
   *
   * * *Freier Zeiger:* die zuletzt gesendete absolute Lage, wie beim
   *   Transportwechsel.
   * * *Zeigerfang:* die gibt es dort nicht (relative Bewegungen löschen sie).
   *   Stattdessen geht eine relative Bewegung um **null** voran — der Host
   *   rechnet die ohne gemerkte Lage von der Mitte des Quell-Rechtecks aus und
   *   hat danach eine gültige. Im Zeigerfang liest das Spiel ohnehin
   *   Differenzen, nicht die Lage, also kostet das nichts.
   *
   * Der eine Preis: hat der Steuernde in dieser Sitzung noch nie eine absolute
   * Lage gesendet (frisch begonnen, Zeiger nie bewegt), setzt der Nullschritt
   * den Host-Zeiger in die Mitte des aufgenommenen Bereichs. Das ist derselbe
   * Punkt, an dem auch seine erste eigene Bewegung ansetzte.
   *
   * Stückelt auf die Wire-Grenze, statt still zu kappen: wer mit 40 gehaltenen
   * Tasten aus einem Vorrang kommt, soll sie alle zurückbekommen.
   */
  nachziehBuendel(): string[][] {
    const knoepfe: string[] = [];
    const tasten: string[] = [];
    for (const id of this.#unten) {
      const wert = Number(id.slice(1));
      if (!Number.isInteger(wert)) continue;
      if (id[0] === 'k') tasten.push(frame(OP_TASTE, wert & 0xff, (wert >> 8) & 0xff, 1));
      else knoepfe.push(frame(OP_KNOPF, wert & 0xff, 1));
    }
    // Lage zuerst, dann Knöpfe, dann Tasten — der Sidecar arbeitet die Frames
    // einer Nachricht in Reihenfolge ab.
    const frames: string[] = [this.#letzteAbsB64 ?? frame(OP_MAUS_REL, 0, 0, 0, 0)];
    frames.push(...knoepfe, ...tasten);
    const buendel: string[][] = [];
    for (let i = 0; i < frames.length; i += MAX_FRAMES) {
      buendel.push(frames.slice(i, i + MAX_FRAMES));
    }
    return buendel;
  }

  /** Frame-Opcode lesen und die Gedrückt-Menge nachführen. */
  buchen(frameB64: string): void {
    let bytes: string;
    try {
      bytes = atob(frameB64);
    } catch {
      return;
    }
    const op = bytes.charCodeAt(0);
    if (op === OP_MAUS_ABS && bytes.length === 5) {
      // Für das Umschalt- und das Nachzieh-Bündel aufheben.
      this.#letzteAbsB64 = frameB64;
      return;
    }
    if (op === OP_KNOPF && bytes.length === 3) {
      this.#setzen(`b${bytes.charCodeAt(1)}`, bytes.charCodeAt(2) !== 0);
    } else if (op === OP_TASTE && bytes.length === 4) {
      const scan = bytes.charCodeAt(1) | (bytes.charCodeAt(2) << 8);
      this.#setzen(`k${scan}`, bytes.charCodeAt(3) !== 0);
    } else if (op === OP_MAUS_REL) {
      // Relative Bewegung (Zeigerfang): die gemerkte absolute Lage ist ab
      // jetzt Vergangenheit — ein Umschalt-Hello mit ihr positionierte den
      // Host-Zeiger falsch UND ließe das Cursor-Echo einmal umschlagen
      // (das Bündel endete auf MouseMoveAbs = „verbergen").
      this.#letzteAbsB64 = null;
    } else if (op === OP_HELLO) {
      // Ein Hello aus dem Player (Erfassung neu eingeschaltet, Notbremse)
      // leert auch unsere Buchführung — der Host gibt dabei ohnehin alles
      // frei. Der Zeitstempel sperrt den Transportwechsel kurz (s. `senden`).
      this.#unten.clear();
      this.#helloGesehenAm = performance.now();
    }
  }

  #setzen(id: string, unten: boolean): void {
    if (unten) this.#unten.add(id);
    else this.#unten.delete(id);
  }
}
