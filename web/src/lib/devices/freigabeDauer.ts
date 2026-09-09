/**
 * Die Stufen, wie lange eine Freigabe gilt — feste Wahlen statt Zahl + Einheit.
 *
 * Bis zum 2026-09-09 gab es die Frage „wie lange" ZWEIMAL untereinander im
 * Reiter Remote-Rechner: einmal für den Hauptschalter (Knopfreihe, Zahl,
 * Einheit) und einmal je Freigabe-Zeile (Radio, Zahl, Einheit) — gleicher
 * Zustand, zwei Formen, und unklar, welche gewinnt. Seither hängt der Ablauf
 * nur noch an der Freigabe-Zeile, und dort reicht eine Liste fester Stufen:
 * ein freies Zahlenfeld konnte geleert werden (`null` über `bind:value`) und
 * brauchte dafür eine eigene Klemme; eine Stufe kann das nicht.
 *
 * Importfrei, damit Nodes Testläufer die Datei direkt prüfen kann
 * (`pnpm test:unit`); die Beschriftungen liegen bei der Oberfläche.
 */
export type FreigabeDauer = '1h' | '8h' | '1d' | '1w' | 'dauerhaft';

export const FREIGABE_DAUERN: readonly FreigabeDauer[] = ['1h', '8h', '1d', '1w', 'dauerhaft'];

/** Acht Stunden — ein Arbeitstag, dieselbe Spanne, die der Haken im
 *  Zustimmungsdialog seit jeher verspricht. */
export const FREIGABE_DAUER_VORGABE: FreigabeDauer = '8h';

const STUNDE_MS = 60 * 60 * 1000;
const SPANNE_MS: Record<Exclude<FreigabeDauer, 'dauerhaft'>, number> = {
  '1h': STUNDE_MS,
  '8h': 8 * STUNDE_MS,
  '1d': 24 * STUNDE_MS,
  '1w': 7 * 24 * STUNDE_MS,
};

export function istFreigabeDauer(wert: unknown): wert is FreigabeDauer {
  return typeof wert === 'string' && (FREIGABE_DAUERN as readonly string[]).includes(wert);
}

/** Der Ablauf in der Wire-Form (`expires_at`), `null` heisst dauerhaft. */
export function ablaufAb(dauer: FreigabeDauer, jetzt: number): string | null {
  if (dauer === 'dauerhaft') return null;
  return new Date(jetzt + SPANNE_MS[dauer]).toISOString();
}
