/**
 * Fernsteuerung — die **Buchführung des Host-Vorrangs** auf der Host-Seite:
 * welche Stream-Plätze gerade übernommen haben, und wann darüber wieder eine
 * Meldung an den Steuernden hinausgeht.
 *
 * **Warum getrennt von [`./vorrang`]:** damit sie prüfbar ist. Der
 * Web-Testläufer (`pnpm test:unit`, Nodes eingebauter) kann eine Datei nur
 * ausführen, wenn sie keine erweiterungslosen Laufzeit-Importe mitschleppt —
 * die löst der Bundler auf, Node nicht. `vorrang.ts` importiert `./p2p`,
 * `./sidecarInput` und `./wachten` und ist damit für den Testläufer
 * unerreichbar; dieses Modul importiert **nichts** und bleibt es deshalb.
 * Gleiches Muster wie `zeigerbildPruefung.ts`, aus demselben Grund.
 *
 * **Seit 2026-08-19 liegt hier auch die Verdrahtung** ([`hostMeldungWeiterreichen`]),
 * nicht nur die Rechnung: in `vorrang.ts` liess sich der alte Flankenfilter
 * wieder einsetzen, ohne dass ein Test rot wurde — geprüft war die Rechnung,
 * nicht die Stelle, an der sie benutzt wird. Jetzt trifft hier die ganze
 * Entscheidung, und in `vorrang.ts` steht keine mehr (der Test hält das fest).
 *
 * Zugehöriger Test: `web/test/vorrang-takt.test.ts`.
 */

/**
 * In welchem Takt der Sidecar einen geltenden Vorrang wiederholt.
 *
 * `pulse-fernsteuerung/src/sitzung/vorrang.rs::WIEDERHOLUNG_TAKTE = 10` bei
 * 100 ms Wecker — also eine Sekunde. **Das ist die Zahl, die auf der Leitung
 * wirklich gilt**, und an ihr hängt die Geduld des Steuernden (`GEDULD_MS` in
 * [`./vorrang`]): der Deckel unten kann den Takt nur nach oben begrenzen,
 * nicht beschleunigen. Sie ist eher noch optimistisch —
 * `Sitzung::vorrang_tick()` überspringt den Zähler, wenn die Sitzungssperre
 * gerade belegt ist (`try_lock` → `WouldBlock`), unter Eingabelast wird der
 * Abstand also größer als eine Sekunde.
 */
export const SIDECAR_TAKT_MS = 1_000;

/**
 * Nach wie vielen Millisekunden ein geltender Vorrang erneut hinausgeht,
 * obwohl sich an ihm nichts geändert hat.
 *
 * Der Sidecar wiederholt einen geltenden Vorrang je Sekunde
 * ([`SIDECAR_TAKT_MS`]) — **das ist kein Rauschen, sondern der Herzschlag, an
 * dem der Steuernde ihn festhält.** Der Steuernde gibt einen Vorrang nach
 * `GEDULD_MS` Schweigen als beendet auf und zieht das Gehaltene nach; die
 * Mindestfrist des Vorrangs ist dagegen 5 s. Wird die Wiederholung hier am
 * Flankenfilter verschluckt, läuft die Geduld also mitten im geltenden Vorrang
 * ab: das Nachziehen fällt in die Sperre und wird vom Host über `host_active`
 * verworfen (samt `druck.loslassen()`), und das spätere echte „aus" fällt beim
 * Steuernden in denselben Flankenfilter, weil er den Vorrang längst für
 * beendet hält. Ergebnis: die gehaltene Taste bleibt am fernen Rechner tot.
 *
 * Deshalb geht die Wiederholung durch — aber gedeckelt. **Nicht, weil sonst
 * der Gateway-Deckel risse:** der liegt bei 60 Nachrichten je Sekunde
 * (`ws_remote_handlers.py::_SIGNAL_MAX_MESSAGES_PER_S`), ungebremst entstünde
 * hier je Platz rund eine Meldung je Sekunde, zusammen mit `zeiger` real etwa
 * zwei — davon ist der Deckel weit entfernt. Der Deckel hier ist eine
 * **Entdopplung über mehrere Plätze**: bei mehreren Streams meldet jeder
 * Sidecar-Prozess für sich denselben maschinenweiten Vorrang, und der
 * Steuernde erfährt daraus nichts Zusätzliches. Etwas unter einer Sekunde,
 * damit die Auffrischung des Sidecars nicht regelmäßig knapp danebenfällt —
 * gleiche Zahl und gleiche Begründung wie `AUFFRISCH_MS` in `zeigerform.ts`.
 * **Er begrenzt den Takt nur nach oben**; wie oft wirklich etwas hinausgeht,
 * bestimmt der Sender ([`SIDECAR_TAKT_MS`]).
 */
