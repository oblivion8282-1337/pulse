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

import type { DeviceMonitor } from '$lib/api/devices';
import { loadAll, saveAll } from '$lib/stream/persistence';
import { verwaisteDurchCommunity, verwaisteDurchServer } from '$lib/devices/eintragungAbgleich';
import { refreshMonitors } from '$lib/stream/captureSource';
import { streamSettings } from '$lib/stream/settingsState.svelte';
import { platzMeldungen } from '$lib/devices/platzMeldung.svelte';

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
    // `DeviceMonitor` statt eines eigenen Inline-Typs — s. Kommentar dort
    // (`$lib/api/devices.ts`): dieselbe Form geht raus wie später über
    // `device_state`/REST zurückkommt, ein eigener Sende-Typ wäre eine
    // weitere Stelle, die bei der nächsten Erweiterung mitgezogen werden
    // müsste.
    senden: (deviceId: string, monitore: DeviceMonitor[]) => void,
    eintrag: Eintragung,
  ): Promise<void> {
    let monitore: DeviceMonitor[] = [];
    try {
      await refreshMonitors();
      monitore = streamSettings.available_monitors.map((mon) => ({
        index: mon.index,
        name: mon.name,
        primary: mon.primary,
        // Lage/Grösse reisen mit, wenn der Sidecar sie kennt — `GsrMonitor.x`/
        // `.y` sind optional (Linux/ältere Sidecars melden sie nicht), und ein
        // `undefined`-Feld verschwindet beim Senden einfach aus dem JSON,
        // statt eine geratene Zahl zu tragen.
        x: mon.x,
        y: mon.y,
        width: mon.width,
        height: mon.height,
      }));
    } catch {
      // Ohne Liste anmelden — s. oben.
    }
    senden(eintrag.deviceId, monitore);
    // **Und die Plätze neu melden lassen.** Eine Anmeldung geht nach jedem
    // Verbindungsaufbau hinaus; der Server hat die Platzmenge dieses Geräts
    // beim Abriss vergessen (`device_withdraw`), unser Merker aber nicht. Ohne
    // dieses Entwerten sendete das Gerät weiter, galt serverseitig als
    // plattlos, und sein Bildschirm wurde einem Steuernden erneut als frei
    // angeboten — dessen Weckruf das Gerät dann mit „überträgt bereits"
    // verwarf. Die Entwertung sitzt genau hier, damit sie mit der Anmeldung
    // nicht auseinanderlaufen kann.
    platzMeldungen.vergessen(eintrag.serverId);
  }

  /** Nach dem Entfernen vergessen. */
  vergessen(deviceId: string): Promise<void> {
    return this.#vergessenViele([deviceId]);
  }

  /**
   * Eintragungen räumen, deren Community es auf diesem Server nicht (mehr)
   * gibt — gerufen aus `ws/handlers/ready.ts` mit der Communityliste des
   * Rahmens, der dort die alleinige Wahrheit ist.
   *
   * **Vor dem Anmelden**, nicht danach: sonst meldete sich der Rechner in
   * derselben Runde noch einmal als ein Gerät an, das es nicht gibt.
   */
  abgleichenMitCommunitys(serverId: string, guildIds: readonly string[]): Promise<void> {
    return this.#vergessenViele(verwaisteDurchCommunity(this.eintragungen, serverId, guildIds));
  }

  /** Eintragungen räumen, deren Server aus der Serverliste verschwunden ist. */
  abgleichenMitServern(serverIds: readonly string[]): Promise<void> {
    return this.#vergessenViele(verwaisteDurchServer(this.eintragungen, serverIds));
  }

  /**
   * Mehrere auf einmal — EIN Schreibvorgang. Unter Electron ist jeder ein
   * IPC-Umlauf über die ganze Datei (dieselbe Begründung wie beim Laden in
   * `app/+layout.svelte`).
   *
   * **Bewusst nicht `async`.** Der Aufrufer im `ready`-Handler räumt und fragt
   * unmittelbar danach `fuerServer()` — er darf die geräumte Eintragung dort
   * nicht mehr sehen. Als `async` deklariert liefe der Rumpf zwar heute
   * genauso synchron an, das hinge aber an einer Feinheit der Sprache statt an
   * einer Zusage dieser Datei. So steht sie in der Signatur: der Stand im
   * Speicher ist mit der Rückkehr fertig, das Versprechen betrifft nur das
   * Schreiben.
   */
  #vergessenViele(deviceIds: readonly string[]): Promise<void> {
    if (deviceIds.length === 0) return Promise.resolve();
    const raus = new Set(deviceIds);
    this.eintragungen = this.eintragungen.filter((e) => !raus.has(e.deviceId));
    return this.#sichern();
  }

  /**
   * Community oder Name einer bestehenden Eintragung nachziehen.
   *
   * Nötig seit dem Community-Wechsel aus der Ferne: die Eintragung trägt sonst
   * weiter die alte Community, der Rechner lädt die Geräteliste der falschen
   * und sein eigener Reiter zeigt ins Leere. Legt bewusst NICHTS an — eine
   * Meldung über ein fremdes Gerät darf diesen Rechner nicht zu einem machen.
   */
  async nachziehen(deviceId: string, guildId: string, name: string): Promise<void> {
    const vorhanden = this.eintragungen.find((e) => e.deviceId === deviceId);
    if (!vorhanden) return;
    this.eintragungen = this.eintragungen.map((e) =>
      e.deviceId === deviceId ? { ...e, guildId, name } : e,
    );
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
