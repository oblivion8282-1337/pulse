/**
 * Sichere Standabfrage der Einloesen-Seite — importfrei (s. CLAUDE.md
 * „Die Falle") und ohne Netzwerkabhaengigkeit: der Aufrufer reicht den
 * eigentlichen Abruf als Funktion herein, hier steht nur die Fehlerbehandlung.
 *
 * **Bughunt 2026-08-29, Befund 2:** `standPruefen` in
 * `KopplungEinloesen.svelte` war die einzige der drei Funktionen dort ohne
 * try/catch. Ist die Kopplung weg (Sender hat abgebrochen, Frist abgelaufen),
 * wirft der Aufruf ungefangen — der Knopf sah aus, als taete er nichts, kein
 * Fehlertext, kein Hinweis. Diese Funktion faengt den Wurf und ordnet ihn
 * ueber `einloesFehlerAus` demselben Fehler-Vokabular zu, das `einloesen()`
 * schon benutzt.
 */
import { einloesFehlerAus } from './einloesFehler.ts';
import type { EinloesFehler } from './einloesFehler.ts';

export type StandErgebnis =
  | { ok: true; bereit: boolean; gesamt: number }
  | { ok: false; fehler: EinloesFehler };

/** `holen` liefert den rohen Server-Stand (`umzugStand` aus `empfangen.ts`);
 *  hier wird daraus entweder ein Bereitschafts-Signal oder ein zugeordneter
 *  Fehler — nie ein weiterer Wurf. */
export async function standSicherAbfragen(
  holen: () => Promise<{ gesamt: number | null }>
): Promise<StandErgebnis> {
  try {
    const stand = await holen();
    return { ok: true, bereit: stand.gesamt !== null, gesamt: stand.gesamt ?? 0 };
  } catch (fehler) {
    return { ok: false, fehler: einloesFehlerAus(fehler) };
  }
}