export const AUFFRISCH_MS = 900;

/** Was nach einer Sidecar-Meldung zu tun ist. */
export type VorrangEntscheidung = {
  /** Gilt jetzt (maschinenweit) ein Vorrang? */
  aktiv: boolean;
  /** Soll darüber eine Meldung an den Steuernden hinausgehen? */
  senden: boolean;
};

/**
 * Die Plätze, die gerade Vorrang melden — samt Verfallszeit und Sendetakt.
 *
 * Reine Rechnung: die Uhr kommt von außen herein (`jetzt`), damit der Test sie
 * stellen kann.
 */
export class VorrangBuch {
  /**
   * Welche Stream-Plätze gerade Vorrang melden, und **bis wann** ihre Meldung
   * noch gilt.
   *
   * **Warum je Platz:** je Platz läuft ein eigener Sidecar-Prozess mit eigener
   * Wache, und alle sehen denselben Host. Ihre Meldungen kommen dicht
   * hintereinander — ein einzelner Schalter würde vom `live` des einen Platzes
   * zurückgesetzt, während der andere noch übernommen hat.
   *
   * **Warum mit Verfallszeit** (Bughunt 2026-08-14): ein Platz verließ die
   * Menge früher nur über sein eigenes `live`. Endete sein Stream *während*
   * eines Vorrangs — etwa weil der Host mit genau dieser Handbewegung den
   * zweiten Stream beendet —, kam dieses `live` nie: der Sidecar fährt herunter
   * und meldet nichts mehr. Der Vorrang klemmte dann für den Rest der Sitzung
   * auf „aktiv", die Anzeige blieb stehen, und vor allem lief das Nachziehen
   * nie wieder. Ein Platz, dessen Meldung nicht aufgefrischt wird, fällt jetzt
   * von selbst heraus.
   */
  readonly #plaetze = new Map<number, number>();
  #aktiv = false;
  /** Wann zuletzt eine Meldung hinausging (`Date.now()`), 0 = noch nie. */
  #gesendetMs = 0;

  get aktiv(): boolean {
    return this.#aktiv;
  }

  /** Sitzungsende — alles vergessen. */
  leeren(): void {
    this.#plaetze.clear();
    this.#aktiv = false;
    this.#gesendetMs = 0;
  }

