/**
 * Standplatz-Geräte — die beiden Meldungen vom Gateway.
 *
 * `device_changed` trägt die ganze Zeile (eingetragen, umbenannt, umgestellt,
 * entfernt), `device_state` nur den Zustand (bereit / belegt / offline). Beide
 * sind schon im Gateway nach dem Standplatz gefiltert: wer den Kanal nicht
 * sehen darf, bekommt sie gar nicht (`pubsub_channel_guild.py`).
 *
 * Der Handler prüft trotzdem die Form, wie überall auf diesem Weg — was hier
 * ankommt, hat den Server passiert, aber nicht notwendigerweise in der
 * Fassung, die dieser Client erwartet (ältere/neuere Gegenstelle).
 */
import type { Device, DeviceState } from '$lib/api/devices';
import { deviceStore } from '$lib/devices/store.svelte';
import { registerWsHandler } from '../handler-registry';
import { weckrufBehandeln } from '$lib/devices/wecken';
import { dispatchingServerId } from '$lib/ws/gateway-connection';

const ZUSTAENDE: readonly DeviceState[] = ['ready', 'busy', 'offline'];

function istZustand(wert: unknown): wert is DeviceState {
  return typeof wert === 'string' && (ZUSTAENDE as readonly string[]).includes(wert);
}

export function register(): void {
  // Der Weckruf gilt nur DIESEM Rechner — die Pruefung, ob er gemeint ist,
  // steht in `wecken.ts` (der Ruf kommt ueber die eigene Verbindung, aber ein
  // Fenster desselben Kontos auf einem anderen Rechner darf sich davon nicht
  // angesprochen fuehlen). Auf der Verbindung, die ihn gebracht hat: eine
  // Eintragung gehoert einem Server, nicht „dem gerade aktiven".
  registerWsHandler('device_wake', (evt) => {
    if (!evt.device_id || !evt.channel_id) return;
    void weckrufBehandeln(
      dispatchingServerId(),
      String(evt.device_id),
      String(evt.channel_id),
      typeof evt.monitor === 'number' ? evt.monitor : undefined,
    );
  });

  registerWsHandler('device_changed', (evt) => {
    const geraet = evt.device as Device | undefined;
    if (!evt.guild_id || !geraet?.id) return;
    deviceStore._changed(String(evt.guild_id), geraet, evt.removed === true);
  });

  registerWsHandler('device_state', (evt) => {
    if (!evt.guild_id || !evt.device_id || !istZustand(evt.state)) return;
    deviceStore._state(
      String(evt.guild_id),
      String(evt.device_id),
      evt.state,
      typeof evt.busy_with === 'string' ? evt.busy_with : null,
      // Die Bildschirme kommen über denselben Anlass herein wie der Zustand
      // (die Anmeldung des Geräts). Fehlen sie im Rahmen, bleibt die zuletzt
      // bekannte Liste stehen — eine ältere Gegenstelle soll sie nicht löschen.
      Array.isArray(evt.monitors) ? evt.monitors : undefined,
    );
  });
}
