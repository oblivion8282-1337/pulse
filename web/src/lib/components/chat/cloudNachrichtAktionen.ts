/**
 * Bearbeiten, Loeschen und Reagieren im Cloud-Gespraech — herausgeloest aus
 * `routes/app/@me/[[dmChannelId]]/+page.svelte`, als diese mit dem
 * Gruppen-Zweig (Etappe G) ueber die harte Groessen-Grenze gewachsen waere.
 *
 * Der Umzug aendert kein Verhalten: dieselben Routen, dieselbe Cloud-
 * Skopierung, dieselben Fehlermeldungen. Die drei Aufrufe gelten fuer DMs und
 * private Gruppen gleichermassen — sie sprechen den Kanal ueber die
 * Nachrichten-ID an, nicht ueber die Kanalart.
 *
 * **Was fuer eine verschluesselte Nachricht davon wirkt, entscheidet der
 * Server, nicht diese Datei.** Eine lokal abgelegte, verschluesselte
 * Nachricht hat keine Server-Zeile; die Route findet sie nicht. Der Fehler
 * wird deshalb angezeigt und nicht verschluckt.
 */
import { toast } from 'svelte-sonner';

import { chatApi } from '$lib/api/chat';
import { confirmDialog } from '$lib/components/feedback/confirm.svelte';
import { m } from '$lib/paraglide/messages.js';
import type { Message } from '$lib/api/types';

type Route = { serverId?: string };

export async function nachrichtBearbeiten(
  msg: Message,
  content: string,
  route: Route
): Promise<void> {
  try {
    await chatApi.editMessage(msg.id, content, {}, route);
  } catch (e) {
    toast.error(m.dm_page_edit_failed());
    console.error(e);
  }
}

export async function nachrichtLoeschen(msg: Message, route: Route): Promise<void> {
  const ok = await confirmDialog({
    description: m.dm_page_delete_confirm(),
    destructive: true
  });
  if (!ok) return;
  try {
    await chatApi.deleteMessage(msg.id, route);
  } catch (e) {
    toast.error(m.dm_page_delete_failed());
    console.error(e);
  }
}

export async function reaktionUmschalten(
  msg: Message,
  emoji: string,
  currentlyMine: boolean,
  route: Route
): Promise<void> {
  const action = currentlyMine ? chatApi.removeReaction : chatApi.addReaction;
  try {
    await action(msg.id, emoji, route);
  } catch (e) {
    toast.error(m.dm_page_reaction_failed());
    console.error(e);
  }
}
