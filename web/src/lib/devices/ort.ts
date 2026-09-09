/**
 * „Werkstatt · Halle 1 · bereit" — der Ort eines Standplatz-Geräts in einer
 * Zeile, mit Zustand.
 *
 * Stand bis 2026-09-09 nur in `SettingsStandplatzGeraete`; seit die Karte
 * für den eigenen Rechner denselben Satz in ihrer Kopfzeile trägt, liegt er
 * hier einmal. Greift auf die Stores zu (Community- und Kanalnamen) und ist
 * deshalb nicht in `darstellung.ts` neben den reinen Helfern.
 */
import type { Device } from '$lib/api/devices';
import { guilds } from '$lib/stores/guilds.svelte';
import { zustandsText } from '$lib/devices/darstellung';
import { m } from '$lib/paraglide/messages.js';

export function geraetOrtText(device: Device): string {
  const guild = guilds.byId[device.guild_id]?.name ?? device.guild_id;
  const channel =
    (guilds.channelsByGuild[device.guild_id] ?? []).find((c) => c.id === device.channel_id)?.name ??
    device.channel_id;
  return m.device_settings_my_devices_meta({ guild, channel, state: zustandsText(device.state) });
}
