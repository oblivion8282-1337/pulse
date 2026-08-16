/**
 * Darf ich diesen Streamer überhaupt fernsteuern? — die Vorprüfung, die es
 * inzwischen an **zwei** Stellen braucht:
 *
 * * am Anfrage-Knopf beim Zuschauen (`components/RemoteRequestButton.svelte`),
 * * beim Standplatz-Gerät, das die Übernahme selbst auslöst
 *   (`$lib/devices/schirme.svelte.ts`).
 *
 * Best-effort und bewusst nicht der eigentliche Riegel: massgeblich ist der
 * Gateway, der eine Anfrage ohne `REMOTE_CONTROL` mit 4051 abweist. Hier geht
 * es nur darum, einen Weg gar nicht erst anzubieten, den der Server gleich
 * darauf zumacht — und beim Gerät zusätzlich darum, dem Besitzer keinen
 * Zustimmungs-Dialog für eine Anfrage zu schicken, die ohnehin scheitert.
 *
 * Ohne auflösbaren Kanal (DM, Kanal noch nicht im Store) wird **nicht** gegatet:
 * ein fehlender Store-Eintrag ist keine Aussage über Rechte, und der Server
 * entscheidet ohnehin.
 */

import { currentServerUserId } from '$lib/stores/currentServerUser';
import { guilds } from '$lib/stores/guilds.svelte';
import { channelPermissions } from '$lib/stores/channelPermissions.svelte';
import { Perm } from '$lib/permissions/bitfield';

export function darfFernsteuern(channelId: string, hostUserId: string): boolean {
  // Sich selbst fernzusteuern ergibt keinen Sinn — und beim eigenen Gerät wäre
  // es der Rechner, an dem man gerade sitzt.
  //
  // **Gegen die serverlokale Kennung** (Bughunt 2026-08-16): `hostUserId` kommt
  // aus einem Stream oder einer Gerätezeile DIESES Servers, `auth.user.id` ist
  // immer die Cloud-Kennung. Auf einem Self-Host traf der Vergleich deshalb nie
  // — der eigene Rechner liess sich anfragen, und der Gateway wies es mit 4050
  // ab, nachdem der Weckruf längst hinaus war.
  if (currentServerUserId() === hostUserId) return false;
  const channel = Object.values(guilds.channelsByGuild)
    .flat()
    .find((c) => c.id === channelId);
  if (!channel) return true;
  return channelPermissions.hasChannelPermission(
    channel.guild_id,
    channel.id,
    Perm.REMOTE_CONTROL,
  );
}
