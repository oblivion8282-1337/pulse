/**
 * Darf DIESER Rechner sich überhaupt als Standplatz anbieten?
 *
 * Gegenstück zu `darfSteuern.ts`: dort geht es darum, ob ich jemanden steuern
 * darf, hier darum, ob ich mich steuern LASSEN kann. Zwei verschiedene Fragen —
 * steuern kann jeder Rechner, angeboten werden kann nur, wo es eine Gegenstelle
 * gibt.
 *
 * **Eingaben einspielen kann heute allein der Windows-Sidecar**
 * (`streaming/win-hq-sidecar/src/remote_input/`). Unter Linux und macOS gibt es
 * ihn nicht, und eine eingehende Übernahme wird in
 * `remote/session.svelte.ts` schweigend verworfen.
 *
 * **Warum das eine eigene Datei ist.** Die Bedingung stand bis zum 2026-08-18
 * an zwei Stellen getrennt — im Reiter-Gate (`SettingsDialog.svelte`) und in
 * der Übernahme (`session.svelte.ts`) — und die Anmeldung
 * (`ws/handlers/ready.ts`) hatte sie gar nicht. Ergebnis: der Reiter war unter
 * Linux versteckt, eine bereits vorhandene Eintragung meldete sich aber nach
 * jedem Verbinden weiter an. Der Rechner stand damit für alle als „bereit" in
 * der Kanalliste, während jede Übernahme ins Leere lief. Ein angebotener
 * Standplatz, den niemand holen kann, ist schlimmer als gar keiner: der Fehler
 * wird dann im Server gesucht.
 *
 * **`window.pulse.os` statt `isWindows()`.** Der Wert kommt aus
 * `process.platform` über die Electron-Brücke (`desktop/electron/preload.ts`)
 * und ist damit die Wahrheit. `platform/runtime.ts::isWindows()` rät am
 * Browser-Kennstring und ist für Anzeige-Kleinigkeiten gedacht — hier hängt
 * eine Zusage dran, die der Rechner einhalten muss.
 */

import { isElectron } from '$lib/platform/runtime';

export function darfStandplatzSein(): boolean {
  if (!isElectron()) return false;
  if (typeof window === 'undefined') return false;
  return window.pulse?.os === 'win32';
}
