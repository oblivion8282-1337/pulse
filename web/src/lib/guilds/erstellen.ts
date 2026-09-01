/**
 * Gemeinsames Anlegen einer Community (Home-Landing und Guild-Kanal-Seite
 * hatten denselben Ablauf doppelt). Legt die Community + den `general`-
 * Kanal an, seedet die per-Guild-Stores sofort (ohne den Seed bliebe das
 * Owner-UI gesperrt, bis der nächste WS-`ready`-Rebuild es freigibt) und
 * navigiert in den neuen Kanal.
 */
import { goto } from '$app/navigation';
import { chatApi } from '$lib/api/chat';
import { rolesApi } from '$lib/api/roles';
import { guilds } from '$lib/stores/guilds.svelte';
import { guildSounds } from '$lib/stores/guildSounds.svelte';
import { roles } from '$lib/stores/roles.svelte';

export async function erstelleCommunity(name: string): Promise<void> {
  const g = await chatApi.createGuild(name);
  guilds.add(g);
  // Seed empty stores for the new guild so per-guild affordances render
  // immediately as "no overrides yet" / owner-grants-all instead of
  // staying hidden until the next WS reconnect rebuilds ``ready``.
  roles.recomputeGuild(g.id);
  guildSounds.ensureSlot(g.id);
  void rolesApi
    .list(g.id)
    .then((rows) => {
      for (const r of rows) roles.upsertRole(r);
    })
    .catch(() => undefined);
  const c = await chatApi.createChannel(g.id, { name: 'general' });
  guilds.addChannel(c);
  await goto(`/app/guilds/${g.id}/channels/${c.id}`);
}
