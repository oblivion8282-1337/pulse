/**
 * Der Zustand hinter dem Browser-Warnhinweis ueber den Direktnachrichten:
 * laedt die beiden Auskuenfte (haltbares Geraet? Sicherung aktiv?) einmal je
 * Sitzung und merkt sich ein Wegklicken bis zum naechsten Seitenaufruf.
 *
 * „Haltbares Geraet" kommt aus der EIGENEN Geraeteliste (`GET /keys/geraete`,
 * nichts verbrauchend — anders als `POST /keys/claim`, das Einmalschluessel
 * kostet): dauerhaft (App) oder gekoppelt, und nicht verfallen.
 *
 * „Sicherung aktiv" ist dieselbe Formel wie der Frischgeraet-Hinweis in
 * `app/@me/[[dmChannelId]]/+page.svelte`: Ziele besetzt UND der DEK liegt
 * im Zwischenlager — ein verbundenes Ziel ohne Schluessel koennte nichts
 * wiederherstellen und waere keine echte Kopie.
 *
 * Die Rechnung selbst steht importfrei in `dmBrowserWarnung.ts` (s. CLAUDE.md
 * „Die Falle"); hier ist nur Laden, Zwischenspeichern und das Wegklicken.
 * Ein Fehlschlag beim Laden laesst die Auskunft auf `undefined` stehen —
 * kein Hinweis, naechster Seitenaufruf versucht erneut.
 */
import { keysApi } from '../api/keys';
import { serversStore } from '../api/servers.svelte';
import { zieleLesen, zieleBesetzt } from '../sicherung/ziele';
import { dekAusZwischenlager } from '../sicherung/geraete';
import { browserWarnungNoetig } from './dmBrowserWarnung';
import { isElectron, isCapacitorAndroid } from '../platform/runtime';

// DMs sind cloud-only — s. `api/keys.ts` Modulkopf.
function cloudRoute(): { serverId?: string } {
  return { serverId: serversStore.cloudId() };
}

let haltbaresGeraet = $state<boolean | undefined>(undefined);
let laufwerkVerbunden = $state<boolean | undefined>(undefined);
let weggeklickt = $state(false);
let geladen = false;

async function laden(): Promise<void> {
  try {
    const geraete = await keysApi.geraete(cloudRoute());
    haltbaresGeraet = geraete.some(
      (g) => !g.verfallen && (g.dauerhaft || g.gekoppelt_am !== null)
    );
  } catch {
    // Ohne Auskunft kein Hinweis — ein falscher Hinweis ist schlimmer als
    // ein spaeterer richtiger.
    return;
  }
  try {
    laufwerkVerbunden =
      zieleBesetzt(await zieleLesen()) && (await dekAusZwischenlager()) !== null;
  } catch {
    laufwerkVerbunden = undefined;
  }
  geladen = true;
}

export const dmBrowserWarnung = {
  /** `true`, solange der Hinweis zu zeigen ist. Stoesst das (einmalige)
   *  Laden an; die Antwort trifft reaktiv ein, der Aufrufer sieht den
   *  Hinweis erst, wenn beide Auskuenfte da sind. */
  zeigt(): boolean {
    if (!geladen) void laden();
    if (weggeklickt) return false;
    return browserWarnungNoetig(
      isElectron() || isCapacitorAndroid(),
      haltbaresGeraet,
      laufwerkVerbunden
    );
  },
  wegklicken(): void {
    weggeklickt = true;
  }
};
