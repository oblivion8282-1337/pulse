/**
 * Schluessel, unter dem eine Olm-Sitzung in `sitzungen.ts` abgelegt wird —
 * importfrei, damit Nodes eingebauter Testlaeufer die Datei ohne Bundler
 * prueft (s. CLAUDE.md „Die Falle").
 *
 * Eine Sitzung besteht je GERAETEPAAR, nicht je Gespraech (s.
 * `docs/superpowers/plans/2026-08-28-etappe-d2-klient-verschluesselt.md`
 * Task 1). Weil eine DM aber strikt zu zweit ist (`DirectMessageChannel`,
 * Unique-Index), identifiziert (Kanal, Gegenstellen-Geraet) dasselbe
 * Geraetepaar wie (eigenes Geraet, Gegenstellen-Geraet) — das eigene Geraet
 * ist implizit, es ist ja der Speicher DIESES Geraets. Der Kanal steht
 * trotzdem mit im Schluessel: er macht Sitzungen je Gespraech auffindbar
 * (Kopplung/Aufraeumen) und traegt bereits die Eindeutigkeit von Task 3
 * (Zustellungen kommen kanalgebunden herein).
 */
export function sitzungsSchluessel(kanalId: string, geraetePubkey: string): string {
  return `${kanalId}:${geraetePubkey}`;
}
