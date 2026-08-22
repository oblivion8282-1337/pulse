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
import { geraeteAnmeldung } from '$lib/devices/anmeldung.svelte';
import { gatewayForServer } from '$lib/ws/connection';

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

  /**
   * Ein Gerät entfernen — und, wenn es DIESER Rechner ist, auch die lokale
   * Eintragung.
   *
   * **Die lokale Aufräumung gehört hierher und nicht nur in den WS-Handler**
   * (Bughunt 2026-08-21). Bis dahin räumte allein die `device_changed`-Meldung
   * mit `removed` (`nachzugAktion.ts`), und die kommt nur an, solange dieser
   * Rechner die Community und den Standplatz noch sehen darf. Wer aus der
   * Community geflogen ist, entfernte sein Gerät also ohne jede Wirkung auf
   * den eigenen Speicher — die Eintragung blieb, und der Standplatz-Reiter
   * blieb für immer im Zustand „schon eingetragen".
   *
   * Erst abmelden, dann löschen: nach dem Löschen findet der Server die Zeile
   * nicht mehr und könnte den Eintrag aus den Listen der anderen nicht mehr
   * benennen.
   */
  async entfernen(guildId: string, deviceId: string): Promise<void> {
    const eigen = this.#abmelden(deviceId);
    await this.#ruf(() => devicesApi.remove(guildId, deviceId));
    // `#ruf` wertet 404 bereits als Erfolg („schon weg") und lässt `fehler`
    // dann leer. Ein leeres `fehler` heisst hier also: die Zeile ist fort, egal
    // ob durch diesen Ruf oder vorher — und nur dann darf die lokale
    // Eintragung mit. Die 404-Regel steht bewusst nur an der einen Stelle.
    if (eigen && this.fehler === null) await geraeteAnmeldung.vergessen(deviceId);
  }

  /**
   * Die lokale Eintragung fallen lassen, ohne den Server zu fragen.
   *
   * Der Notausgang für eine verwaiste Eintragung (`eintragungLage.ts`): steht
   * die Community nicht mehr zur Verfügung, antwortet jede Geräte-Route mit
   * 403 (`require_member`) — es gibt dann keinen Ruf, der die Sackgasse
   * öffnen könnte. Bewusst getrennt vom Entfernen und in der Oberfläche auch
   * so benannt: hier verschwindet nur die Behauptung dieses Rechners, er sei
   * jenes Gerät. Eine etwaig noch vorhandene Zeile auf dem Server bleibt
   * unberührt, und das darf die Oberfläche nicht verschweigen.
   */
  async nurLokalVergessen(deviceId: string): Promise<void> {
    this.#abmelden(deviceId);
    await geraeteAnmeldung.vergessen(deviceId);
  }

  /**
   * Ist das die Eintragung DIESES Rechners? Dann vorab beim Server abmelden.
   *
   * Gibt die Eintragung zurück, damit der Aufrufer weiss, ob es überhaupt um
   * den eigenen Rechner geht — für ein fremdes Gerät darf weder abgemeldet noch
   * lokal geräumt werden.
   */
  #abmelden(deviceId: string): { serverId: string } | undefined {
    const eigen = geraeteAnmeldung.eintragungen.find((e) => e.deviceId === deviceId);
    if (eigen) gatewayForServer(eigen.serverId)?.sendDeviceWithdraw(deviceId);
    return eigen;
  }
}

export const geraeteVerwaltung = new GeraeteVerwaltung();
