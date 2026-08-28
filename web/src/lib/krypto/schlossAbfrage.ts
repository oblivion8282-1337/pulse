/**
 * Reine Rechnung: WANN wird die Schloss-Auskunft geholt — importfrei, damit
 * Nodes eingebauter Testlaeufer sie ohne Bundler prueft (s. CLAUDE.md „Die
 * Falle"). Der `$state`-tragende Speicher liegt daneben in
 * `schloss.svelte.ts` und reicht seine beiden Aussenanschluesse hier herein.
 *
 * Die eine Aufgabe dieses Moduls ist die Sperre gegen Mehrfachabrufe. Das
 * Kennzeichen haengt an einem `$effect`, und ein Effekt laeuft erneut, sobald
 * IRGENDEINE gelesene Abhaengigkeit sich ruehrt — beim Betreten desselben
 * Gespraechs also durchaus mehrmals. Ohne Sperre stuende hinter jedem
 * Gespraechswechsel und jeder Neuberechnung ein weiterer Serveraufruf.
 *
 * **Was hier NICHT passiert: entscheiden, ob verschluesselt gesendet wird.**
 * Diese Auskunft ist eine Momentaufnahme und veraltet — die Gegenseite kann
 * ihr letztes dauerhaftes Geraet abmelden, waehrend das Gespraech offen ist.
 * Die Autoritaet bleibt der Sendezeitpunkt: `krypto/senden.ts` holt dort
 * die Buendel frisch und rechnet die Koexistenz-Regel neu
 * (`empfaengerGeraete.ts::zielgeraeteBerechnen`). Was hier steht, faerbt ein
 * Symbol — mehr nicht.
 */

/** Holt die Auskunft fuer ein Konto (im Betrieb: `keysApi.verschluesselbar`). */
export type SchlossHolen = (userId: string) => Promise<boolean>;

/** Traegt das Ergebnis in den reaktiven Speicher (im Betrieb: `$state`). */
export type SchlossMelden = (userId: string, verschluesselbar: boolean) => void;

/**
 * Baut die Abfrage-Funktion: je Konto hoechstens ein Serveraufruf.
 *
 * Ein FEHLGESCHLAGENER Abruf wird bewusst wieder freigegeben — sonst bliebe
 * das Schloss nach einem einzelnen Netzwackler fuer die ganze Sitzung aus,
 * obwohl das Gespraech verschluesselt laufen kann. Zu einer Schleife wird das
 * nicht: der Aufrufer fragt nur beim Betreten eines Gespraechs, nicht in
 * einem Takt.
 */
export function schlossAbfrageErzeugen(
  holen: SchlossHolen,
  melden: SchlossMelden
): (userId: string) => Promise<void> {
  const gefragt = new Set<string>();

  return async function sicherstellen(userId: string): Promise<void> {
    if (!userId || gefragt.has(userId)) return;
    gefragt.add(userId);
    try {
      melden(userId, await holen(userId));
    } catch {
      gefragt.delete(userId);
    }
  };
}
