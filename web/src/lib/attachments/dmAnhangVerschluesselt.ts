/**
 * Ob DIESES Gespräch für den Anhang-Knopf als verschlüsselt gilt —
 * importfrei, damit sie ohne Svelte/Runes-Kompilierung prüfbar ist
 * (s. CLAUDE.md „Zwei Fallen").
 *
 * Anlass: `+page.svelte` speiste `verschluesselteAnhaenge` bisher aus dem
 * GLOBALEN Feature-Schalter (`E2E_DMS_ENABLED`) statt aus dem Schloss-Stand
 * DIESES Gesprächs (`krypto/schloss.svelte.ts::stand`). Sobald der Schalter
 * eingeschaltet wird, erschien die Büro-Klammer dadurch in JEDEM
 * Direktgespräch — auch bei einer Gegenstelle ohne dauerhaftes Gerät, wo die
 * Nachricht unverschlüsselt läuft und Anhänge auf diesem Weg verboten sind.
 *
 * Der Feature-Schalter bleibt die äußere Bedingung: aus → nie ein Knopf
 * (und wegen `schloss.sicherstellen()` auch nie ein Abruf). Erst wenn er an
 * ist, zählt der tatsächliche Stand — und davon nur ein striktes `true`.
 * `undefined` (Auskunft noch unterwegs) und `false` (Gegenstelle ohne
 * dauerhaftes Gerät) führen beide zu keinem Knopf.
 */
export function dmAnhangVerschluesselt(
  featureSchalterEin: boolean,
  gespraechsStand: boolean | undefined
): boolean {
  return featureSchalterEin && gespraechsStand === true;
}
