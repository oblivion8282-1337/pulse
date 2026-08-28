/**
 * **Der Kern der Etappe G: wann eine Gruppensitzung sterben MUSS.**
 *
 * Megolm verschluesselt eine Gruppennachricht EINMAL; den Gruppenschluessel
 * bekommt jedes Geraet jedes Mitglieds ueber seine 1:1-Olm-Sitzung. Wer den
 * Verteilschluessel einmal hat, liest damit alles, was noch mit ihm
 * verschluesselt wird — auch nachdem er die Gruppe verlassen hat. Eine
 * ausgeschiedene Person auszusperren, heisst deshalb: **die Sitzung
 * wegwerfen und eine neue beginnen.** Es gibt keinen anderen Weg; man kann
 * einen verteilten Schluessel nicht zurueckholen.
 *
 * **Woran der Klient einen Mitgliederwechsel bemerkt — und warum das hier
 * nicht die entscheidende Frage ist.** Nachgesehen, nicht geraten: es gibt
 * heute KEIN Ereignis darueber. `routes/private_gruppen.py` publiziert
 * nichts (kein `publish`, kein `broadcast` in der ganzen Datei), die
 * Ereignis-Registry (`shared/src/dcc_shared/events/__init__.py`) fuehrt kein
 * Gruppen-Ereignis, und der `ready`-Rahmen (`routes/ws_ready.py`) traegt
 * keine Gruppenliste. Ein Klient erfaehrt einen Wechsel heute nur, indem er
 * `GET /gruppen/{id}` erneut liest.
 *
 * **Deshalb haengt die Sicherheitszusage hier NICHT an einem Ereignis.**
 * Die Rechnung unten bekommt die Mitgliederliste, die der Absender
 * unmittelbar vor DIESER Sendung vom Server gelesen hat, und vergleicht sie
 * mit der Liste, fuer die die laufende Sitzung angelegt wurde. Weicht sie ab
 * — in welche Richtung auch immer —, ist die Sitzung verbraucht. Ein
 * verpasstes Ereignis kostet damit nichts: es gibt keinen Zustand, der
 * nachgefuehrt werden muesste. Ein spaeter nachgeruestetes Ereignis waere
 * eine Verbesserung der ANZEIGE (die Mitgliederliste anderer Teilnehmer ist
 * schneller aktuell), nicht der Sicherheit.
 *
 * **Was diese Zusage NICHT deckt, und das gehoert ausgesprochen:** sie ist
 * die Zusage eines ehrlichen Absenders. Der Server kann sie nicht pruefen —
 * er sieht den Gruppenschluessel nie und kann nicht wissen, mit welcher
 * Sitzung eine Nachricht verschluesselt wurde. Was der Server beitraegt, ist
 * die ZUSTELLUNG: `POST /postfach` legt nur in Postfaecher von Geraeten, die
 * einem Teilnehmer des Kanals gehoeren (`empfaenger_nicht_im_kanal`). Ein
 * Ausgeschiedener bekommt also nichts mehr geliefert — mitlesen koennte er
 * nur, was er selbst noch abfaengt, und nur solange der Absender seine alte
 * Sitzung weiterbenutzt. Genau das schliesst diese Datei aus.
 *
 * **Ein NEU hinzugekommenes Mitglied darf den Verlauf davor nicht lesen.**
 * Das traegt Megolm selbst: `GroupSession::session_key()` liefert den
 * Schluessel ab dem AKTUELLEN Ratchet-Stand, und ein Megolm-Ratchet laeuft
 * nur vorwaerts (nachgesehen in vodozemac-0.10.0, s. Modulkopf von
 * `krypto/pulse-krypto/src/gruppe.rs`). Der Wechsel bei jeder Aenderung
 * macht daraus eine Zusage, die nicht am Ratchet-Stand haengt: der Neuling
 * bekommt einen Schluessel, mit dem vorher NIE etwas verschluesselt wurde.
 *
 * **Generisch ueber den Sitzungstyp — und das ist Absicht.** Die echte
 * Gruppensitzung ist eine WASM-Klasse; ein Import davon machte diese Datei
 * fuer Nodes eingebauten Testlaeufer unerreichbar (s. CLAUDE.md „Die
 * Falle"). Sie ist deshalb importfrei und kennt vom Sitzungsobjekt nichts
 * ausser, dass es existiert. Der echte Sender reicht `Gruppensitzung`
 * herein, der Test reicht dieselbe echte Klasse ueber das WASM-Paket herein
 * (`web/test/krypto-gruppe-wasm.test.ts`) — keine Attrappe.
 */

