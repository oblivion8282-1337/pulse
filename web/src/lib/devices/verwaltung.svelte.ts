/**
 * Ein Gerät verwalten — von jedem Rechner aus, nicht nur von ihm selbst.
 *
 * Die Oberfläche ruft nur; die Liste zieht sich NICHT selbst nach. Der Server
 * meldet jede Änderung ohnehin an alle, die den Standplatz sehen dürfen
 * (`device_changed`), und ein vorweggenommener Stand wäre eine zweite Wahrheit,
 * die bei jedem Fehlschlag zurückgenommen werden müsste.
 */
import { devicesApi } from '$lib/api/devices';
import { ApiError } from '$lib/api/client';

class GeraeteVerwaltung {
  fehler = $state<string | null>(null);
  laeuft = $state(false);
  /** Wie viele Rollen-Freigaben der letzte Community-Wechsel geräumt hat. */
  geraeumteRollen = $state(0);

  async #ruf(fn: () => Promise<void>): Promise<void> {
    this.laeuft = true;
    this.fehler = null;
    try {
      await fn();
    } catch (e) {
      // 404 heisst hier „schon weg" und ist kein Fehler des Nutzers — ein
      // anderer Rechner desselben Kontos oder ein Verwalter war schneller.
      if (e instanceof ApiError && e.status === 404) return;
      this.fehler = e instanceof Error ? e.message : String(e);
    } finally {
      this.laeuft = false;
    }
  }

  async umbenennen(guildId: string, deviceId: string, name: string): Promise<void> {
    await this.#ruf(async () => {
      await devicesApi.patch(guildId, deviceId, { name });
    });
  }

  async umstellen(
    guildId: string,
    deviceId: string,
    zielGuild: string,
    zielKanal: string,
  ): Promise<void> {
    await this.#ruf(async () => {
      const antwort = await devicesApi.patch(guildId, deviceId, {
        guild_id: zielGuild,
        channel_id: zielKanal,
      });
      this.geraeumteRollen = antwort.role_grants_cleared ?? 0;
    });
  }

  async entfernen(guildId: string, deviceId: string): Promise<void> {
    await this.#ruf(() => devicesApi.remove(guildId, deviceId));
  }
}

export const geraeteVerwaltung = new GeraeteVerwaltung();
