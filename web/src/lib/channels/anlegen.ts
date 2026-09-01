import { errText } from '$lib/utils/errText';
/**
 * Einen Kanal anlegen — die eine Fassung für alle Aufrufer.
 *
 * Stand bis zum Mobil-Umbau nur in der Kanal-Route. Der Räume-Bereich
 * (`/app/rooms/[guildId]`) hat denselben „+"-Knopf; die Logik ein zweites Mal
 * hinzuschreiben hätte bedeutet, dass der Ablage-Sonderfall und seine
 * 409-Behandlung irgendwann nur noch an einer der beiden Stellen stimmen.
 */
import { goto } from '$app/navigation';
import { toast } from 'svelte-sonner';
import { chatApi } from '$lib/api/chat';
import { dropboxApi } from '$lib/api/dropbox';
import { guilds } from '$lib/stores/guilds.svelte';
import { m } from '$lib/paraglide/messages.js';

/**
 * Legt einen Kanal an und navigiert hinein.
 *
 * @returns `true`, wenn der Kanal entstanden ist — der Aufrufer schliesst dann
 *   seinen Dialog. Bei einem Fehler `false`; der Dialog bleibt offen, damit
 *   der eingetippte Name nicht verloren geht.
 */
export async function kanalAnlegen(
  guildId: string,
  name: string,
  type: number
): Promise<boolean> {
  if (!guildId) return false;
  try {
    // Type=2 (Dropbox / Ablage) is special — there's at most one per
    // guild. POST /guilds/{id}/dropbox/channel is idempotent: it
    // creates with the user-supplied name on first call, hands back
    // the existing channel on subsequent calls (admin renames via
    // PATCH instead of creating a new one).
    let newChannelId: string;
    if (type === 2) {
      const ch = await dropboxApi.createDropboxChannel(guildId, name);
      guilds.addChannel({
        id: ch.id,
        guild_id: ch.guild_id,
        name: ch.name,
        type: ch.type,
        position: ch.position,
        topic: null,
        created_at: new Date().toISOString()
      });
      newChannelId = ch.id;
    } else {
      const ch = await chatApi.createChannel(guildId, { name, type });
      guilds.addChannel(ch);
      newChannelId = ch.id;
    }
    await goto(`/app/guilds/${guildId}/channels/${newChannelId}`);
    return true;
  } catch (e) {
    // 409 vom Ablage-Endpoint = die Community hat ihre Ablage abgeschaltet
    // (Sicherheitsnetz — der Dialog blendet die Option normalerweise aus,
    // aber ein Klick vor dem Nachladen des Schalters landet hier).
    const status = (e as { status?: number })?.status;
    toast.error(
      type === 2 && status === 409
        ? m.channel_page_dropbox_disabled()
        : m.channel_page_create_failed(),
      { description: errText(e) }
    );
    return false;
  }
}
