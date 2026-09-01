/**
 * Rail-nahe Navigations-Helfer: was ein Klick auf eine Guild bzw. einen DM-
 * Eintrag in der GuildRail / DMChannelList tut (Drawer öffnen/schließen +
 * Route). Dieselben zwei Funktionen standen vorher in vier Bereichs-Seiten
 * (@me, friends, invites, server) doppelt.
 *
 * Der Kanal-Kanal (`guilds/.../[channelId]`) bleibt bewusst eigens: dort ist
 * der Parameter die Guild-ID selbst und ein Klick auf die aktive Guild soll
 * nichts navigieren.
 */
import { goto } from '$app/navigation';
import { navDrawer } from '$lib/stores/navDrawer.svelte';

/** Guild in der Rail angeklickt: Kanal-Drawer auf und in die Guild. */
export async function selectGuild(g: { id: string }): Promise<void> {
  navDrawer.open = true;
  await goto(`/app/guilds/${g.id}/channels/_`);
}

/** DM in der Liste angeklickt: Drawer zu und in den Chat. */
export async function selectDM(dm: { id: string }): Promise<void> {
  navDrawer.open = false;
  await goto(`/app/@me/${dm.id}`);
}
