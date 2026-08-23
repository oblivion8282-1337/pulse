/**
 * Die reine Rechnung hinter `darfStandplatzSein()` — ohne Zustand und ohne
 * Nachbarmodule, für Nodes Testläufer (`pnpm test:unit`; der Bundler löst
 * `$lib/...`-Aliase und `state.svelte`-Importe auf, Node nicht). Gleiches
 * Muster wie `zeigerbildPruefung.ts`.
 *
 * Zwei Bedingungen, beide müssen stehen:
 * - `electron`: nur die Desktop-Hülle hat überhaupt eine Brücke zu einem
 *   Sidecar — ein Browser-Tab kann nichts einspielen.
 * - `fernsteuerbar`: der laufende Sidecar hat die Eingabe-Fähigkeit selbst
 *   gemeldet (`health.gsr.remote_input` → `stream.fernsteuerbar`). Keine
 *   Plattform-Abfrage mehr: auf dem Mac ist genau dieser Wert wechselhaft
 *   (die Accessibility-Freigabe kann entzogen sein), auf Linux fehlt das
 *   Sidecar-Modul ganz, unter Windows ist er die Regel.
 */
export function darfStandplatzSeinAus(electron: boolean, fernsteuerbar: boolean): boolean {
  return electron && fernsteuerbar;
}
