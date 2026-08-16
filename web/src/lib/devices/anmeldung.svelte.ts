/**
 * Standplatz-Geräte — **die Seite des Geräts selbst**.
 *
 * Der Server sieht Verbindungen von Nutzern. Welcher RECHNER dahintersteht,
 * weiss nur der Rechner: er hat sich beim Eintragen die Kennung gemerkt, und
 * nach jedem Verbindungsaufbau meldet er sich damit an (`device_announce`).
 * Erst dadurch steht er als „bereit" in der Kanalliste der anderen.
 *
 * **Warum die Kennung lokal liegt.** Sie ist die Antwort auf „welches der
 * eingetragenen Geräte bin ich" — und die kann nur der Rechner beantworten.
 * Läge sie am Konto, wäre der Laptop des Besitzers plötzlich auch der
 * Werkstatt-PC; ein Erraten („der erste Socket dieses Nutzers") wäre in dem
 * Moment falsch, in dem der Besitzer nebenher am Laptop sitzt, und falsch auf
 * die gefährliche Art: der Laptop stünde als übernehmbarer Rechner im Kanal.
 *
 * Gespeichert wird dort, wo auch die Dauerfreigabe liegt: im Geräte-Speicher
 * der Desktop-App (`pulse-stream.json`, Linux chmod 600), über den vorhandenen
 * Zwei-Wege-Wrapper. Ein Eintrag je Server, denn dieselbe Maschine kann in der
 * Cloud und auf einem Self-Host je eine eigene Eintragung haben.
 */

import { loadAll, saveAll } from '$lib/stream/persistence';
import { refreshMonitors } from '$lib/stream/captureSource';
import { streamSettings } from '$lib/stream/settingsState.svelte';

const SPEICHER_SCHLUESSEL = 'remote.geraete';

/** Was dieser Rechner über eine seiner Eintragungen weiss. */
export interface Eintragung {
  /** Server (Pulse-Instanz), auf dem die Eintragung liegt. */
  serverId: string;
  /** Community, in der das Gerät steht. */
  guildId: string;
  /** Die Gerätekennung — die Zahl, die bei `device_announce` hinausgeht. */
  deviceId: string;
  /** Name zum Zeitpunkt der Eintragung, nur für die Anzeige in den
   *  Einstellungen. Die Wahrheit über den Namen steht auf dem Server. */
  name: string;
}

function istEintragung(roh: unknown): roh is Eintragung {
  if (!roh || typeof roh !== 'object') return false;
  const o = roh as Record<string, unknown>;
  return (
    typeof o.serverId === 'string' &&
    typeof o.guildId === 'string' &&
    typeof o.deviceId === 'string' &&
    typeof o.name === 'string'
  );
}

class GeraeteAnmeldung {
  eintragungen = $state<Eintragung[]>([]);
  #geladen = false;

  /** Beim Start einmal rufen (`app/+layout`), zusammen mit der Dauerfreigabe. */
  async laden(vorgeladen?: Record<string, unknown>): Promise<void> {
    if (this.#geladen) return;
    this.#geladen = true;
    try {
      const alle = vorgeladen ?? (await loadAll());
      const roh = alle[SPEICHER_SCHLUESSEL];
      this.eintragungen = Array.isArray(roh) ? roh.filter(istEintragung) : [];
    } catch {
      this.eintragungen = [];
    }
  }

  /** Die Eintragung dieses Rechners auf einem bestimmten Server. */
  fuerServer(serverId: string | null | undefined): Eintragung | null {
    if (!serverId) return null;
    return this.eintragungen.find((e) => e.serverId === serverId) ?? null;
  }

  /** Nach dem Eintragen merken. Ersetzt eine bestehende Eintragung desselben
   *  Servers — ein Rechner steht je Server an genau einem Standplatz, und der
   *  Server hält das mit derselben Regel fest. */
  async merken(eintrag: Eintragung): Promise<void> {
    this.eintragungen = [
      ...this.eintragungen.filter((e) => e.serverId !== eintrag.serverId),
      eintrag,
    ];
    await this.#sichern();
  }

  /**
   * Sich auf einer Verbindung als Gerät melden — **samt Bildschirmliste**.
   *
   * Die Liste holt sich der Rechner frisch beim Sidecar, statt eine gemerkte
   * zu schicken: Bildschirme werden umgesteckt und abgeschaltet, und der
   * Steuernde soll nicht „Monitor 3 dazuschalten" angeboten bekommen, den es
   * seit dem letzten Start nicht mehr gibt. Scheitert die Abfrage, geht die
   * Anmeldung trotzdem hinaus — ohne Liste ist das Gerät nutzbar, nur eben auf
   * seinen Hauptbildschirm beschränkt.
   */
  async anmelden(
    senden: (
      deviceId: string,
      monitore: { index: number; name: string; primary: boolean }[],
    ) => void,
    eintrag: Eintragung,
  ): Promise<void> {
    let monitore: { index: number; name: string; primary: boolean }[] = [];
    try {
      await refreshMonitors();
      monitore = streamSettings.available_monitors.map((mon) => ({
        index: mon.index,
        name: mon.name,
        primary: mon.primary,
      }));
    } catch {
      // Ohne Liste anmelden — s. oben.
    }
    senden(eintrag.deviceId, monitore);
  }

  /** Nach dem Entfernen vergessen. */
  async vergessen(deviceId: string): Promise<void> {
    this.eintragungen = this.eintragungen.filter((e) => e.deviceId !== deviceId);
    await this.#sichern();
  }

  async #sichern(): Promise<void> {
    try {
      await saveAll({ [SPEICHER_SCHLUESSEL]: this.eintragungen });
    } catch {
      // Wie überall in der Persistenz: der Stand im Speicher gilt weiter. Eine
      // nicht geschriebene Eintragung heisst, dass sich der Rechner nach einem
      // Neustart nicht mehr als dieses Gerät meldet — sichtbar als „offline",
      // und in den Einstellungen wieder eintragbar.
    }
  }
}

export const geraeteAnmeldung = new GeraeteAnmeldung();
