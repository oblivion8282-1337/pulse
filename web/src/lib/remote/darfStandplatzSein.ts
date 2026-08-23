/**
 * Darf DIESER Rechner sich überhaupt als Standplatz anbieten?
 *
 * Gegenstück zu `darfSteuern.ts`: dort geht es darum, ob ich jemanden steuern
 * darf, hier darum, ob ich mich steuern LASSEN kann. Zwei verschiedene Fragen —
 * steuern kann jeder Rechner, angeboten werden kann nur, wo es eine Gegenstelle
 * gibt.
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
 * **Die Fähigkeit statt der Plattform.** Bis zum 2026-08-23 stand hier eine
 * feste Abfrage `window.pulse.os === 'win32'` — Windows war der einzige
 * Sidecar mit Eingabe-Injektion. Seit macOS einen eigenen Injektor hat
 * (`streaming/mac-hq-sidecar/`), wäre „ist das Windows?" um `'darwin'` zu
 * erweitern die falsche Reparatur gewesen: es bliebe eine Abfrage nach der
 * Plattform, keine nach dem tatsächlichen Können. Gefragt wird jetzt die
 * Fähigkeit selbst — `stream.fernsteuerbar` (`stream/state.svelte.ts`),
 * gespeist aus `health.gsr.remote_input`, das der jeweils laufende Sidecar
 * live meldet.
 *
 * Auf dem Mac ist das mehr als Kosmetik: die Fähigkeit ist dort
 * **wechselhaft**. Sie hängt an der Accessibility-Freigabe in den
 * Systemeinstellungen, und die wiederum an der Code-Signatur — das mac-DMG
 * ist nur ad-hoc signiert, jedes Update ändert die Signatur, und die Freigabe
 * gilt danach nicht mehr, auch wenn der Haken in den Einstellungen sichtbar
 * stehen bleibt (`desktop/electron/main.ts`). Eine feste Plattform-Abfrage
 * hätte genau den eingangs beschriebenen Fehler wiederholt: ein Rechner, der
 * sich als „bereit" meldet und jede Übernahme ins Leere laufen lässt.
 *
 * Die reine Rechnung sitzt in `darfStandplatzSeinPruefung.ts` (importfrei,
 * für Nodes Testläufer); hier nur das Zusammentragen der beiden Werte.
 */

import { isElectron } from '$lib/platform/runtime';
import { stream } from '$lib/stream/state.svelte';
import { darfStandplatzSeinAus } from './darfStandplatzSeinPruefung';

export function darfStandplatzSein(): boolean {
  if (typeof window === 'undefined') return false;
  return darfStandplatzSeinAus(isElectron(), stream.fernsteuerbar);
}
