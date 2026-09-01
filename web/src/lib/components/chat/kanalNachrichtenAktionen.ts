/**
 * Nachrichten-Aktionen eines Community-Kanals (senden/bearbeiten/loeschen/
 * reagieren) — herausgeloest aus der Kanal-Seite, dieselbe Begruendung wie
 * bei `chat/kanalWechsel.svelte.ts` fuer den Kanalwechsel. Kein `$state`
 * noetig (die einzige veraenderliche Groesse ist die Map der ausstehenden
 * Optimistic-Timeouts, ein normaler Wert in einem Closure) — deshalb ein
 * gewoehnliches `.ts`-Modul statt `.svelte.ts`.
 */
import { toast } from 'svelte-sonner';
import { auth } from '$lib/stores/auth.svelte';
import { currentServerUserId } from '$lib/stores/currentServerUser';
import { messages } from '$lib/stores/messages.svelte';
import { chatApi } from '$lib/api/chat';
import { gateway } from '$lib/ws/connection';
import { parseMentionMarkers } from '$lib/components/messageRender';
import { confirmDialog } from '$lib/components/feedback/confirm.svelte';
import { ABLAGE_KANAL_ENABLED } from '$lib/featureFlags';
import { sendeAblageKanalNachricht } from '$lib/components/chat/ablageKanalSenden';
import type { Channel, Message } from '$lib/api/types';
import { m as pm } from '$lib/paraglide/messages.js';

export function erstelleKanalNachrichtenAktionen() {
  // Tracks pending optimistic-message timeout handles; cancelled on nav/destroy.
  const pendingOptimisticTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

  function sendMessage(
    guildId: string,
    channel: Channel | null,
    text: string,
    replyToId: string | null,
    attachmentIds: string[]
  ) {
    if (!channel || channel.type !== 0 || !auth.user) return;
    // Ablage-Kanal: eigener, verschluesselter Weg, s. `kanalSenden.ts`.
    // **Kein Klartext-Rueckfall** — der Server weist Klartext auf JEDEM Weg
    // ab (Auftrag), ein Abrutschen in den Zweig unten wuerde also nur einen
    // serverseitigen Fehlschlag erzeugen. Deshalb ein eigener, fruehzeitiger
    // return statt eines zusaetzlichen Zweigs weiter unten.
    if (ABLAGE_KANAL_ENABLED && channel.ablage) {
      sendeAblageKanalNachricht(guildId, channel.id, text, replyToId, attachmentIds);
      return;
    }
    const nonce = `n-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
    const tmpId = `tmp-${nonce}`;
    const cid = channel.id;
    messages.addOptimistic({
      id: tmpId,
      channel_id: cid,
      author_id: currentServerUserId() ?? auth.user.id,
      content: text,
      nonce,
      reply_to_id: replyToId,
      created_at: new Date().toISOString(),
      // Parse markers locally so mention pills render at once — the WS
      // echo replaces this copy with the server's authoritative list.
      mentions: parseMentionMarkers(text)
    });
    // Attachments go through REST — WS send-op carries no attachment_ids,
    // and presigned URLs need server-side signing. Text-only stays on the
    // optimistic WS path for the latency it saves.
    if (attachmentIds.length > 0) {
      chatApi
        .postMessage(cid, text, { nonce, replyToId, attachmentIds })
        .then((real) => messages.upsert(real))
        .catch((e) => {
          messages.removeOptimistic(cid, tmpId);
          toast.error(pm.channel_page_send_failed(), { description: (e as Error).message });
        });
      return;
    }
    const queued = gateway.send(cid, text, nonce, replyToId);
    if (!queued) {
      // WS not open — roll back the optimistic message and inform the user.
      messages.removeOptimistic(cid, tmpId);
      toast.error(pm.channel_page_no_connection());
      return;
    }
    const handle = setTimeout(() => {
      pendingOptimisticTimeouts.delete(nonce);
      if (!messages.isConfirmed(nonce)) {
        messages.removeOptimistic(cid, tmpId);
        toast.error(pm.channel_page_message_not_sent());
      }
    }, 10_000);
    pendingOptimisticTimeouts.set(nonce, handle);
  }

  async function editMessage(m: Message, content: string) {
    try {
      await chatApi.editMessage(m.id, content);
      // WS broadcasts `message_update` to update local store.
    } catch (e) {
      toast.error(pm.channel_page_edit_failed());
      console.error(e);
    }
  }

  async function deleteMessage(m: Message) {
    const ok = await confirmDialog({
      description: pm.channel_page_confirm_delete_message(),
      destructive: true
    });
    if (!ok) return;
    try {
      await chatApi.deleteMessage(m.id);
      // WS broadcasts `message_delete`.
    } catch (e) {
      toast.error(pm.channel_page_delete_failed());
      console.error(e);
    }
  }

  async function toggleReaction(m: Message, emoji: string, currentlyMine: boolean) {
    try {
      if (currentlyMine) {
        await chatApi.removeReaction(m.id, emoji);
      } else {
        await chatApi.addReaction(m.id, emoji);
      }
      // WS broadcasts reaction_add/reaction_remove.
    } catch (e) {
      toast.error(pm.channel_page_reaction_failed());
      console.error(e);
    }
  }

  function aufraeumen() {
    for (const handle of pendingOptimisticTimeouts.values()) clearTimeout(handle);
    pendingOptimisticTimeouts.clear();
  }

  return { sendMessage, editMessage, deleteMessage, toggleReaction, aufraeumen };
}
