/**
 * Ereignis-Bericht der ZUSCHAUER-Seite eines HQ-Streams.
 *
 * **Die Lücke, die das schließt:** bis 2026-08-06 lud ausschließlich der
 * Sender etwas hoch (`desktop/electron/experimental-log-upload.ts`), und zwar
 * bis zu 512 KiB Rohtext. Vom Zuschauer kam nichts. Wer „bei mir ruckelt es"
 * nachgehen wollte, hatte damit genau die Seite nicht, auf der es geruckelt
 * hat.
 *
 * Erhoben wird nichts Neues: `whep-stats.ts` liest all das seit langem und
 * zeigt es im Overlay an. Es fehlte allein der Weg zum Server.
 *
 * ## Warum verdichtet und gedeckelt wird
 *
 * Ein Poll je Sekunde über eine halbe Stunde sind 1800 Messpunkte, und eine
 * schlechte Minute erzeugt in jedem davon dasselbe Ereignis. Ungefiltert
 * hochgeladen wäre das ein Rohtext-Dump mit anderer Syntax — genau das, was
 * hier abgelöst werden soll. Deshalb zwei Stufen:
 *
 *  1. **Verdichtung**: gleichartige Ereignisse innerhalb von
 *     {@link FENSTER_MS} werden zu EINEM Eintrag mit `anzahl` zusammengefasst.
 *  2. **Deckel**: nach {@link MAX_EREIGNISSE} verschiedenen Einträgen wird nur
 *     noch gezählt — und die Zahl der Verworfenen steht IM BERICHT.
 *
 * Der zweite Punkt ist keine Formalie. Eine still gekappte Liste liest sich
 * später wie „danach war nichts mehr", also wie eine beruhigte Verbindung —
 * und zwar ausgerechnet in der Sitzung, in der am meisten schiefging.
 *
 * ## Warum es keine Server-Sitzungskennung gibt
 *
 * Naheliegend wäre, die WHEP-Sitzung mit der Kennung zu verbinden, unter der
 * MediaMTX dieselbe Sitzung in seinem Log führt (`[session 9a28cbc6]`, siehe
 * `scripts/fec-tor-kennzahlen.py`). **Das geht nicht, und der Grund ist am
 * MediaMTX-Quelltext geprüft, nicht vermutet:**
 *
 *  - das Log-Präfix ist `hex(session.uuid[:4])`,
 *  - der `Location`-Header der WHEP-Antwort trägt `session.secret` —
 *    eine ANDERE UUID.
 *
 * Die eine ist aus der anderen nicht ableitbar. Und `secret` autorisiert
 * `PATCH`/`DELETE` auf die Sitzung; es hochzuladen hiesse, ein
 * Sitzungs-Token in eine Diagnose-Tabelle zu schreiben. Beides spricht
 * dagegen.
 *
 * Verbunden wird deshalb über **Kanal + sendender Nutzer + Zeitfenster**: der
 * Pfad im Serverlog (`is reading from path 'channel-<kanal>-<sender>-…'`)
 * enthält beide Kennungen, und Beginn/Ende grenzen die Sitzung ein. Das ist
 * gröber als eine Kennung, aber es ist belegbar.
 */

import type { DiagnosticSnapshot, StreamStats } from './whep-stats';

/** Zeitfenster, in dem gleichartige Ereignisse zu einem Eintrag verschmelzen. */
const FENSTER_MS = 10_000;

/**
 * Deckel für die Ereignisliste einer Sitzung. Der Server lässt etwas mehr zu
 * (`MAX_EVENTS = 250` in `routes_experimental_logs.py`), damit ein Bericht am
 * Rand nicht an einem Off-by-one scheitert — ein 422 verwirft den GANZEN
 * Bericht, nicht nur das überzählige Ereignis.
 */
const MAX_EREIGNISSE = 200;

/** Ein Vorfall, gleichartige innerhalb von {@link FENSTER_MS} zusammengefasst. */
export type Ereignis = {
  /** Sekunden seit Sitzungsbeginn. Relativ, weil eine Uhrzeit vom Client ohne
   *  bekannten Uhrenstand nicht einzuordnen wäre. */
  s: number;
  art: string;
  anzahl: number;
  werte?: Record<string, number | string>;
};

