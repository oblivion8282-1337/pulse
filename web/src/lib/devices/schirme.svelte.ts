/**
 * Standplatz-Geräte — **welche Bildschirme es gibt und wie man einen holt**.
 *
 * Herausgelöst, weil es seit dem Menü im Player-Fenster **zwei** Stellen gibt,
 * an denen jemand einen Bildschirm anfordert:
 *
 * * die Geräteansicht in der App (`DeviceView.svelte`) — vor dem Übernehmen,
 * * das Menü am Griff im Player-Fenster (`overlay/fernbedienung.rs`) — während
 *   man steuert, denn dort schaut der Steuernde gerade hin.
 *
 * Beide brauchen dieselbe Entscheidung: läuft dieser Schirm schon, hol sein
 * Fenster nach vorne; läuft er nicht, wecke ihn und öffne das Fenster, sobald
 * das Bild da ist. Ein zweiter Nachbau davon liefe unweigerlich auseinander —
 * und zwar an der unauffälligsten Stelle, dem Erkennen, ob ein Schirm schon
 * läuft.
 *
 * **Das Player-Fenster entscheidet nichts selbst.** Es kennt weder das Gerät
 * noch die Sitzung beim Server; es meldet nur „der Nutzer hat Bildschirm 2
 * gewählt". Dasselbe Muster wie beim Chat-Knopf und bei „Fernsteuerung
 * beenden".
 */

import type { Device, DeviceMonitor } from '$lib/api/devices';
import { geraetWecken } from './wecken';
import { streamPresence } from '$lib/stores/streamPresence.svelte';
import { openedTiles } from '$lib/stream/openedTiles.svelte';
import { hqTileId } from '$lib/stream/hqTile';
import { activeServer } from '$lib/stores/active-server.svelte';
import { m } from '$lib/paraglide/messages.js';

/**
 * Wie lange auf das erste Bild gewartet wird.
 *
 * Grosszügig: der Rechner muss den Encoder hochfahren, und auf einer
 * ausgelasteten Maschine dauert das. Zu kurz gewählt hiesse, dass die
 * Oberfläche „hat nicht geantwortet" sagt, während der Stream gerade anläuft —
 * der schlechteste Zeitpunkt für eine Absage.
 */
const WARTEN_MS = 25_000;

/** Ein Bildschirm samt der einen Angabe, die beide Oberflächen brauchen. */
export interface SchirmStand extends DeviceMonitor {
  /** Läuft er schon in einem Fenster? */
  open: boolean;
}

/**
 * Die Bildschirme eines Geräts, jeder mit „läuft schon".
 *
 * Meldet das Gerät keine (nie verbunden oder ältere Fassung), bleibt genau ein
 * Eintrag übrig: sein Hauptbildschirm. Das ist ehrlicher als eine erfundene
 * Liste — und der eine Knopf tut, was er immer getan hat.
 *
 * Erkannt wird „läuft schon" am **Namen**, den das Gerät beim Start
 * mitgeschickt hat (`stream/starten.ts` nimmt ihn aus der wirklich
 * aufgenommenen Quelle). Trifft der Name nicht, ist die Folge harmlos: der
 * Schirm gilt als nicht offen, ein Klick weckt ihn, und das Gerät verwirft den
 * Weckruf für eine schon laufende Quelle von selbst.
 */
export function schirmeVon(device: Device): SchirmStand[] {
  const stroeme = streamPresence
    .streamsIn(device.channel_id)
    .filter((s) => s.user_id === device.owner_user_id);
  const liste: DeviceMonitor[] =
    device.monitors.length > 0
      ? device.monitors
      : [{ index: 0, name: m.device_view_screen_primary(), primary: true }];
  return liste.map((mon) => ({
    ...mon,
    open: stroeme.some((s) => s.label === mon.name || s.label === `Monitor ${mon.index}`),
  }));
}

/** Der laufende Strom eines Bildschirms, oder `undefined`. */
function stromFuer(device: Device, mon: DeviceMonitor) {
  return streamPresence
    .streamsIn(device.channel_id)
    .filter((s) => s.user_id === device.owner_user_id)
    .find((s) => s.label === mon.name || s.label === `Monitor ${mon.index}`);
}

/** Das Fenster eines laufenden Stroms öffnen (oder nach vorne holen). */
function fensterOeffnen(device: Device, slot: number): void {
  openedTiles.open('hq', device.channel_id, hqTileId(device.owner_user_id, slot));
}