/** Wie lange und wie oft eine Sitzung ohne Anlass weiterlaufen darf. */
export type Wechselgrenzen = {
  /** Hoechstzahl Nachrichten je Sitzung. */
  hoechstzahlNachrichten: number;
  /** Hoechstalter einer Sitzung in Millisekunden. */
  hoechstalterMs: number;
};

/**
 * Vorgabewerte. **Nicht gemessen, sondern uebernommen** — es sind die im
 * Matrix-Oekosystem ueblichen Megolm-Werte (100 Nachrichten, 7 Tage). Sie
 * begrenzen das Fenster, in dem ein erbeuteter Gruppenschluessel noch etwas
 * oeffnet; die Spec verlangt einen Wechsel „nach Anzahl Nachrichten oder
 * Zeit", nennt aber keine Zahl. Wer sie aendert, aendert nur, wie oft eine
 * Verteilrunde anfaellt — die Korrektheit haengt an keiner der beiden.
 */
export const VORGABE_GRENZEN: Wechselgrenzen = {
  hoechstzahlNachrichten: 100,
  hoechstalterMs: 7 * 24 * 60 * 60 * 1000
};

/**
 * Eine laufende ausgehende Gruppensitzung samt allem, was ueber sie bekannt
 * sein muss. `S` ist der Sitzungstyp (s. Modulkopf).
 */
export type Gruppenstand<S> = {
  /** Kennung dieser Sitzung — faehrt in jedem Verteilschluessel und in
   *  jeder Gruppennachricht mit, damit der Empfaenger weiss, welche seiner
   *  eingehenden Sitzungen gemeint ist (`gruppenNutzlast.ts`). */
  sitzungId: string;
  sitzung: S;
  /** Die Konto-IDs, fuer die diese Sitzung angelegt wurde. Reihenfolge egal
   *  — verglichen wird als Menge. */
  mitglieder: string[];
  /** Geraete-Pubkeys, die den Verteilschluessel dieser Sitzung schon
   *  bekommen haben. Ein neues Geraet eines BESTEHENDEN Mitglieds bekommt
   *  ihn nachgereicht, ohne dass die Sitzung stirbt. */
  beliefert: string[];
  /** Wie viele Nachrichten mit ihr schon verschluesselt wurden. */
  nachrichten: number;
  /** Zeitpunkt der Anlage (ms seit Epoche). */
  angelegtAm: number;
};

/** Warum eine neue Sitzung noetig war — wandert in kein Protokoll, sondern
 *  nur in die Rueckgabe (und von dort in die Tests). */
export type Wechselgrund = 'keine' | 'mitgliederwechsel' | 'anzahl' | 'alter';

export type Sitzungswahl<S> = {
  stand: Gruppenstand<S>;
  /** Geraete, die den Verteilschluessel dieser Sitzung noch bekommen
   *  muessen, BEVOR mit ihr verschluesselt werden darf. Bei einer neuen
   *  Sitzung sind das alle; bei einer weiterlaufenden nur die noch nicht
   *  belieferten. */
  nachzuliefern: string[];
  /** `null`, wenn die vorhandene Sitzung weiterlaeuft. */
  grund: Wechselgrund | null;
};

function alsMenge(werte: string[]): Set<string> {
  return new Set(werte);
}

function mengenGleich(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const wert of a) {
    if (!b.has(wert)) return false;
  }
  return true;
}

