/**
 * Der Kopplungscode — erzeugen, anzeigen, eintippen (Etappe F, E2E-DM).
 *
 * **Importfrei** (s. CLAUDE.md „Die Falle"): `crypto` ist in Browser und Node
 * global, alles andere hier ist reine Rechnung. Das ist kein Zufall, sondern
 * die Bedingung dafuer, dass die Normalisierung ueberhaupt geprueft werden
 * kann — und sie ist der Teil, der beim Eintippen entscheidet.
 *
 * ## Warum Crockford-Base32 und nicht Base64 oder Hex
 *
 * Der Code wird **abgelesen und eingetippt**, nicht kopiert. Base64 ist dafuer
 * untauglich (Gross-/Kleinschreibung bedeutungstragend, `+` und `/`), Hex
 * bräuchte fuer dieselbe Staerke die anderthalbfache Laenge. Crockford-Base32
 * laesst genau die Zeichen weg, die man beim Ablesen verwechselt — `I`, `L`,
 * `O` und `U` — und ordnet die ersten drei beim Lesen wieder ihren Zwillingen
 * zu (`I`/`L` → `1`, `O` → `0`). `U` faellt heraus, damit kein Wort entsteht,
 * das niemand vorlesen moechte.
 *
 * ## Wie stark
 *
 * 20 Zeichen à 5 Bit = **100 Bit**, gleichverteilt gezogen (Zurueckweisung
 * statt Modulo, s. `zeichenAusZufall` — Modulo auf 256 % 32 waere hier zwar
 * zufaellig gleichverteilt, aber nur, WEIL 32 ein Teiler von 256 ist; die
 * Zurueckweisung haelt auch, wenn jemand das Alphabet aendert).
 *
 * Ob 100 Bit noetig sind, entscheidet nicht das Raten ueber die Leitung — das
 * deckelt der Server ueber Einmal-Einloesung und 10-Minuten-Frist —, sondern
 * der gespeicherte Hash: aus ihm laesst sich der Code offline zurueckrechnen,
 * und aus dem Code der Schluessel der Umzugsstuecke (`transport.ts`). 100 Bit
 * sind dafuer ausser Reichweite. **Wer die Laenge kuerzt, kuerzt genau diese
 * Zahl** — nicht bloss die Tipparbeit.
 */

/** Crockford-Base32 ohne I, L, O, U. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** 20 × 5 Bit = 100 Bit. S. Modulkopf, bevor jemand kuerzt. */
export const CODE_LAENGE = 20;
/** Nur fuer die Anzeige — die gespeicherte und gehashte Form ist ohne. */
const GRUPPE = 5;

/**
 * Die eine Stelle, an der aus Zufallsbytes ein Zeichen wird.
 *
 * Zurueckgewiesen wird jedes Byte ab `grenze` — sonst haetten die ersten
 * `256 % ALPHABET.length` Zeichen eine hoehere Wahrscheinlichkeit als die
 * uebrigen. Bei 32 Zeichen ist der Rest heute null, die Schleife also
 * wirkungslos; sie steht da, damit eine spaetere Aenderung am Alphabet nicht
 * still die Gleichverteilung verliert.
 */
function zeichenAusZufall(): string {
  const grenze = 256 - (256 % ALPHABET.length);
  const puffer = new Uint8Array(1);
  for (;;) {
    crypto.getRandomValues(puffer);
    if (puffer[0] < grenze) return ALPHABET[puffer[0] % ALPHABET.length];
  }
}

/** Erzeugt einen frischen Code in seiner KANONISCHEN Form (ohne Trenner). */
export function codeErzeugen(): string {
  let code = '';
  for (let i = 0; i < CODE_LAENGE; i++) code += zeichenAusZufall();
  return code;
}

/**
 * Bringt eine Eingabe auf die kanonische Form — oder gibt `null` zurueck.
 *
 * **Diese Funktion ist die eigentliche Barrierefreiheit dieser Etappe.** Ein
 * Mensch tippt Bindestriche, Leerzeichen, Kleinbuchstaben und verwechselt
 * `O` mit `0`. Der Hash rechnet ueber die kanonische Form; ohne diese
 * Abbildung waere jede dieser Eingaben schlicht „Code unbekannt", und der
 * Nutzer haette keinen Anhaltspunkt, was er falsch gemacht hat.
 *
 * `null` heisst: die Eingabe kann gar kein Code sein (falsche Laenge oder ein
 * Zeichen ausserhalb des Alphabets). Der Aufrufer soll das VOR dem
 * Serveraufruf abfangen — ein hoffnungsloser Versuch verbraucht sonst eine
 * Rate-Chance und sieht fuer den Nutzer aus wie ein abgelaufener Code.
 */
export function codeNormalisieren(eingabe: string): string | null {
  const roh = eingabe
    .toUpperCase()
    .replace(/[\s-]/g, '')
    // Die drei Verwechslungen, die Crockford ausdruecklich vorsieht. `U` ist
    // NICHT dabei: es hat keinen Zwilling, es fehlt einfach.
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');

  if (roh.length !== CODE_LAENGE) return null;
  for (const zeichen of roh) {
    if (!ALPHABET.includes(zeichen)) return null;
  }
  return roh;
}

/** Zerlegt den Code fuer die Anzeige in Vierergruppen à fuenf Zeichen. */
export function codeAnzeigen(code: string): string {
  const gruppen: string[] = [];
  for (let i = 0; i < code.length; i += GRUPPE) gruppen.push(code.slice(i, i + GRUPPE));
  return gruppen.join('-');
}