export type DiagnoseBericht = {
  kopf: Record<string, unknown>;
  bilanz: Record<string, unknown>;
  ereignisse: Ereignis[];
  ereignisse_verworfen: number;
  abschluss: Record<string, unknown>;
};

/** Was der Sammler über die Sitzung wissen muss, um den Kopf zu füllen. */
export type SitzungsKontext = {
  kanal: string;
  sender: string;
  slot: number;
  /** Ob der Sender laut WHEP-Antwort 10 bit liefert. */
  zehnBit?: boolean;
};

/**
 * Sammelt über eine WHEP-Sitzung hinweg Ereignisse und baut daraus am Ende
 * den Bericht. Einer je Sitzung; bei einem Wiederaufbau (`recycle`) endet die
 * alte Sitzung und eine neue beginnt.
 */
export class DiagnoseSammler {
  #kontext: SitzungsKontext;
  #beginn = performance.now();
  #ereignisse: Ereignis[] = [];
  #verworfen = 0;
  /** Letzter Snapshot — trägt die kumulativen Zähler für die Bilanz. */
  #letzter: DiagnosticSnapshot | null = null;
  #ersterKopf: Record<string, unknown> | null = null;
  /** Vorheriger Snapshot, gegen den die Deltas gebildet werden. */
  #vorher: DiagnosticSnapshot | null = null;
  /** Ob in dieser Sitzung je ein Bild dekodiert wurde — das unterscheidet
   *  „kein Bild" von „Bild mit Aussetzern", und das sind zwei völlig
   *  verschiedene Fehlerbilder. */
  #jeDekodiert = false;
  /** Byte-Stand beim ERSTEN Messpunkt. Die mittlere Bitrate der Sitzung ist
   *  die Differenz zum letzten Stand, geteilt durch die Dauer — nicht der
   *  Mittelwert der Momentanwerte, denn dessen Stützstellen liegen bei einem
   *  Aussetzer genauso dicht wie im ruhigen Betrieb und gewichten die
   *  schlechte Sekunde damit gleich stark wie eine gute. */
  #bytesAmAnfang: number | null = null;

  constructor(kontext: SitzungsKontext) {
    this.#kontext = kontext;
  }