/**
 * Entscheidet, ob die vorhandene Sitzung weiterlaeuft oder eine neue
 * beginnen muss — und wer den Verteilschluessel noch braucht.
 *
 * `mitglieder` und `geraete` sind der Stand, den der Absender GERADE vom
 * Server gelesen hat (Mitgliederliste aus `GET /gruppen/{id}`, Geraete aus
 * `POST /keys/claim`). Beide muessen frisch sein — mit einem
 * zwischengespeicherten Stand waere die Zusage aus dem Modulkopf wertlos,
 * denn dann entschiede der Cache, wen man aussperrt.
 *
 * `neueSitzung` wird NUR aufgerufen, wenn wirklich eine neue gebraucht wird
 * (das Erzeugen kostet Schluesselmaterial), und ist deshalb eine Funktion
 * statt eines Werts.
 */
export function sitzungWaehlen<S>(
  vorhanden: Gruppenstand<S> | null,
  mitglieder: string[],
  geraete: string[],
  neueSitzung: () => { sitzung: S; sitzungId: string },
  jetzt: number,
  grenzen: Wechselgrenzen = VORGABE_GRENZEN
): Sitzungswahl<S> {
  const grund = wechselgrund(vorhanden, mitglieder, jetzt, grenzen);
  if (vorhanden === null || grund !== null) {
    const { sitzung, sitzungId } = neueSitzung();
    return {
      stand: {
        sitzungId,
        sitzung,
        mitglieder: [...mitglieder],
        beliefert: [],
        nachrichten: 0,
        angelegtAm: jetzt
      },
      // Eine frische Sitzung hat noch niemand — jedes Geraet braucht sie.
      nachzuliefern: [...geraete],
      grund: grund ?? 'keine'
    };
  }

  const schonBeliefert = alsMenge(vorhanden.beliefert);
  return {
    stand: vorhanden,
    // Ein neues GERAET eines bestehenden Mitglieds ist kein Grund fuer eine
    // neue Sitzung: es gehoert einer Person, die den Verlauf ohnehin lesen
    // darf. Es bekommt den laufenden Schluessel nachgereicht — ab dem
    // AKTUELLEN Ratchet-Stand, was heisst: auch das eigene neue Geraet sieht
    // aeltere Gruppennachrichten nicht. Das ist derselbe Vorwaertslauf, der
    // oben den Neuling aussperrt, und hier ein Nachteil statt eines Schutzes
    // — der lokale Verlauf wandert nicht zwischen Geraeten, ein frisch
    // gekoppeltes Geraet startet in einer Gruppe also leer.
    nachzuliefern: geraete.filter((g) => !schonBeliefert.has(g)),
    grund: null
  };
}

/**
 * Der reine Vergleich, ohne Sitzungserzeugung — `null` heisst „weiterlaufen
 * lassen". Getrennt exportiert, damit ein Test genau diese Entscheidung
 * pruefen kann, ohne eine Sitzung zu bauen.
 */
export function wechselgrund<S>(
  vorhanden: Gruppenstand<S> | null,
  mitglieder: string[],
  jetzt: number,
  grenzen: Wechselgrenzen = VORGABE_GRENZEN
): Wechselgrund | null {
  if (vorhanden === null) return 'keine';
  // Die wichtigste Zeile der Datei. Verglichen wird in BEIDE Richtungen:
  // ein Abgang muss aussperren, ein Zugang darf den Verlauf davor nicht
  // oeffnen — beides ist derselbe Vergleich.
  if (!mengenGleich(alsMenge(vorhanden.mitglieder), alsMenge(mitglieder))) {
    return 'mitgliederwechsel';
  }
  if (vorhanden.nachrichten >= grenzen.hoechstzahlNachrichten) return 'anzahl';
  if (jetzt - vorhanden.angelegtAm >= grenzen.hoechstalterMs) return 'alter';
  return null;
}

/**
 * Traegt nach einer erfolgreichen Verteilrunde nach, welche Geraete den
 * Schluessel jetzt haben, und zaehlt die verschluesselte Nachricht mit.
 * Bewusst eine eigene, reine Funktion: der Aufrufer sichert den Stand
 * danach, und diese Rechnung soll ohne IndexedDB pruefbar bleiben.
 */
export function standNachSendung<S>(
  stand: Gruppenstand<S>,
  beliefert: string[]
): Gruppenstand<S> {
  return {
    ...stand,
    beliefert: [...new Set([...stand.beliefert, ...beliefert])],
    nachrichten: stand.nachrichten + 1
  };
}
