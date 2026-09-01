/**
 * Freigabelisten der eigenen Geräte — geladen, nicht geraten.
 *
 * Je Gerät eine Liste, nachgeladen beim Öffnen der Geräteansicht. Kein
 * Vorladen aller Geräte: die Liste interessiert nur den Besitzer und nur, wenn
 * er gerade hinsieht.
 */
import { grantsApi, type Grant, type GrantEingabe } from '$lib/api/devices';
import { dedupliziertLaden } from './ladeWaechter';

class Freigaben {
  #proGeraet = $state<Record<string, Grant[]>>({});
  /** Laufende Abrufe je Gerät — ein überlappender zweiter Aufruf (z. B. ein
   *  WS-Reconnect während eine HTTP-Anfrage noch offen ist) wartet auf
   *  DIESES Versprechen, statt eine noch leere Liste als „geladen"
   *  anzusehen (Bughunt 2026-08-20, Begründung in `ladeWaechter.ts`). */
  #laufend = new Map<string, Promise<void>>();

  fuer(deviceId: string): Grant[] {
    return this.#proGeraet[deviceId] ?? [];
  }

  async laden(guildId: string, deviceId: string): Promise<void> {
    return dedupliziertLaden(this.#laufend, deviceId, async () => {
      this.#proGeraet[deviceId] = await grantsApi.list(guildId, deviceId);
    });
  }

  /** Ersetzen. Der Server ist die Wahrheit — wir übernehmen seine Antwort,
   *  nicht die gesendete Liste (er vergibt Kennungen und Zeitstempel). */
  async setzen(guildId: string, deviceId: string, grants: GrantEingabe[]): Promise<void> {
    this.#proGeraet[deviceId] = await grantsApi.set(guildId, deviceId, grants);
  }
}

export const freigaben = new Freigaben();
