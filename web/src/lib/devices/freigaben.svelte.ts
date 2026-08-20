/**
 * Freigabelisten der eigenen Geräte — geladen, nicht geraten.
 *
 * Je Gerät eine Liste, nachgeladen beim Öffnen der Geräteansicht. Kein
 * Vorladen aller Geräte: die Liste interessiert nur den Besitzer und nur, wenn
 * er gerade hinsieht.
 */
import { grantsApi, type Grant, type GrantEingabe } from '$lib/api/devices';

class Freigaben {
  #proGeraet = $state<Record<string, Grant[]>>({});
  laden_ = $state<Record<string, boolean>>({});

  fuer(deviceId: string): Grant[] {
    return this.#proGeraet[deviceId] ?? [];
  }

  async laden(guildId: string, deviceId: string): Promise<void> {
    if (this.laden_[deviceId]) return;
    this.laden_[deviceId] = true;
    try {
      this.#proGeraet[deviceId] = await grantsApi.list(guildId, deviceId);
    } finally {
      this.laden_[deviceId] = false;
    }
  }

  /** Ersetzen. Der Server ist die Wahrheit — wir übernehmen seine Antwort,
   *  nicht die gesendete Liste (er vergibt Kennungen und Zeitstempel). */
  async setzen(guildId: string, deviceId: string, grants: GrantEingabe[]): Promise<void> {
    this.#proGeraet[deviceId] = await grantsApi.set(guildId, deviceId, grants);
  }
}

export const freigaben = new Freigaben();
