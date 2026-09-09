/**
 * Der Name DIESES Rechners — bevor (ohne) eine Eintragung existiert.
 *
 * Der Server kennt Gerätenamen nur an eingetragenen Geräten; wer den Namen
 * aber erst festlegen und später irgendwo eintragen will, braucht einen Ort
 * am RECHNER. Dort liegt er im Geräte-Speicher (`pulse-stream.json` bzw.
 * localStorage-Fallback), nach demselben Muster wie `geraeteAnmeldung` —
 * beim Eintragen geht der Name mit hinaus, danach ist die Server-Zeile die
 * Wahrheit und dieser Wert nur noch ihr Spiegel.
 */

import { loadAll, saveAll } from '$lib/stream/persistence';

const SCHLUESSEL = 'remote.rechner-name';

class RechnerName {
  name = $state('');
  #geladen = false;

  /** Beim Start einmal rufen (`app/+layout`), zusammen mit den anderen. */
  async laden(vorgeladen?: Record<string, unknown>): Promise<void> {
    if (this.#geladen) return;
    this.#geladen = true;
    const alle = vorgeladen ?? (await loadAll());
    const roh = alle[SCHLUESSEL];
    if (typeof roh === 'string') this.name = roh;
  }

  async speichern(name: string): Promise<void> {
    this.name = name;
    await saveAll({ [SCHLUESSEL]: name });
  }
}

export const rechnerName = new RechnerName();
