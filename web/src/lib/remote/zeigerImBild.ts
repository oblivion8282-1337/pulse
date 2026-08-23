/**
 * Der **Rückfall des Zeigers**: der Host kann seine Zeigerform nicht mehr
 * melden und legt seinen Zeiger stattdessen zurück ins Videobild — reine
 * Rechnung, ohne Zustand des Fensters und ohne Nachbarmodule.
 *
 * ## Wofür das da ist
 *
 * Im Regelfall nimmt der Host seinen Zeiger aus der Aufnahme (Cursor-Echo) und
 * meldet dem Steuernden nur die FORM (`kind:"zeiger"`, `./zeigerform`). Der
 * Steuernde sieht dann seinen eigenen, verzögerungsfreien Zeiger in der
 * richtigen Gestalt.
 *
 * Auf macOS hängt diese Meldung an `NSCursor.currentSystemCursor` — einer von
 * Apple **abgekündigten** Abfrage; der SDK-Kopf sagt wörtlich, sie werde in
 * einer künftigen Fassung immer `nil` liefern. Passiert das, schaltet der Mac
 * seinen Zeiger zurück ins Videobild (`showsCursor = true`) und meldet das als
 * `remote_signal` `kind:"zeiger_im_bild"`, `data: {aktiv: true}`. Der Player des
 * Steuernden blendet daraufhin seinen **lokalen** Zeiger aus: der Host-Zeiger
 * reitet im Bild mit, ist von Natur aus formrichtig und läuft der Hand um die
 * Übertragungszeit hinterher. **Schlechter, nicht kaputt** — die Funktion
 * altert, statt auszufallen.
 *
 * ## Warum getrennt von [`./zeigerform`]
 *
 * Damit die Entscheidung prüfbar ist. Nodes eingebauter Testläufer
 * (`pnpm test:unit`) kann eine Datei nur ausführen, wenn sie keine
 * erweiterungslosen Laufzeit-Importe mitschleppt — die löst der Bundler auf,
 * Node nicht. `zeigerform.ts` importiert `./sidecarInput` und ist damit
 * unerreichbar; dieses Modul importiert **nichts** und bleibt es deshalb.
 * Gleiches Muster wie `./zeigerbildPruefung` und `./vorrangTakt`.
 *
 * **Die drei Stellen, die dieselbe Art kennen müssen**, sind die Prüfliste des
 * Gateways (`ws_remote_handlers.py::_SIGNAL_KINDS`), der Typ `RemoteSignalKind`
 * (`$lib/ws/handlers/types.ts`) und der Player (`app/eingabe.rs`,
 * `app/zeigersicht.rs`).
 */

/**
 * Ist das eine Meldung „mein Zeiger steht jetzt im Bild"?
 *
 * **Der sichere Fall ist `false` — Zeiger sichtbar.** Alles, was hier
 * hereinkommt, stammt vom Rechner des Gegenübers und ist damit Fremdeingabe:
 * eine ältere oder neuere Gegenseite, ein selbstgebauter Client, eine
 * abgeschnittene Nutzlast. Ein doppelter Zeiger ist ein Schönheitsfehler, ein
 * fehlender kostet die Bedienbarkeit — deshalb gilt bei allem Zweifel
 * „sichtbar", und nur ein ausdrückliches `true` blendet aus.
 *
 * Geprüft wird streng auf den Wahrheitswert, nicht auf Wahrheitsähnlichkeit:
 * `{aktiv: "ja"}`, `{aktiv: 1}` und `{}` gelten alle als „nicht aktiv".
 */
export function deuteZeigerImBild(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  return (data as { aktiv?: unknown }).aktiv === true;
}

/**
 * **Die Host-Seite**: ist diese Sidecar-Meldung der Rückfall, und was sagt sie?
 *
 * `null` heisst „geht mich nichts an" — der Aufrufer macht mit seiner
 * gewohnten Behandlung weiter. Sonst der rohe Wahrheitswert, so wie er über
 * die Leitung gehen soll.
 *
 * **Warum das hier steht und nicht in [`./zeigerform`]:** dort fehlte die
 * Weiterleitung bis zum 2026-08-23 ganz, und zwar in einer Lücke genau
 * zwischen zwei Arbeiten — der Sidecar meldete, der Player konnte es deuten,
 * die Doku beschrieb es, und niemand reichte es weiter. Verworfen wurde es
 * wortlos. Ein Absturz wäre aufgefallen; ein stillschweigend wirkungsloser
 * Rückfall nicht: der Steuernde hätte einfach immer zwei Zeiger gesehen. Als
 * reine Funktion hat die Weiterleitung jetzt ein Netz, das ohne Bundler läuft.
 *
 * **Gedeutet wird hier NICHT**, ob ausgeblendet werden soll — das entscheidet
 * die Gegenseite mit [`deuteZeigerImBild`]. Zwei Deutungsorte wären zwei
 * Stellen, an denen sich die Regel auseinanderentwickeln kann.
 */
