/**
 * Warum eine Einloesung scheitern kann — und wie man es der Antwort ansieht
 * (Etappe F, E2E-DM).
 *
 * **Importfrei** (s. CLAUDE.md „Die Falle"), und das ist hier kein
 * Formalismus: die erste Fassung dieser Zuordnung las `fehler.detail` und
 * lief damit ins Leere — `ApiError` (`api/client.ts`) traegt den Rumpf unter
 * `body`, und `detail` steckt erst darin. Jeder Fehlschlag waere als
 * „unbekannt" angekommen, also mit der einzigen Meldung, die dem Nutzer
 * nicht sagt, was zu tun ist. In `empfangen.ts` waere das von keinem Test
 * erreichbar gewesen (die Datei haengt an Svelte-Stores); hier ist es eine
 * Zeile Rechnung mit einem Test daneben.
 */

/** Die Gruende, die die Oberflaeche in Text uebersetzt (`messages/{de,en}.json`). */
export type EinloesFehler =
  | 'code_ungueltig'
  | 'kopplung_unbekannt'
  | 'kopplung_schon_eingeloest'
  | 'kopplung_abgelaufen'
  | 'kopplung_selbes_geraet'
  | 'unbekannt';

/** Die Gruende, die vom SERVER kommen koennen — `code_ungueltig` entsteht
 *  lokal (die Normalisierung schlaegt fehl), bevor ueberhaupt gefragt wird. */
const VOM_SERVER: readonly EinloesFehler[] = [
  'kopplung_unbekannt',
  'kopplung_schon_eingeloest',
  'kopplung_abgelaufen',
  'kopplung_selbes_geraet'
];

/**
 * Liest den Grund aus einem `ApiError`.
 *
 * Die Zuordnung geht ueber `detail`, NICHT ueber den Statuscode: 404 traegt
 * zwei Bedeutungen (unbekannter Code und falsche Rolle), und nur der `detail`
 * trennt sie. Ein unbekannter oder fehlender `detail` wird `unbekannt` — nie
 * stillschweigend einem der anderen zugeschlagen, sonst stuende beim Nutzer
 * ein Handgriff, der sein Problem nicht loest.
 */
export function einloesFehlerAus(fehler: unknown): EinloesFehler {
  const body = (fehler as { body?: unknown })?.body;
  const detail = (body as { detail?: unknown })?.detail;
  return VOM_SERVER.find((grund) => grund === detail) ?? 'unbekannt';
}
