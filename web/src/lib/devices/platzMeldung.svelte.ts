/**
 * Der lebende Merker zu [`platzMeldungBuch`] — dieselbe Rechnung, nur
 * beobachtbar, damit der Effekt in `DeviceKiosk.svelte` erneut anläuft, wenn
 * ein Wiederverbinden den Stand für einen Server entwertet.
 *
 * Die Rechnung selbst steht bewusst importfrei nebenan, damit sie in Nodes
 * Testläufer geprüft werden kann (`web/test/platz-meldung.test.ts`).
 */

import { meldungenAusfuehren, nachAbriss, type MeldeStand } from './platzMeldungBuch';

class PlatzMeldungen {
  #stand = $state<MeldeStand>({});

  /** Einen Durchgang fahren. `senden` gibt zurück, ob die Nachricht wirklich
   *  hinausging. */
  ausfuehren(
    serverIds: readonly string[],
    schluessel: string,
    senden: (serverId: string) => boolean,
  ): void {
    this.#stand = meldungenAusfuehren(this.#stand, serverIds, schluessel, senden);
  }

  /** Ruft die Anmeldung — s. Kopf von `platzMeldungBuch.ts`. */
  vergessen(serverId: string): void {
    this.#stand = nachAbriss(this.#stand, serverId);
  }
}

export const platzMeldungen = new PlatzMeldungen();
