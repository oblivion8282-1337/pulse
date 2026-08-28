/**
 * Der unverschluesselte Sendeweg eines Cloud-Gespraechs — herausgeloest aus
 * `routes/app/@me/[[dmChannelId]]/+page.svelte`, damit die Seite mit dem
 * Gruppen-Zweig (Etappe G) unter der harten Groessen-Grenze bleibt.
 *
 * Der Umzug aendert kein Verhalten: dieselbe optimistische Nachricht,
 * dieselbe Aufteilung (Anhaenge ueber REST, reiner Text ueber den
 * WS-Schnellweg), dasselbe Zeitlimit von 10 Sekunden, dieselben Meldungen.
 *
 * **Nur fuer DMs.** Eine private Gruppe hat diesen Weg nicht (Spec §9) und
 * ruft ihn deshalb nirgends auf — der Aufrufer entscheidet das vorher.
 *
 * `zeitgeber` ist die Zeitlimit-Buchhaltung der Seite: sie muss dort liegen,
 * weil die Seite sie beim Verlassen wieder abraeumt.
 */
import { toast } from 'svelte-sonner';

import { chatApi } from '$lib/api/chat';
import { parseMentionMarkers } from '$lib/components/messageRender';
import { m } from '$lib/paraglide/messages.js';
import { messages } from '$lib/stores/messages.svelte';
import { verlaufSpeichern } from '$lib/verlauf';
import { cloudGateway } from '$lib/ws/connection';

export interface KlartextSendeAuftrag {
  cid: string;
  text: string;
  autorId: string;
  replyToId: string | null;
  attachmentIds: string[];
  route: { serverId?: string };
  zeitgeber: Map<string, ReturnType<typeof setTimeout>>;
}

export function sendeKlartextDm(auftrag: KlartextSendeAuftrag): void {
  const { cid, text, autorId, replyToId, attachmentIds, route, zeitgeber } = auftrag;
  const nonce = `n-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
  const tmpId = `tmp-${nonce}`;
  messages.addOptimistic({
    id: tmpId,
    channel_id: cid,
    author_id: autorId,
    content: text,
    nonce,
    reply_to_id: replyToId,
    created_at: new Date().toISOString(),
    // Parse markers locally so mention pills render at once — the WS
    // echo replaces this copy with the server's authoritative list.
    mentions: parseMentionMarkers(text)
  });
  // Attachments go through REST — the WS send-op doesn't carry
  // attachment_ids and presigned URLs need server-side signing anyway.
  // Pure-text messages stay on the WS fast-path.
  if (attachmentIds.length > 0) {
    chatApi
      .postMessage(cid, text, { nonce, replyToId, attachmentIds }, route)
      .then((real) => {
        messages.upsert(real);
        void verlaufSpeichern(cid, [real]);
      })
      .catch((e) => {
        messages.removeOptimistic(cid, tmpId);
        toast.error(m.dm_page_send_failed(), { description: (e as Error).message });
      });
    return;
  }
  const queued = cloudGateway.send(cid, text, nonce, replyToId);
  if (!queued) {
    messages.removeOptimistic(cid, tmpId);
    toast.error(m.dm_page_no_connection());
    return;
  }
  const handle = setTimeout(() => {
    zeitgeber.delete(nonce);
    if (!messages.isConfirmed(nonce)) {
      messages.removeOptimistic(cid, tmpId);
      toast.error(m.dm_page_message_send_timeout());
    }
  }, 10_000);
  zeitgeber.set(nonce, handle);
}
