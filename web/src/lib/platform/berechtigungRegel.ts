/**
 * Soll vor dem System-Dialog eine Vorerklärung stehen? — die reine Regel.
 *
 * **Warum das ein eigener Punkt ist (iOS-Liste 36).** Ein System-Dialog für
 * Mitteilungen, Mikrofon oder Kamera erscheint auf iOS **genau einmal**. Sagt
 * der Nutzer dort „nein", ist die Sache dauerhaft entschieden — der nächste
 * Versuch kommt ohne Dialog zurück, und der einzige Weg zurück führt in die
 * System-Einstellungen. Bis hierher fragte Pulse die Mitteilungs-Erlaubnis
 * **beim Start** ab, bevor der Nutzer die App überhaupt gesehen hat. Das ist
 * der ungünstigste Augenblick, den es gibt: er hat keinen Grund, ja zu sagen,
 * und sein „nein" ist endgültig.
 *
 * Die Vorerklärung kostet einen Tipp und verwandelt den Dialog in eine Frage,
 * auf die man vorbereitet ist. Sie darf aber NICHT selbst zur Plage werden,
 * deshalb vier Bedingungen:
 *
 *  1. **Nur wenn noch offen.** `granted` braucht nichts, `denied` kann nichts
 *     mehr ändern — dort wäre die Vorerklärung eine Lüge, weil der Knopf
 *     danach keinen Dialog mehr öffnet.
 *  2. **Nur in einer Hülle.** Im Browser ist die Berechtigung an die Seite
 *     gebunden und jederzeit über das Schloss in der Adresszeile umkehrbar;
 *     die Einmaligkeit, gegen die wir hier arbeiten, gibt es dort nicht.
 *  3. **Ein „später" genügt — bei Mitteilungen.** Wer die Erklärung dort
 *     einmal weggetippt hat, sieht sie nicht wieder — die Erlaubnis bleibt
 *     über die Einstellungen erreichbar. Bei Kamera und Mikrofon bricht
 *     „später" nur die Handlung ab (s. `ablehnungMerken`).
 *  4. **Mitteilungen brauchen einen ANLASS.** Kamera und Mikrofon werden von
 *     einer Handlung ausgelöst (Kachel öffnen, Sprachkanal betreten), die den
 *     Grund selbst erklärt. Mitteilungen nicht — deshalb hängen sie an einer
 *     Mindestnutzung, damit die Frage nicht die erste Begegnung mit der App
 *     ist.
 *
 * Importfrei und damit prüfbar (s. die `pnpm test:unit`-Falle in CLAUDE.md).
 */

/** Was gefragt werden soll. */
export type Berechtigung = 'mitteilungen' | 'mikrofon' | 'kamera';

/** Stand der Berechtigung, wie die Plattform ihn meldet. */
export type Stand = 'offen' | 'erteilt' | 'verweigert';

/**
 * Wie viele eigene Nachrichten, bevor nach Mitteilungen gefragt wird.
 *
 * Bewusst klein: nach der ersten Unterhaltung ist der Nutzen offensichtlich
 * („ich will wissen, wenn geantwortet wird"), und zu langes Warten verschenkt
 * genau die Pushs, um die es geht. Dieselbe Mechanik wie die Bewertungsfrage
 * (`bewertungRegel.ts`), aber eine viel kleinere Zahl — eine Bewertung ist
 * eine Gefälligkeit, eine Mitteilung ein Dienst am Nutzer.
 *
 * Der Name trägt deshalb die Frage mit: `bewertungRegel.ts` hat eine Schwelle
 * auf dieselbe Zahl mit anderem Wert, und zwei gleichnamige Konstanten in
 * Nachbardateien sind genau der Verwechsler, der später still importiert wird.
 */
export const SENDUNGEN_BIS_ZUR_MITTEILUNGSFRAGE = 3;

export interface Lage {
  art: Berechtigung;
  stand: Stand;
  /** Läuft die App in einer Capacitor-Hülle? */
  inHuelle: boolean;
  /** Hat der Nutzer die Vorerklärung für DIESE Art schon weggetippt? */
  schonAbgelehnt: boolean;
  /** Eigene gesendete Nachrichten (nur für `mitteilungen` relevant). */
  sendungen: number;
}

/**
 * Wird ein „später" dauerhaft gemerkt?
 *
 * **Nur für Mitteilungen.** Dort gibt es keine auslösende Handlung: „später"
 * heisst „frag mich nicht wieder", und genau so wird es behandelt — erreichbar
 * bleibt die Erlaubnis über die Einstellungen.
 *
 * Bei Mikrofon und Kamera ist „später" dagegen **das Abbrechen der Handlung**,
 * nicht das Ablehnen der Erklärung: wer die Kamera öffnet und dann abbricht,
 * hat nichts über künftige Kamera-Öffnungen gesagt. Würde man es merken, käme
 * beim nächsten Öffnen der System-Dialog OHNE Erklärung — also genau das, was
 * dieser ganze Punkt verhindern soll, nur eine Runde später.
 */
export function ablehnungMerken(art: Berechtigung): boolean {
  return art === 'mitteilungen';
}

/**
 * Was vor dem System-Dialog geschieht.
 *
 * **Drei Ausgänge, nicht zwei.** Die erste Fassung kannte nur „Erklärung
 * nötig: ja/nein", und der Aufrufer las „nein" als „ohne Erklärung
 * weitermachen". Für Mitteilungen ist das genau verkehrt: „keine Erklärung,
 * weil noch kein Anlass" und „keine Erklärung, weil schon ‚später' gesagt"
 * heissen beide „jetzt NICHT fragen" — gelesen als „weiter" öffneten sie den
 * System-Dialog ohne Blatt, also das, was dieser ganze Punkt verhindern
 * soll (Bughunt 2026-10-11, T6).
 */
export type Vorgehen =
  /** Ohne Blatt weitermachen: im Browser, oder die Lage ist schon entschieden
   *  (`erteilt`/`verweigert` — der Dialog erscheint dann gar nicht mehr). */
  | 'weiter'
  /** Erst das Blatt, dann je nach Antwort der System-Dialog. */
  | 'erklaeren'
  /** Jetzt gar nicht fragen, auch nicht ohne Blatt: kein Anlass, oder die
   *  Erklärung wurde schon mit „später" weggetippt. */
  | 'nicht';

export function vorgehenVorDemDialog(lage: Lage): Vorgehen {
  if (!lage.inHuelle) return 'weiter';
  if (lage.stand !== 'offen') return 'weiter';
  // Nur dort, wo ein „später" überhaupt gemerkt wird — steht bei Kamera oder
  // Mikrofon trotzdem ein Merker, darf er die Handlung nicht sperren.
  if (lage.schonAbgelehnt && ablehnungMerken(lage.art)) return 'nicht';
  if (lage.art === 'mitteilungen') {
    return lage.sendungen >= SENDUNGEN_BIS_ZUR_MITTEILUNGSFRAGE ? 'erklaeren' : 'nicht';
  }
  return 'erklaeren';
}
