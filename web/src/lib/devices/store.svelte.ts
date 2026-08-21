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

import { SvelteMap, SvelteSet } from 'svelte/reactivity';
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
  readonly #geladen = new SvelteSet<string>();
  /** Läuft gerade ein Abruf? Verhindert den Schwarm beim Mount mehrerer
   *  Komponenten, die dieselbe Liste brauchen. */
  readonly #laufend = new Map<string, Promise<void>>();

  /** Geräte einer Community, oder eine leere Liste. */
  forGuild(guildId: string | null | undefined): Device[] {
    if (!guildId) return [];
    return this.byGuild.get(guildId) ?? [];
  }

  /**
   * Das Gerät, das in diesem Kanal steht und diesem Nutzer gehört.
   *
   * Der Weg von einer laufenden Fernsteuerung zurück zum Gerät: dort sind nur
   * Kanal und Host-Nutzer bekannt (`RemoteControllerInput`), und erst hier wird
   * daraus die Gerätezeile mit ihrer Bildschirmliste. Ohne Community-Kennung,
   * weil die Sitzung sie nicht führt — die Suche läuft deshalb über alle
   * geladenen Communitys, und das sind wenige.
   */
  byChannelOwner(channelId: string, ownerId: string): Device | null {
    for (const liste of this.byGuild.values()) {
      const treffer = liste.find(
        (d) => d.channel_id === channelId && d.owner_user_id === ownerId,
      );
      if (treffer) return treffer;
    }
    return null;
  }

  /**
   * ALLE Geräte eines Besitzers in einem Kanal.
   *
   * [`byChannelOwner`] liefert das erste — das genügt für „gehört hier ein
   * Gerät hin", nicht aber für die Frage, welcher Strom von welchem Rechner
   * kommt: ein Besitzer kann mehrere Standplätze im selben Kanal haben, und
   * dann müssen die Plätze aller zusammengelegt werden.
   */
  alleImKanal(channelId: string, ownerId: string): Device[] {
    const treffer: Device[] = [];
    for (const liste of this.byGuild.values()) {
      for (const d of liste) {
        if (d.channel_id === channelId && d.owner_user_id === ownerId) treffer.push(d);
      }
    }
    return treffer;
  }

  byId(guildId: string | null | undefined, deviceId: string): Device | null {
    return this.forGuild(guildId).find((d) => d.id === deviceId) ?? null;
  }

  /**
   * Alle eigenen Geräte über alle geladenen Communitys — für „Meine Geräte
   * auf diesem Server" im Standplatz-Reiter. Wie bei `byChannelOwner` reicht
   * die Suche nur über das, was schon geladen ist: der Reiter lädt vorher
   * selbst jede Community nach, die der Nutzer sieht.
   */
  eigene(ownerId: string | null | undefined): Device[] {
    if (!ownerId) return [];
    const treffer: Device[] = [];
    for (const liste of this.byGuild.values()) {
      for (const d of liste) {
        if (d.owner_user_id === ownerId) treffer.push(d);
      }
    }
    return treffer;
  }

  /**
   * Wurde die Liste dieser Community schon vollständig abgerufen?
   *
   * Der Unterschied zu „`forGuild` ist leer" ist der ganze Zweck: leer heisst
   * entweder „keine Geräte" oder „noch nicht gefragt", und nur im ersten Fall
   * darf die Oberfläche daraus schliessen, dass es eine gesuchte Gerätezeile
   * nicht gibt (`eintragungLage.ts`).
   */
  istGeladen(guildId: string | null | undefined): boolean {
    return !!guildId && this.#geladen.has(guildId);
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
    // **Nicht als geladen vermerken** (Bughunt 2026-08-16). Eine Meldung trägt
    // EIN Gerät, keine Liste. Wer die Community noch nie abgerufen hat, hätte
    // sie danach für vollständig gehalten und nie nachgeladen — in der
    // Kanalliste stünde genau das eine Gerät, das sich zufällig gerade
    // geändert hat. Ein späteres `ensureLoaded` ersetzt die Liste ohnehin
    // durch die des Servers, und die ist die vollständigere.
  }

  /** `device_state` — bereit / belegt / offline. */
  _state(
    guildId: string,
    deviceId: string,
    state: DeviceState,
    busyWith: string | null,
    monitors?: DeviceMonitor[],
    streamSlots?: number[],
  ): void {
    const liste = this.forGuild(guildId);
    const i = liste.findIndex((d) => d.id === deviceId);
    // Unbekanntes Gerät: still verwerfen. Das ist der Normalfall, solange die
    // Liste dieser Community noch nicht geladen ist — sie bringt den Zustand
    // dann ohnehin mit.
    if (i < 0) return;
    const neu = [...liste];
    neu[i] = {
      ...neu[i],
      state,
      busy_with: busyWith,
      ...(monitors ? { monitors } : {}),
      // **`undefined` und leere Liste bedeuten Verschiedenes.** Fehlt das Feld,
      // bleibt der letzte Stand (ältere Gegenstelle); eine leere Liste ist die
      // Aussage „sendet nicht mehr" und muss ankommen, sonst klebt das
      // LIVE-Abzeichen an einem eingeschlafenen Gerät.
      ...(streamSlots ? { stream_slots: streamSlots } : {}),
    };
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
