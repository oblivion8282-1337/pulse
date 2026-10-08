/**
 * Schnellwahl am App-Symbol (iOS-Punkt 44) — die Brücke.
 *
 * Langes Drücken auf das Pulse-Symbol zeigt die letzten Gespräche, ein Tipp
 * springt hinein. Welche Gespräche das sind, entscheidet geprüft
 * `schnellwahlAuswahl.ts`; das Native liegt in `SchnellwahlPlugin.swift`.
 *
 * **Der Rückweg wird geprüft, obwohl der Pfad von uns stammt.** Er lag als
 * `userInfo` in einem `UIApplicationShortcutItem` — in einem Bereich, den das
 * System verwaltet und der einen Neustart überdauert. Was zurückkommt, ist
 * damit eine Eingabe (`zielPfadIntern`), dieselbe Haltung wie bei den
 * Universal Links gegenüber Apples Vorauswahl.
 *
 * Nur die iOS-Hülle. Android kennt App-Shortcuts auch, aber über einen
 * anderen Mechanismus (`ShortcutManager`) und mit einem eigenen Plugin — das
 * wäre ein eigener Punkt, nicht ein Nebenprodukt.
 */
import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { goto } from '$app/navigation';
import { isCapacitorIOS } from './runtime';
import { zielPfadIntern } from './tiefenlink';
import type { Eintrag } from './schnellwahlAuswahl';

interface SchnellwahlPlugin {
  setzen(opts: { eintraege: Eintrag[] }): Promise<void>;
  addListener(
    event: 'gewaehlt',
    cb: (data: { pfad: string }) => void
  ): Promise<PluginListenerHandle>;
}

const plugin = registerPlugin<SchnellwahlPlugin>('Schnellwahl');

/** Letzter gesetzter Stand — gegen überflüssige Brücken-Aufrufe, wenn ein
 *  Effekt mehrfach läuft, ohne dass sich die Liste geändert hat. */
let zuletzt = '';

/** Einträge setzen. Eine leere Liste räumt die Schnellwahl ab. */
export async function schnellwahlSetzen(eintraege: Eintrag[]): Promise<void> {
  if (!isCapacitorIOS()) return;
  const stand = JSON.stringify(eintraege);
  if (stand === zuletzt) return;
  zuletzt = stand;
  try {
    await plugin.setzen({ eintraege });
  } catch (e) {
    zuletzt = '';
    console.warn('[schnellwahl] setzen fehlgeschlagen', e);
  }
}

/**
 * Beim Abmelden abräumen.
 *
 * **Nicht bloss Hygiene:** die Namen der letzten Gespräche stehen am
 * Symbol, und das Symbol gehört dem GERÄT, nicht dem Konto. Nach einem
 * Abmelden sähe der Nächste, mit wem der Vorige geschrieben hat — und ein
 * Tipp führte in einen Chat, den er nicht öffnen darf.
 */
export async function schnellwahlLeeren(): Promise<void> {
  zuletzt = '';
  await schnellwahlSetzen([]);
}

/** Einmal pro Fenster aufrufen (`app/+layout.svelte`). */
export function schnellwahlVerfolgen(): void {
  if (!isCapacitorIOS()) return;
  void plugin.addListener('gewaehlt', ({ pfad }) => {
    const ziel = zielPfadIntern(pfad);
    // Kein erkanntes Ziel: NICHTS tun — die App ist durch den Tipp ohnehin
    // schon offen, irgendwohin zu springen wäre schlechter als zu bleiben.
    if (!ziel) return;
    void goto(ziel);
  });
}
