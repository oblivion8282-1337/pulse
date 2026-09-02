/**
 * Die rein lokale Nachrichten-ID des verschluesselten Wegs — EINE Stelle fuer
 * alle drei Sendewege (`senden.ts` fuer DMs, `gruppe/senden.ts` fuer private
 * Gruppen, `gruppe/kanalSenden.ts` fuer Ablage-Kanaele), die sie brauchen.
 *
 * **Warum ueberhaupt eine eigene ID:** der Server sieht diese Nachricht nie
 * und kann ihr deshalb keine Snowflake zuteilen.
 *
 * **Warum genau DIESES Format — es ist ein Vertrag, kein Geschmack.** Rein
 * numerisch (Millisekunden-Zeitstempel + Zufallsziffern gegen Kollisionen bei
 * gleichzeitigem Senden von zwei Geraeten desselben Kontos), damit
 * `sortierSchluessel`s `padStart` (lokales Verlauf-Schema, `verlauf/satz.ts`)
 * sie weiterhin lexikografisch nach Zeit einordnet. Und die STELLENZAHL ist
 * anderswo festgeschrieben: `utils/snowflakeZeit.ts` erkennt eine lokale ID an
 * ihren 20 Ziffern (`LOKALE_ID_LAENGE`) und liest die ersten 13 als
 * `Date.now()` (`LOKALE_ID_ZEIT_STELLEN`). **Wer hier die Breite aendert,
 * aendert dort mit** — sonst deutet der Sortiervergleich lokale IDs still als
 * Server-Snowflakes um.
 *
 * Genau dieser Vertrag lag bis zum 2026-09-01 dreimal im Baum, jede Kopie mit
 * eigenem Kommentar; hier steht er einmal.
 *
 * Importfrei (s. CLAUDE.md zur Falle bei `pnpm test:unit`), damit die Form
 * ohne Bundler pruefbar bleibt.
 */

/** 13 Stellen `Date.now()` + 7 Zufallsstellen = 20 Ziffern, s. Modulkopf. */
const ZEIT_STELLEN = 13;
const ZUFALL_STELLEN = 7;

export function lokaleNachrichtId(): string {
  const zeit = Date.now().toString().padStart(ZEIT_STELLEN, '0');
  const zufall = Math.floor(Math.random() * 10 ** ZUFALL_STELLEN)
    .toString()
    .padStart(ZUFALL_STELLEN, '0');
  return zeit + zufall;
}
