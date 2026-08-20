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
import { geraeteAnmeldung } from '$lib/devices/anmeldung.svelte';
import { nachzugFuer } from '$lib/devices/nachzugAktion';

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
      // Wer geweckt hat, kommt mit: der Weckruf ist ein Eingriff an einem
      // unbeaufsichtigten Rechner und gehoert deshalb ins Geraete-Protokoll —
      // auch dann, wenn nie eine Uebernahme daraus wird (`wecken.ts`).
      typeof evt.from_user_id === 'string' ? evt.from_user_id : null,
      typeof evt.monitor === 'number' ? evt.monitor : undefined,
    );
  });

  registerWsHandler('device_changed', (evt) => {
    const geraet = evt.device as Device | undefined;
    if (!evt.guild_id || !geraet?.id) return;
    deviceStore._changed(String(evt.guild_id), geraet, evt.removed === true);
    // **Und die eigene Eintragung mitziehen.** Ohne das bleibt ein Rechner
    // nach dem Entfernen im Standplatz-Betrieb (hält den Schirm wach, meldet
    // sich bei jedem Verbinden als ein Gerät an, das es nicht gibt) — und nach
    // einem Community-Wechsel aus der Ferne zeigt seine Eintragung auf die
    // alte Community.
    //
    // Die Entscheidung selbst (`nachzugAktion.ts::nachzugFuer`) ist geprüft:
    // eine Meldung über ein fremdes Gerät (keine lokale Eintragung mit dieser
    // Kennung) greift hier NIE, und die Abmeldung an den alten Standplatz
    // beim Umstellen (`moved: true`) räumt NICHTS weg — die direkt danach
    // eintreffende Änderungsmeldung mit dem neuen Standplatz zieht nach.
    const guildId = String(geraet.guild_id);
    switch (
      nachzugFuer(
        {
          deviceId: geraet.id,
          guildId,
          name: geraet.name,
          entfernt: evt.removed === true,
          umzug: evt.moved === true,
        },
        geraeteAnmeldung.eintragungen,
      )
    ) {
      case 'vergessen':
        void geraeteAnmeldung.vergessen(geraet.id);
        break;
      case 'nachziehen':
        void geraeteAnmeldung.nachziehen(geraet.id, guildId, geraet.name);
        break;
    }
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
      // Dieselbe Lesart wie bei den Bildschirmen: fehlt das Feld im Rahmen,
      // bleibt der letzte Stand stehen. Eine LEERE Liste ist dagegen eine
      // Aussage („sendet nicht mehr") und muss durchkommen — sonst bliebe das
      // LIVE-Abzeichen am Gerät kleben, nachdem es eingeschlafen ist.
      Array.isArray(evt.stream_slots) ? evt.stream_slots.map(Number) : undefined,
    );
  });
}