  /** Sekunden seit Sitzungsbeginn, auf eine Nachkommastelle. */
  #jetzt(): number {
    return Math.round((performance.now() - this.#beginn) / 100) / 10;
  }

  /**
   * Trägt ein Ereignis ein — verdichtend.
   *
   * Verschmolzen wird nur mit dem JÜNGSTEN Eintrag derselben Art, nicht mit
   * irgendeinem im Fenster: sonst würde ein Ereignis, das alle 9 Sekunden
   * wiederkehrt, über eine ganze Stunde zu einer einzigen Zeile bei Sekunde 0
   * zusammenfallen, und der Zeitpunkt wäre gelogen.
   */
  ereignis(art: string, werte?: Record<string, number | string>, anzahl = 1): void {
    const s = this.#jetzt();
    for (let i = this.#ereignisse.length - 1; i >= 0; i--) {
      const e = this.#ereignisse[i];
      if (e.art !== art) continue;
      if ((s - e.s) * 1000 <= FENSTER_MS) {
        e.anzahl += anzahl;
        // Die Werte des JÜNGSTEN Vorfalls gewinnen. Bei einem Einfrieren ist
        // die zuletzt gemessene Dauer die längste — der interessante Wert.
        if (werte) e.werte = werte;
        return;
      }
      break; // älter als das Fenster: ein neuer Eintrag muss her
    }

    if (this.#ereignisse.length >= MAX_EREIGNISSE) {
      this.#verworfen += anzahl;
      return;
    }
    this.#ereignisse.push({ s, art, anzahl, ...(werte ? { werte } : {}) });
  }

  /**
   * Je Poll (1 Hz) aufzurufen. Leitet die Ereignisse aus den DELTAS der
   * kumulativen Zähler ab — die Zähler selbst wachsen monoton und wären als
   * Ereignis wertlos.
   */
  beobachte(stats: StreamStats | null): void {
    if (!stats) return;
    const d = stats.diagnostic;
    const vor = this.#vorher;
    this.#letzter = d;
    if (this.#bytesAmAnfang === null) this.#bytesAmAnfang = d.bytesReceived;
    if (d.framesDecoded > 0) this.#jeDekodiert = true;

    if (this.#ersterKopf === null && d.frameWidth) {
      this.#ersterKopf = {
        codec: stats.codec,
        aufloesung: `${d.frameWidth}x${d.frameHeight}`,
        decoder: d.decoderImplementation,
      };
    }

    if (vor) {
      // Der Decoder-Wechsel ist das wertvollste Einzelereignis überhaupt:
      // Chromiums Hardware-Decoder steigt mitten im Lauf aus und libwebrtc
      // fällt auf dav1d zurück (gemessen 2026-08-01). Ohne diese Zeile sieht
      // man später nur „ab hier war das Bild kaputt" und nicht, warum.
      if (d.decoderImplementation !== vor.decoderImplementation) {
        this.ereignis('decoder_gewechselt', {
          von: vor.decoderImplementation ?? '?',
          nach: d.decoderImplementation ?? '?',
        });
      }
      if (d.frameWidth !== vor.frameWidth || d.frameHeight !== vor.frameHeight) {
        this.ereignis('aufloesung_gewechselt', {
          nach: `${d.frameWidth ?? '?'}x${d.frameHeight ?? '?'}`,
        });
      }

      const stotterer = d.freezeCount - vor.freezeCount;
      if (stotterer > 0) {
        this.ereignis(
          'stottern',
          { zwischenbild_jitter_ms: Math.round(d.interFrameJitterMs ?? 0) },
          stotterer,
        );
      }
      const verworfeneBilder = d.framesDropped - vor.framesDropped;
      if (verworfeneBilder > 0) this.ereignis('bilder_verworfen', undefined, verworfeneBilder);

      const vollbilder = d.pliCount - vor.pliCount;
      if (vollbilder > 0) this.ereignis('vollbild_angefordert', undefined, vollbilder);

      // Verlust als PAKETE, nicht als NACK-Anforderungen. Die
      // NACK-Zahl wäre um den Faktor ~9 aufgebläht (Mehrfachanforderung
      // derselben Lücke) und beschriebe den Empfänger, nicht die Leitung.
      const verlust = d.packetsLost - vor.packetsLost;
      if (verlust > 0) this.ereignis('pakete_verloren', undefined, verlust);
    }

    // Einfrieren: nur die FLANKE meldet, nicht jeder Poll währenddessen —
    // sonst stünde eine 30-Sekunden-Einfrierung 30x in der Liste.
    if (d.frozen && !(vor?.frozen ?? false)) {
      this.ereignis('einfrieren', { dauer_s: Math.round(d.freezeSeconds * 10) / 10 });
    } else if (d.frozen && vor?.frozen) {
      // Dieselbe Einfrierung dauert an: den Eintrag mit der aktuellen (also
      // längeren) Dauer nachziehen, ohne die Anzahl zu erhöhen.
      const letztes = this.#ereignisse.findLast?.((e) => e.art === 'einfrieren');
      if (letztes) letztes.werte = { dauer_s: Math.round(d.freezeSeconds * 10) / 10 };
    }

    this.#vorher = d;
  }

  /** Verbindungszustandswechsel (`connectionstatechange`). */
  verbindung(zustand: string): void {
    this.ereignis('verbindung', { zustand });
  }

  /** Baut den Bericht. `grund` = warum die Sitzung endete. */
  bericht(grund: string, umgebung: Record<string, unknown> = {}): DiagnoseBericht {
    const d = this.#letzter;
    const dauer = (performance.now() - this.#beginn) / 1000;
    // Dieselbe Rechnung steht in `whep-stats.ts::formatDiagnostic` ein zweites
    // Mal. **Das ist Absicht und darf nicht zusammengezogen werden:** dieses
    // Modul zieht aus `whep-stats.ts` ausschliesslich Typen, hat damit keinen
    // einzigen Laufzeit-Import und laeuft deshalb im nackten Node-Testlaeufer
    // ohne Browser-Umgebung. Ein gemeinsamer Helfer waere ein Laufzeit-Import
    // und kostet genau diese Testbarkeit (probiert, `pnpm test:unit` bricht
    // sofort — Node loest den erweiterungslosen Pfad nicht auf). Zwei Zeilen
    // Doppelung sind der guenstigere Preis.
    const paketeGesamt = d ? d.packetsReceived + d.packetsLost : 0;
    // Bei null Paketen ist der Anteil UNBEKANNT, nicht null: „0 % Verlust"
    // liest sich als „Leitung sauber", und wenn gar nichts ankam, ist das
    // Gegenteil der Fall.
    const verlustAnteil = d && paketeGesamt > 0 ? d.packetsLost / paketeGesamt : null;

    return {
      kopf: {
        rolle: 'viewer',
        kanal: this.#kontext.kanal,
        sender: this.#kontext.sender,
        slot: this.#kontext.slot,
        zehn_bit: this.#kontext.zehnBit ?? false,
        ...this.#ersterKopf,
        decoder_am_ende: d?.decoderImplementation ?? null,
        ...umgebung,
      },
      bilanz: {
        dauer_s: Math.round(dauer * 10) / 10,
        je_dekodiert: this.#jeDekodiert,
        bilder_empfangen: d?.framesReceived ?? 0,
        bilder_dekodiert: d?.framesDecoded ?? 0,
        bilder_verworfen: d?.framesDropped ?? 0,
        vollbilder_dekodiert: d?.keyFramesDecoded ?? 0,
        // Mittlere Bitrate über die ganze Sitzung, aus der Byte-Differenz —
        // belastbarer als der letzte Momentanwert, der genauso gut in eine
        // Aussetzer-Sekunde gefallen sein kann.
        bitrate_kbps:
          d && this.#bytesAmAnfang !== null && dauer > 0
            ? Math.round(((d.bytesReceived - this.#bytesAmAnfang) * 8) / dauer / 1000)
            : null,
        pakete_empfangen: d?.packetsReceived ?? 0,
        pakete_verloren: d?.packetsLost ?? 0,
        // Der Anteil ist die eigentliche Aussage; die absoluten Zahlen stehen
        // daneben, damit man ihn nachrechnen kann.
        verlust_anteil: verlustAnteil,
        // Bewusst so benannt: es sind Anforderungen, keine Verluste. Siehe
        // den Kommentar an `nackCount` in `whep-stats.ts`.
        nack_anforderungen: d?.nackCount ?? 0,
        vollbild_anforderungen: d?.pliCount ?? 0,
        fir_anforderungen: d?.firCount ?? 0,
        einfrierungen: d?.freezeCount ?? 0,
        einfrier_dauer_s: d?.totalFreezesDuration ?? 0,
        // `!= null` fängt beide Lücken in einem Schritt ab: keinen Messpunkt
        // (`d` ist null) und einen Messpunkt ohne Jitter-Wert.
        netz_jitter_ms: d?.jitter != null ? Math.round(d.jitter * 1000) : null,
      },
      ereignisse: this.#ereignisse,
      ereignisse_verworfen: this.#verworfen,
      abschluss: { grund },
    };
  }

  /**
   * Ob dieser Bericht überhaupt gesendet werden soll.
   *
   * Eine saubere, kurze Sitzung ohne einen einzigen Vorfall trägt nichts bei
   * und würde nur die Aufbewahrungsgrenzen gegen die interessanten Berichte
   * arbeiten lassen. **Aber „kein Ereignis" allein reicht als Kriterium
   * nicht:** eine Sitzung, in der NIE ein Bild dekodiert wurde, ist der
   * schlimmste Fall überhaupt — und erzeugt womöglich gar kein Ereignis, weil
   * nichts passiert, wovon man ein Delta bilden könnte.
   */
  lohntSich(): boolean {
    if (!this.#jeDekodiert) return true;
    return this.#ereignisse.length > 0 || this.#verworfen > 0;
  }
}
