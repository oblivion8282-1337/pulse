/**
 * Die Rechnung hinter dem Verlaufsumzug: schneiden, fortsetzen, Fortschritt
 * (Etappe F, E2E-DM).
 *
 * **Importfrei** (s. CLAUDE.md „Die Falle") — und zwar absichtlich die
 * VOLLSTAENDIGE Rechnung, nicht nur ein Rest davon. Die Rune-Huelle
 * (`zustand.svelte.ts`) und die Netzwerk-Schleifen (`senden.ts`,
 * `empfangen.ts`) enthalten danach keine Arithmetik mehr, sondern nur noch
 * Aufrufe. Fortsetzbarkeit ist genau die Eigenschaft, die man ohne Test nicht
 * glauben sollte.
 */

/** Ein Satz des lokalen Verlaufs, wie er ueber die Leitung geht. Bewusst
 *  `unknown`-vertraeglich getippt: dieses Modul rechnet ueber die MENGE, es
 *  liest kein Feld. Die Form gehoert `verlauf/schema.ts`. */
export type UmzugSatz = { schluessel: string };

/** Wie viele Saetze hoechstens in EIN Stueck gebuendelt werden.
 *
 *  Die Zahl ist eine Obergrenze fuer den Fall vieler kleiner Nachrichten, sie
 *  ist NICHT die Groessengrenze — die steht in Bytes (`umzug_max_stueck_bytes`,
 *  512 KiB) und wird von `stueckeSchneiden` zusaetzlich eingehalten. Bei
 *  1000 Saetzen à ~200 Byte liegt ein Stueck bei ~200 kB und damit unter der
 *  Byte-Grenze; wo die Saetze groesser sind, greift die Byte-Grenze zuerst. */
export const SAETZE_JE_STUECK = 1000;

/**
 * Schneidet die Saetze in Stuecke — beide Grenzen gleichzeitig eingehalten.
 *
 * `groesseVon` misst einen Satz in Bytes (der Aufrufer reicht die kodierte
 * Laenge herein; dieses Modul kennt keine Kodierung). `maxBytes` ist die
 * SERVER-Grenze abzueglich Reserve — nicht der Rohwert: nach dem Schneiden
 * kommen noch JSON-Rahmen, IV und GCM-Siegel dazu, und die Base64-Kodierung
 * waechst um ein Drittel. Der Aufrufer rechnet das ab, damit diese Funktion
 * eine reine Mengenrechnung bleibt.
 *
 * **Ein einzelner Satz, der fuer sich schon zu gross ist, bekommt trotzdem
 * sein eigenes Stueck** statt uebersprungen zu werden. Ihn stillschweigend
 * wegzulassen waere die schlimmere Variante: der Umzug meldete Erfolg und
 * eine Nachricht fehlte. Der Server weist ihn dann ab, und das ist ein
 * sichtbarer Fehler statt eines unsichtbaren Verlusts.
 */
export function stueckeSchneiden<T extends UmzugSatz>(
  saetze: T[],
  groesseVon: (satz: T) => number,
  maxBytes: number
): T[][] {
  const stuecke: T[][] = [];
  let laufend: T[] = [];
  let laufendeGroesse = 0;

  for (const satz of saetze) {
    const groesse = groesseVon(satz);
    const wuerdeSprengen =
      laufend.length > 0 &&
      (laufend.length >= SAETZE_JE_STUECK || laufendeGroesse + groesse > maxBytes);
    if (wuerdeSprengen) {
      stuecke.push(laufend);
      laufend = [];
      laufendeGroesse = 0;
    }
    laufend.push(satz);
    laufendeGroesse += groesse;
  }

  if (laufend.length > 0) stuecke.push(laufend);
  return stuecke;
}

/**
 * Welche Positionen noch fehlen — die Grundlage des Fortsetzens.
 *
 * `vorhanden` kommt vom Server (`vorhandene_stuecke` aus `POST /kopplung/stand`).
 * Der Sender schiebt danach GENAU diese Liste, nicht alles ab der ersten
 * Luecke: ein Abriss kann auch mitten drin passiert sein, wenn mehrere
 * Stuecke gleichzeitig unterwegs waren.
 */
export function fehlendeStuecke(gesamt: number, vorhanden: readonly number[]): number[] {
  const da = new Set(vorhanden);
  const fehlt: number[] = [];
  for (let i = 0; i < gesamt; i++) {
    if (!da.has(i)) fehlt.push(i);
  }
  return fehlt;
}

/** Was die Fortschrittsanzeige braucht. `anteil` ist 0..1. */
export type Fortschritt = {
  erledigt: number;
  gesamt: number;
  anteil: number;
  fertig: boolean;
};

/**
 * Fortschritt aus zwei Zahlen.
 *
 * **Der Sonderfall `gesamt === 0` ist der wichtige Teil**: ein Konto ohne
 * jeden lokalen Verlauf hat null Stuecke, und `0/0` ist keine Zahl. Die
 * Anzeige darf dann nicht `NaN %` zeigen und schon gar nicht ewig laufen —
 * ein leerer Umzug ist ein FERTIGER Umzug.
 */
export function fortschritt(erledigt: number, gesamt: number): Fortschritt {
  const sicher = Math.max(0, Math.min(erledigt, gesamt));
  return {
    erledigt: sicher,
    gesamt,
    anteil: gesamt === 0 ? 1 : sicher / gesamt,
    fertig: sicher >= gesamt
  };
}