export function sidecarMeldungImBild(ev: unknown): boolean | null {
  if (!ev || typeof ev !== 'object') return null;
  const m = ev as { ev?: unknown; aktiv?: unknown };
  if (m.ev !== 'remote_pointer_in_frame') return null;
  return m.aktiv === true;
}

/**
 * **Die Drossel der Host-Seite**: mehrere Sidecar-Prozesse, eine Meldung.
 *
 * Der Zeiger ist maschinenweit einer, aber bei mehreren Schirmen laeuft je
 * Schirm ein Sidecar-Prozess, und jeder wiederholt seinen Stand je Sekunde —
 * gegen den still verwerfenden Sekundendeckel des Gateways, der sich Vorrang,
 * Zeigerform, Rueckfall und den ICE-Schwall teilt. Ohne Zusammenfassen gingen
 * bei drei Schirmen drei Meldungen je Sekunde hinaus statt einer.
 *
 * **Ein WECHSEL geht immer sofort hinaus**, nur die Wiederholung wird gebremst.
 * Das ist der Punkt: der Sender wiederholt ja gerade deshalb, damit ein
 * verlorenes `aktiv:true` heilt. Wer stattdessen jede Meldung im selben
 * Zeitfenster schluckt, nimmt der Heilung die Wirkung und verzoegert den
 * Wechsel um bis zu eine Sekunde.
 *
 * Gleiche Regel und gleiche Frist wie der Formweg in [`./zeigerform`].
 */
export class RueckfallDrossel {
  #gemeldet: boolean | null = null;
  #zuletztMs = 0;

  /**
   * Soll diese Meldung hinausgehen? `jetzt` kommt herein, damit die
   * Entscheidung ohne Uhr pruefbar ist.
   */
  melden(aktiv: boolean, jetzt: number, fristMs: number): boolean {
    if (aktiv === this.#gemeldet && jetzt - this.#zuletztMs < fristMs) return false;
    this.#gemeldet = aktiv;
    this.#zuletztMs = jetzt;
    return true;
  }
}

/**
 * Der Stand beim Steuernden: steht der Host-Zeiger gerade im Bild?
 *
 * Führt genau einen Wahrheitswert und beantwortet zwei Fragen — muss das
 * Player-Fenster etwas erfahren, und was gilt jetzt. Der Zustand liegt hier und
 * nicht in [`./zeigerform`], damit das Zurücksetzen beim Sitzungsende prüfbar
 * ist: **das ist der schlimmste denkbare Ausgang dieser Funktion** — bliebe der
 * lokale Zeiger nach dem Ende der Fernsteuerung ausgeblendet, säße der Nutzer
 * ohne Zeiger vor seinem eigenen Rechner.
 */
export class ZeigerImBild {
  #aktiv = false;

  /** Was gerade gilt. */
  get aktiv(): boolean {
    return this.#aktiv;
  }

  /**
   * Eine Meldung des Hosts. Liefert `true`, wenn sich der Stand geändert hat —
   * nur dann muss das Player-Fenster etwas erfahren.
   *
   * **Wiederholungen werden geschluckt**, wie beim Wechselfilter der Form: der
   * Sender wiederholt seine Auskunft je Sekunde, weil der Sekundendeckel des
   * Gateways still verwirft. Geht das erste „aktiv" verloren, heilt die nächste
   * Wiederholung es (der Stand hier ist dann noch `false`, also eine Änderung).
   * Ein verlorenes „nicht mehr aktiv" heilt dagegen NICHT von selbst — dagegen
   * steht [`beenden`] und, im Player, das Zurücksetzen beim Abschalten der
   * Erfassung.
   */
  signal(data: unknown): boolean {
    const neu = deuteZeigerImBild(data);
    if (neu === this.#aktiv) return false;
    this.#aktiv = neu;
    return true;
  }

  /**
   * Sitzungsende. Liefert `true`, wenn dem Player-Fenster noch eine
   * Rückstellung geschuldet ist — also genau dann, wenn der lokale Zeiger
   * gerade ausgeblendet ist.
   */
  beenden(): boolean {
    if (!this.#aktiv) return false;
    this.#aktiv = false;
    return true;
  }
}