/**
 * Worauf gerade gewartet wird — je Gerät der angeforderte Bildschirm.
 *
 * Als Modul-Zustand und nicht in der Komponente, weil die Anforderung aus dem
 * Player-Fenster kommen kann, während die Geräteansicht gar nicht gemountet
 * ist. Die Wartezeit läuft dann trotzdem, und das Fenster geht auf, sobald das
 * Bild da ist.
 */
class SchirmWarten {
  /** `deviceId` → Bildschirm, auf den gewartet wird. */
  offen = $state<Record<string, DeviceMonitor>>({});
  /**
   * `deviceId` → welche Plätze beim Anfordern schon liefen.
   *
   * **Der Grund** (Bughunt 2026-08-16): das Netz in [`einloesen`] nahm
   * irgendeinen Strom dieses Geräts, falls der Name nicht traf — und beim
   * Dazuschalten eines zweiten Bildschirms lief immer schon einer. Das Netz
   * griff also sofort, löste den Wunsch mit dem BEREITS offenen Fenster ein und
   * räumte ihn ab. Der dazugeschaltete Bildschirm bekam nie ein Fenster; der
   * Knopf sah aus, als hätte er nichts getan. Nur ein Strom, der beim
   * Anfordern noch nicht lief, kann der gemeinte sein.
   */
  readonly #vorher = new Map<string, Set<number>>();
  readonly #wecker = new Map<string, ReturnType<typeof setTimeout>>();
  /** Letzter Fehlschlag je Gerät, für die Anzeige. */
  fehler = $state<Record<string, string>>({});

  wartetAuf(deviceId: string): DeviceMonitor | null {
    return this.offen[deviceId] ?? null;
  }

  /**
   * Einen Bildschirm anfordern.
   *
   * Läuft er schon, geht sein Fenster sofort auf — ohne Weckruf. Der wäre zwar
   * harmlos (das Gerät verwirft ihn), aber der Umweg über „warten" liesse den
   * Knopf ohne Grund eine Sekunde lang beschäftigt aussehen.
   */
  holen(device: Device, mon: DeviceMonitor): void {
    delete this.fehler[device.id];
    const laufend = stromFuer(device, mon);
    if (laufend) {
      fensterOeffnen(device, laufend.slot);
      return;
    }
    // `index: 0` ist der Ersatz-Eintrag ohne Bildschirmliste — dann ohne
    // Nummer wecken, und das Gerät nimmt seinen Hauptbildschirm.
    if (!geraetWecken(activeServer.serverId, device.id, mon.index || undefined)) {
      this.fehler[device.id] = m.device_view_wake_failed();
      return;
    }
    this.offen[device.id] = mon;
    this.#vorher.set(
      device.id,
      new Set(
        streamPresence
          .streamsIn(device.channel_id)
          .filter((s) => s.user_id === device.owner_user_id)
          .map((s) => s.slot),
      ),
    );
    const alt = this.#wecker.get(device.id);
    if (alt) clearTimeout(alt);
    this.#wecker.set(
      device.id,
      setTimeout(() => {
        this.#aufraeumen(device.id);
        this.fehler[device.id] = m.device_view_wake_failed();
      }, WARTEN_MS),
    );
  }

  /**
   * Prüfen, ob das erwartete Bild da ist — aus einem Effect gerufen, weil der
   * Strom asynchron erscheint und der Klick noch nicht weiss, wann.
   *
   * Liefert `true`, wenn ein Fenster geöffnet wurde.
   */
  einloesen(device: Device): boolean {
    const ziel = this.offen[device.id];
    if (!ziel) return false;
    const vorher = this.#vorher.get(device.id) ?? new Set<number>();
    const strom =
      stromFuer(device, ziel) ??
      // Netz für den Fall, dass der Name nicht trifft: ein NEUER Strom dieses
      // Geräts ist besser als gar keiner. Neu heisst: er lief beim Anfordern
      // noch nicht — sonst löste das Netz den Wunsch sofort mit dem Bildschirm
      // ein, der ohnehin schon offen war (s. `#vorher`).
      streamPresence
        .streamsIn(device.channel_id)
        .find((s) => s.user_id === device.owner_user_id && !vorher.has(s.slot));
    if (!strom) return false;
    this.#aufraeumen(device.id);
    fensterOeffnen(device, strom.slot);
    return true;
  }

  #aufraeumen(deviceId: string): void {
    const w = this.#wecker.get(deviceId);
    if (w) clearTimeout(w);
    this.#wecker.delete(deviceId);
    this.#vorher.delete(deviceId);
    delete this.offen[deviceId];
  }
}

export const schirmWarten = new SchirmWarten();
