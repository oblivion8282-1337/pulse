/**
 * Wie eine Zeile der eigenen Geraeteliste zu lesen ist (Spec §3b, Punkt 4).
 *
 * Importfrei, damit Nodes eingebauter Testlaeufer sie ohne Bundler prueft
 * (s. CLAUDE.md „Zwei Fallen"); die Anzeige selbst steht in
 * `components/settings/GeraeteListeSection.svelte`.
 *
 * **Es gibt keinen Geraetenamen, und das ist eine Entscheidung.** Ein Name
 * waere eine Selbstauskunft — ausgerechnet des Geraets, das man vielleicht
 * gerade hinauswerfen will. Er machte die eine Frage, fuer die es diese
 * Liste gibt („steht hier etwas, das ich nicht kenne?"), nicht leichter,
 * sondern schwerer: ein fremder Eintrag namens „Michaels Laptop" faellt
 * weniger auf als einer ohne Namen. Wer spaeter doch einen einfuehrt, fuehrt
 * ihn als das ein, was er ist — eine Behauptung des Geraets, die nichts
 * absichert —, und darf nichts daran haengen.
 *
 * Was stattdessen unterscheidet, ist ueberpruefbar:
 *
 * * die **Art** (App, gekoppelter Browser, loser Tab) — auch sie zum Teil
 *   Selbstauskunft (`dauerhaft`), aber `gekoppelt_am` setzt der Server;
 * * die **Zeitpunkte** — „hinzugefuegt am 12." beantwortet „war ich das?";
 * * die **Kurzkennung** — der Anfang des oeffentlichen Geraeteschluessels.
 *   Sie ist das einzige Merkmal, das man GEGENPRUEFEN kann: dasselbe Geraet
 *   zeigt in seinen eigenen Einstellungen dieselbe Zeile als „dieses Geraet".
 */

/** Was von einer Zeile fuer die Anzeige gebraucht wird — absichtlich ein
 *  Ausschnitt von `api/keys.ts::EigenesGeraet` und nicht dessen Import: das
 *  haelt diese Datei importfrei. */
export interface GeraetAnzeigeDaten {
  device_pubkey: string;
  dauerhaft: boolean;
  gekoppelt_am: string | null;
}

/**
 * `app` — Electron oder Android, meldet sich als `dauerhaft` und verfaellt
 * nie. `gekoppelt` — ein Browser, der per Kopplungscode gebunden wurde;
 * zaehlt wie eine App, verfaellt aber nach 14 Tagen ohne Benutzung.
 * `browser` — ein loser Tab: kann Schluessel veroeffentlichen, gilt aber
 * nicht als teilnahmefaehiges Geraet (Koexistenz-Regel, Spec §3).
 *
 * `dauerhaft` schlaegt `gekoppelt_am`: eine App, die zusaetzlich einmal
 * gekoppelt wurde, bleibt eine App — sie ist die haltbarere der beiden
 * Aussagen, und nur sie entscheidet ueber den Verfall.
 */
export function geraeteArt(g: GeraetAnzeigeDaten): 'app' | 'gekoppelt' | 'browser' {
  if (g.dauerhaft) return 'app';
  if (g.gekoppelt_am) return 'gekoppelt';
  return 'browser';
}

/** Wie viele Zeichen der Kennung gezeigt werden. Zwoelf reichen weit: ein
 *  Konto fuehrt hoechstens `schluessel_max_buendel_je_konto` (20) Geraete,
 *  und die Kennung ist ein Base64url-Schluessel — zwei davon in EINEM Konto
 *  auf zwoelf Zeichen zusammenfallen zu lassen, ist praktisch unmoeglich.
 *  Es geht hier ums Wiedererkennen, nicht um einen Fingerabdruck gegen einen
 *  Angreifer; wer die Kennung faelschen koennte, koennte auch die Zeile
 *  faelschen. */
const KURZ_ZEICHEN = 12;

/**
 * Die Kurzkennung, in Vierergruppen — dieselbe Darstellung auf jedem Geraet,
 * damit ein Vergleich von Bildschirm zu Bildschirm ohne Zaehlen auskommt.
 *
 * Eine zu kurze Kennung (kaputte oder alte Serverantwort) wird gezeigt, wie
 * sie ist, statt aufgefuellt: eine erfundene Stelle waere schlimmer als eine
 * fehlende, weil der Vergleich dann falsch ausfiele statt gar nicht.
 */
export function kennungKurz(devicePubkey: string): string {
  const roh = devicePubkey.slice(0, KURZ_ZEICHEN);
  return (roh.match(/.{1,4}/g) ?? []).join(' ');
}

/**
 * Ob diese Zeile das Geraet ist, an dem gerade jemand sitzt.
 *
 * Der Vergleich gehoert in den Klienten und nicht auf den Server: dieser
 * kennt die eigene Kennung nur, wenn man sie ihm nennt — und eine Anfrage,
 * die sie nennt, frischt `zuletzt_benutzt` auf und faelscht damit genau die
 * Spalte, die die Liste anzeigt (`routes/geraete.py`).
 *
 * `eigene` ist `null`, solange die Kennung noch nicht geladen ist (oder ihre
 * Ermittlung scheiterte). Dann ist die Antwort fuer jede Zeile `false` —
 * keine Markierung ist besser als eine falsche: der Nutzer entfernte sonst
 * sein eigenes Geraet im Glauben, es sei ein fremdes. Ein eigener Riegel
 * dagegen steht hier bewusst NICHT; der blosse Vergleich leistet es schon,
 * weil `null` mit keiner Kennung uebereinstimmt.
 */
export function istDiesesGeraet(devicePubkey: string, eigene: string | null): boolean {
  return devicePubkey === eigene;
}

/**
 * Ob das Entfernen dieser Zeile das Konto ohne teilnahmefaehiges Geraet
 * zuruecklaesst — die einzige Folge, die der Nutzer nicht selbst sehen kann.
 *
 * Gezaehlt wird nach derselben Regel wie in
 * `GET /keys/verschluesselbar`: App oder gekoppelter Browser, und nicht
 * verfallen. Ein loser Tab zaehlt nicht mit, sonst beruhigte die Warnung
 * gerade dort, wo sie noetig ist.
 *
 * Der Server verbietet diesen Fall NICHT (Begruendung in
 * `routes/geraete.py::geraet_ausschliessen`) — genau deshalb muss die
 * Oberflaeche ihn benennen.
 */
export function letztesTeilnahmefaehiges(
  geraete: (GeraetAnzeigeDaten & { verfallen: boolean })[],
  devicePubkey: string
): boolean {
  const zaehlbar = geraete.filter((g) => !g.verfallen && geraeteArt(g) !== 'browser');
  return zaehlbar.length === 1 && zaehlbar[0].device_pubkey === devicePubkey;
}