  /** Eine Meldung eines Sidecars einbuchen und entscheiden, was hinausgeht. */
  melden(platz: number, aktiv: boolean, restMs: number, jetzt: number): VorrangEntscheidung {
    if (aktiv) {
      // Die Auffrischung kommt je Sekunde; die Restzeit plus eine Sekunde
      // Reserve ist die Zeit, nach der diese Meldung als überholt gilt.
      this.#plaetze.set(platz, jetzt + restMs + 1_000);
    } else {
      this.#plaetze.delete(platz);
    }
    // Verfallene Plätze aussortieren — hier statt in einem Zeitgeber, weil
    // Chromium Zeitgeber in verdeckten Fenstern drosselt und der Host
    // typischerweise im Vollbild spielt (s. `wachten.ts`). Solange irgendein
    // Sidecar lebt, kommt je Sekunde ein Ereignis; stirbt der letzte, bleibt
    // die Sperre stehen, bis das nächste Ereignis sie räumt — und ohne
    // laufenden Sidecar kommt ohnehin keine Eingabe mehr durch.
    for (const [p, bis] of this.#plaetze) {
      if (bis <= jetzt) this.#plaetze.delete(p);
    }

    const gilt = this.#plaetze.size > 0;
    const wechsel = gilt !== this.#aktiv;
    // Ein Wechsel geht sofort hinaus. Eine Wiederholung des geltenden Vorrangs
    // ebenfalls, aber höchstens im Takt von [`AUFFRISCH_MS`] — sie hält die
    // Geduld des Steuernden am Leben (s. dort). Eine Wiederholung des
    // Nicht-Vorrangs geht gar nicht hinaus: für „kein Vorrang" gibt es beim
    // Steuernden nichts wachzuhalten.
    const senden = wechsel || (gilt && jetzt - this.#gesendetMs >= AUFFRISCH_MS);
    this.#aktiv = gilt;
    if (senden) this.#gesendetMs = jetzt;
    return { aktiv: gilt, senden };
  }
}

/** Was an den Steuernden hinausgeht, wenn eine Meldung fällig ist. */
export type VorrangSignal = { aktiv: boolean; rest_ms: number };

/**
 * Die **ganze** Host-Seite einer Sidecar-Meldung: deuten, einbuchen, und —
 * wenn fällig — hinausreichen.
 *
 * Rückgabe = der neue maschinenweite Zustand, `null` = die Meldung geht uns
 * nichts an (etwa `input_error` — den behandelt der fail-closed-Weg).
 *
 * **Warum das hier steht und nicht im Aufrufer:** damit die Entscheidung
 * „geht das hinaus?" geprüft ist — und zwar an der Stelle, an der sie wirklich
 * fällt. `vorrang.ts` reicht nur noch durch und darf keine eigene Bedingung
 * mehr enthalten; genau das prüft `vorrang-takt.test.ts` nach.
 *
 * `senden` meldet `false`, wenn die Nachricht nicht hinausging.
 */
export function hostMeldungWeiterreichen(
  buch: VorrangBuch,
  ev: unknown,
  jetzt: number,
  senden: (signal: VorrangSignal) => boolean,
): boolean | null {
  const meldung = ausMeldung(ev);
  if (meldung === null) return null;
  const { aktiv, senden: faellig } = buch.melden(
    meldung.platz,
    meldung.aktiv,
    meldung.restMs,
    jetzt,
  );
  // Hinaus geht nicht nur der Wechsel, sondern auch die Auffrischung
  // (s. [`AUFFRISCH_MS`]): der Steuernde hält einen geltenden Vorrang nur so
  // lange fest, wie er ihn wiederholt hört. Ein hier verschluckter Herzschlag
  // ist kein gesparter Verkehr, sondern eine klemmende Taste.
  if (faellig && !senden({ aktiv, rest_ms: meldung.restMs })) {
    // Ein einzelner verlorener Blip heilt von selbst — der Sidecar meldet je
    // Sekunde erneut —, deshalb nur eine Zeile fürs Protokoll.
    console.warn('[remote-vorrang] Meldung ging nicht hinaus — der Steuernde sieht sie nicht');
  }
  return aktiv;
}

/** Obergrenze für eine gemeldete Restzeit — die Wache hält Sekunden, nicht
 *  Tage. Schützt die Anzeige vor `Infinity` und absurden Zahlen. */
export const REST_MAX_MS = 60_000;

/** Eine gemeldete Restzeit auf etwas Anzeigbares bringen. */
export function restZeit(wert: unknown): number {
  if (typeof wert !== 'number' || !Number.isFinite(wert) || wert <= 0) return 0;
  return Math.min(wert, REST_MAX_MS);
}

/** Die Meldung des Sidecars, auf das Nötige eingedampft. `null` = geht uns
 *  nichts an. Ohne Platz in der Meldung zählt sie als Platz 0 — die Brücke
 *  hängt ihn an jedes Sidecar-Ereignis an, aber darauf zu BAUEN hiesse, dass
 *  eine ältere Shell den Vorrang wortlos verlöre. */
export function ausMeldung(ev: unknown): { aktiv: boolean; restMs: number; platz: number } | null {
  if (!ev || typeof ev !== 'object') return null;
  const m = ev as { ev?: unknown; state?: unknown; hold_ms?: unknown; slot?: unknown };
  if (m.ev !== 'remote_state') return null;
  if (m.state !== 'host_active' && m.state !== 'live') return null;
  const platz = typeof m.slot === 'number' && Number.isInteger(m.slot) ? m.slot : 0;
  return { aktiv: m.state === 'host_active', restMs: restZeit(m.hold_ms), platz };
}
