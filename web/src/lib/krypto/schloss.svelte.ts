/**
 * Der Speicher hinter dem Schloss-Kennzeichen: haelt je Gespraech (genauer:
 * je Gegenstelle) die Auskunft, ob es verschluesselt laufen kann.
 *
 * Geholt wird ueber `GET /keys/verschluesselbar/{ziel_id}` — eine Route, die
 * ausschliesslich liest. Der naheliegende Weg, `POST /keys/claim`, VERBRAUCHT
 * je Geraet des Ziels einen Einmalschluessel; beim Betreten jedes Gespraechs
 * gerufen wuerde er den Vorrat der Gegenseite durch blosses Herumklicken
 * leerziehen. Genau deshalb gab es bis heute kein Kennzeichen.
 *
 * **Der Sendezeitpunkt bleibt die Autoritaet.** Was hier steht, ist eine
 * Momentaufnahme vom Betreten des Gespraechs und kann veralten (die
 * Gegenseite meldet ihr letztes dauerhaftes Geraet ab, waehrend das Gespraech
 * offen ist). Ob eine Nachricht verschluesselt geht, entscheidet allein
 * `krypto/senden.ts` mit frisch geholten Buendeln — dieser Speicher wird dort
 * nicht gelesen und der Sendeweg aendert sich durch ihn nicht.
 *
 * Die Sperre gegen Mehrfachabrufe steht importfrei in `schlossAbfrage.ts`
 * (s. CLAUDE.md „Die Falle") und wird dort geprueft.
 */

import { keysApi } from '../api/keys';
import { serversStore } from '../api/servers.svelte';
import { schlossAbfrageErzeugen } from './schlossAbfrage';
import { E2E_DMS_ENABLED } from './schalter';

// Wie in `veroeffentlichen.ts`/`senden.ts`: DMs sind cloud-only, und als
// FUNKTION statt Konstante, weil `serversStore.init()` beim Import noch nicht
// gelaufen sein muss.
function cloudRoute(): { serverId?: string } {
  return { serverId: serversStore.cloudId() };
}

const stand = $state<Record<string, boolean>>({});

const sicherstellen = schlossAbfrageErzeugen(
  async (userId) => (await keysApi.verschluesselbar(userId, cloudRoute())).verschluesselbar,
  (userId, verschluesselbar) => {
    stand[userId] = verschluesselbar;
  }
);

export const schloss = {
  /** `true`/`false`, sobald die Auskunft da ist — `undefined`, solange nicht
   *  gefragt wurde oder der Abruf noch laeuft. Der Aufrufer zeigt in diesem
   *  Zustand nichts an: ein kurz aufblitzendes falsches Schloss waere
   *  schlimmer als ein spaeter erscheinendes richtiges. */
  stand(userId: string): boolean | undefined {
    return stand[userId];
  },

  /**
   * Holt die Auskunft fuer diese Gegenstelle, falls noch nicht geschehen.
   *
   * Bei ausgeschaltetem `E2E_DMS_ENABLED` passiert gar nichts — kein
   * Serveraufruf, kein Eintrag, und damit auch nie ein Schloss: solange der
   * Schalter aus ist, laeuft JEDE Direktnachricht den Klartext-Weg, und ein
   * Kennzeichen waere schlicht gelogen.
   */
  sicherstellen(userId: string): void {
    if (!E2E_DMS_ENABLED) return;
    void sicherstellen(userId);
  }
};
