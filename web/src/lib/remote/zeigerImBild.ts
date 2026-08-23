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
