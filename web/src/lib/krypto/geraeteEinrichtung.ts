/**
 * Die Rechnung hinter dem „Geraet jetzt einrichten"-Weg an der Wand —
 * importfrei, damit Nodes eingebauter Testlaeufer sie ohne Svelte-Runes und
 * ohne den WASM-/IndexedDB-Importkegel prueft (s. CLAUDE.md „Die Falle").
 * Die Verkabelung an `$state`, den Anmelde-Fluss und das Schloss liegt
 * daneben in `geraeteEinrichtung.svelte.ts`.
 *
 * Anlass ist B11 (2026-09-02): ein frisches App-Profil bekam beim Oeffnen der
 * Direktnachrichten die Wand, obwohl DIESES Geraet seine Schluessel haette
 * veroeffentlichen koennen. Zwei Ursachen, beide hier abgedeckt:
 *
 * 1. **Der Fluss lief, sein Ergebnis war aber unsichtbar.** Der Login stoesst
 *    `runIssueFlow` feuer-und-vergessen an; ein Fehlschlag der
 *    Schluessel-Veroeffentlichung landete nur in der Konsole. Der storende
 *    Lauf ist deshalb ein fehlbarer: wirft er, gilt die Einrichtung als
 *    fehlgeschlagen, und die Wand zeigt es (statt es still zu schlucken).
 * 2. **Die Wand sass auf einer veralteten Antwort.** Die einmal-je-Konto-
 *    Sperre des Schlosses (`schlossAbfrage.ts`) bewahrt die beim Betreten
 *    geholte Auskunft den ganzen Seitenaufruf lang auf — gelaufenes Setup
 *    hin oder her. Darum fragt `starten()` am Ende ERNEUT nach
 *    (`schloss.erneutFragen`), und nur dieser frische Stand entscheidet ueber
 *    Erfolg: die Wand verschwindet von selbst, sobald der Server das Geraet
 *    zaehlt.
 *
 * Der Lauf selbst ist der GEWOEHNLICHE Geraete-Anmelde-Fluss
 * (`identity/issue-flow.ts::starteGeraeteAnmeldung`, einmalig je
 * Seitenaufruf mit Warteschlange) — hier wird nichts neu geschrieben, nur
 * derselbe Weg mit sichtbarem Ergebnis versehen. Ein automatischer Anstoss
 * geschieht hoechstens einmal je Seitenaufruf (`automatischAnstossen`);
 * danach steht der Knopf fuer den Handlauf, und ein Fehlschlag startet KEINE
 * Schleife, sondern wartet auf den Nutzer.
 */

/** Der storende Geraete-Anmelde-Fluss (im Betrieb: `starteGeraeteAnmeldung`). */
export type EinrichtungLauf = () => Promise<void>;

/** Holt den eigenen Verschluesselbar-Stand FRISCH (im Betrieb:
 *  `schloss.erneutFragen`). `undefined` zaehlt als nicht gelungen. */
export type EigenerStandHolen = () => Promise<boolean | undefined>;

/** Der sichtbare Zustand — im Betrieb ein `$state`-Objekt, im Test ein
 *  blosses Objekt. Wird von der Fabrik hier mutiert. */
export interface EinrichtungZustand {
  laeuft: boolean;
  fehlgeschlagen: boolean;
}

/**
 * Baut die Einrichtungs-Steuerung. `laeuft` deckt bewusst auch die
 * Schlussfrage ab: ein Knopf, der zwischen „laeuft" und „fehlgeschlagen"
 * noch einmal aufblitzt, waere nur Flackern.
 */
export function geraeteEinrichtungErzeugen(
  lauf: EinrichtungLauf,
  eigenerStandHolen: EigenerStandHolen,
  stand: EinrichtungZustand
): {
  starten: () => Promise<boolean>;
  automatischAnstossen: () => void;
} {
  let automatischGestartet = false;

  /** Startet den Geraete-Anmelde-Fluss und entscheidet anhand des FRISCHEN
   *  eigenen Stands, ob er geholfen hat. Ein laufender Start verzehrt
   *  weitere Klicks (`false`, kein zweiter Parallellauf). */
  async function starten(): Promise<boolean> {
    if (stand.laeuft) return false;
    stand.laeuft = true;
    stand.fehlgeschlagen = false;
    try {
      await lauf();
      if ((await eigenerStandHolen()) !== true) {
        stand.fehlgeschlagen = true;
        return false;
      }
      return true;
    } catch {
      // Der Lauf selbst scheiterte — der naechste Anlauf muss es wirklich
      // erneut versuchen (`starteGeraeteAnmeldung` setzt fertig zurueck),
      // und die Wand zeigt es, statt den Fehler zu verschlucken (B11).
      stand.fehlgeschlagen = true;
      return false;
    } finally {
      stand.laeuft = false;
    }
  }

  /** Der automatische Anstoss beim Erscheinen der Wand — hoechstens einer je
   *  Seitenaufruf. Ein Fehlschlag bleibt sichtbar; der erneute Versuch ist
   *  eine Nutzer-Geste (der Knopf), keine Schleife. */
  function automatischAnstossen(): void {
    if (automatischGestartet) return;
    automatischGestartet = true;
    void starten();
  }

  return { starten, automatischAnstossen };
}
