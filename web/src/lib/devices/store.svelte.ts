/**
 * Standplatz-Geräte — der Zustand im Client.
 *
 * Zwei Quellen, und der Unterschied zwischen ihnen ist der Grund für dieses
 * Modul:
 *
 * * **Die Liste** kommt einmal je Community über REST (`api/devices.ts`). Sie
 *   ändert sich selten — jemand trägt ein Gerät ein, benennt es um, entfernt
 *   es —, und jede dieser Änderungen kommt als `device_changed` nach.
 * * **Der Zustand** (bereit / belegt / offline) kommt als `device_state` und
 *   ändert sich, sooft ein Gerät an- oder abgeschaltet oder übernommen wird.
 *   Er wird deshalb einzeln eingespielt statt die Liste neu zu laden.
 *
 * Beide Wege sind nach dem Standplatz gefiltert, schon im Gateway: wer den
 * Kanal nicht sehen darf, bekommt weder die Zeile noch die Zustandsmeldung.
 * Der Client filtert nicht nach — er hat gar nicht erst die Daten.
 */

import { SvelteMap } from 'svelte/reactivity';
import {
  devicesApi,
  type Device,
  type DeviceMonitor,
  type DeviceState,
} from '$lib/api/devices';

class DeviceStore {
  /** `guildId` → Geräte dieser Community, nach Namen sortiert. */
  readonly byGuild = new SvelteMap<string, Device[]>();
  /** Welche Communitys schon geladen wurden (auch leere — sonst lädt eine
   *  Community ohne Geräte bei jedem Blick neu). */
  readonly #geladen = new Set<string>();
  /** Läuft gerade ein Abruf? Verhindert den Schwarm beim Mount mehrerer
   *  Komponenten, die dieselbe Liste brauchen. */
  readonly #laufend = new Map<string, Promise<void>>();

  /** Geräte einer Community, oder eine leere Liste. */
  forGuild(guildId: string | null | undefined): Device[] {
    if (!guildId) return [];
    return this.byGuild.get(guildId) ?? [];
  }

  byId(guildId: string | null | undefined, deviceId: string): Device | null {
    return this.forGuild(guildId).find((d) => d.id === deviceId) ?? null;
  }

  /** Einmal laden. Fehler werden verschluckt: eine fehlende Geräteliste ist
   *  eine leere Kategorie in der Kanalliste, kein Grund, die Ansicht zu
   *  stören. */
  async ensureLoaded(guildId: string | null | undefined): Promise<void> {
    if (!guildId || this.#geladen.has(guildId)) return;
    const laufend = this.#laufend.get(guildId);
    if (laufend) return laufend;
    const abruf = (async () => {
      try {
        this.byGuild.set(guildId, await devicesApi.list(guildId));
        this.#geladen.add(guildId);
      } catch {
        // Nicht als geladen vermerken — der nächste Versuch darf es erneut
        // probieren (Verbindungsabriss, Serverwechsel mitten im Abruf).
      } finally {
        this.#laufend.delete(guildId);
      }
    })();
    this.#laufend.set(guildId, abruf);
    return abruf;
  }

  // ── Vom WS-Handler ────────────────────────────────────────────────────────

  /** `device_changed` — eingetragen, umbenannt, umgestellt oder entfernt. */
  _changed(guildId: string, device: Device, removed: boolean): void {
    const liste = this.forGuild(guildId).filter((d) => d.id !== device.id);
    if (!removed) liste.push(device);
    liste.sort((a, b) => a.name.localeCompare(b.name));
    this.byGuild.set(guildId, liste);
    // Auch für eine noch nie geladene Community merken: sonst überschriebe ein
    // späteres `ensureLoaded` diesen Stand nicht, sondern liesse ihn stehen und
    // lüde daneben — die Meldung ist hier die frischere Quelle.
    this.#geladen.add(guildId);
  }

  /** `device_state` — bereit / belegt / offline. */
  _state(
    guildId: string,
    deviceId: string,
    state: DeviceState,
    busyWith: string | null,
    monitors?: DeviceMonitor[],
  ): void {
    const liste = this.forGuild(guildId);
    const i = liste.findIndex((d) => d.id === deviceId);
    // Unbekanntes Gerät: still verwerfen. Das ist der Normalfall, solange die
    // Liste dieser Community noch nicht geladen ist — sie bringt den Zustand
    // dann ohnehin mit.
    if (i < 0) return;
    const neu = [...liste];
    neu[i] = { ...neu[i], state, busy_with: busyWith, ...(monitors ? { monitors } : {}) };
    this.byGuild.set(guildId, neu);
  }

  /** Beim Abmelden alles fallen lassen (Kontowechsel ohne Neuladen). */
  reset(): void {
    this.byGuild.clear();
    this.#geladen.clear();
    this.#laufend.clear();
  }
}

export const deviceStore = new DeviceStore();
