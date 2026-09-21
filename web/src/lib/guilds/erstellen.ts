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
import type { Channel, Guild } from '$lib/api/types';
import { guilds } from '$lib/stores/guilds.svelte';
import { guildSounds } from '$lib/stores/guildSounds.svelte';
import { roles } from '$lib/stores/roles.svelte';
import { melde } from '$lib/diagnose/app-diagnose';

export async function erstelleCommunity(name: string): Promise<void> {
  let erstellt: { g: Guild; c: Channel } | null = null;
  try {
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
    // Bughunt Runde 26: scheitert der general-Kanal (Netz-Blip), WAR die
    // Guild schon angelegt — ein Retry legte eine ZWEITE Community an und
    // ließ die erste als Waise zurück. Stattdessen: direkt in die neue
    // Guild navigieren (Kanal per UI nachholbar), Fehler als solche melden.
    const c = await chatApi.createChannel(g.id, { name: 'general' });
    guilds.addChannel(c);
    erstellt = { g, c };
  } catch (err) {
    // Diagnose-Gedächtnis (feat/diagnose-berichte): gerade dieser Call war
    // 2026-09-21 der Supportfall („Server nicht erreichbar" beim Anlegen).
    // status > 0 = echte HTTP-Antwort des Servers; 0/undefined = kam nie an
    // (netz). `goto` ist bewusst NICHT im try: ein Navigationsfehler nach
    // erfolgreichem Anlegen wäre kein api_fehler.
    const status = (err as { status?: number })?.status;
    melde(
      'api',
      `api_fehler_${typeof status === 'number' && status > 0 ? status : 'netz'}`,
      'Community anlegen fehlgeschlagen',
      { aktion: 'community_erstellen' }
    );
    // Bughunt Runde 26-Navigation: bei CREATE-Fehler zur Guild statt Waise.
    if (erstellt) await goto(`/app/guilds/${erstellt.g.id}`);
    throw err;
  }
  await goto(`/app/guilds/${erstellt!.g.id}/channels/${erstellt!.c.id}`);
}
