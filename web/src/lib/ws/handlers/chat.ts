/**
 * Chat-domain handlers: `message`, `message_update`, `message_delete`,
 * `reaction_add`, `reaction_remove`, `channel_bump`, `dm_bump`,
 * `mention_added`, `stream_chat_message`, `watch_chat_message`.
 *
 * Sound + read-state logic lives here because every chat-shaped event
 * touches the same two: bump the channel's last-seen pointer, optionally
 * play a notification chime, optionally surface a toast / in-page
 * notification. Mention suppression is shared with this module so the
 * chime + bump sound don't double up.
 */
import { messages } from '$lib/stores/messages.svelte';
import { directMessages } from '$lib/stores/directMessages.svelte';
import { verlaufSpeichern, verlaufNachrichtGeloescht } from '$lib/verlauf';
import { E2E_DMS_ENABLED } from '$lib/krypto/schalter';
import { dmGegenstelle } from '$lib/krypto/dmGegenstelle';
import { streamChat } from '$lib/stores/streamChat.svelte';
import { watchChat } from '$lib/stores/watchChat.svelte';
import { readState } from '$lib/stores/readState.svelte';
import { typing } from '$lib/stores/typing.svelte';
import { userCache } from '$lib/stores/users.svelte';
import { dispatchingUserId } from '$lib/stores/currentServerUser';
import { guilds } from '$lib/stores/guilds.svelte';
import { fireInPageNotification, isDnd } from '$lib/notifications/inPage';
import { sichtschutzAktiv } from '$lib/remote/sichtschutz';
import { viewport } from '$lib/stores/viewport.svelte';
import { sounds } from '$lib/sounds/engine';
import { goto } from '$app/navigation';
import { toast } from 'svelte-sonner';
import { registerWsHandler } from '../handler-registry';
import { isRecentMention, markRecentMention } from './_mentionSuppression';
import type { HandlerContext } from './context';
import { m } from '$lib/paraglide/messages.js';

// Vorschau-Auffrischung nach dm_bump: der Bump-Envelope trägt bewusst keinen
// Inhalt (Privacy-Design für E2EE), also kann `upsertFromBump` nur die
// Reihenfolge reparieren — Vorschautext und Uhrzeit kämen erst beim nächsten
// hydrate. Statt den Inhalt in den Event zu ziehen (und damit die
// Inhalt-Freiheit des Envelopes aufzugeben), wird hier die Liste nachgeladen,
// entprellt: wer schnell hintereinander schreibt, löst EINEN Request aus.
let dmVorschauTimer: ReturnType<typeof setTimeout> | null = null;
function dmVorschauAuffrischen(): void {
  if (dmVorschauTimer) clearTimeout(dmVorschauTimer);
  dmVorschauTimer = setTimeout(() => {
    dmVorschauTimer = null;
    void directMessages.hydrate();
  }, 1500);
}

/**
 * Holt offene Postfach-Zustellungen ab, entschluesselt sie und zeigt sie an
 * — geteilt zwischen zwei Ausloesern (Bughunt-Runde 3, FIX 1): dem `postfach_
 * neu`-Weckruf hier unten UND `ws/handlers/ready.ts` (jeder Connect/Reconnect
 * — bis Runde 3 gab es dort GAR KEINEN Abholversuch, sodass eine waehrend
 * der Abwesenheit zugestellte Nachricht nie abgefragt wurde, wenn Tab-Schluss/
 * Verbindungsabriss/ein verlorener Redis-Weckruf den einzigen Ausloeser
 * verpasste — s. `docs/superpowers/plans/2026-08-28-etappe-d2-klient-
 * verschluesselt.md`, „Auf `postfach_neu` (WS) und beim Start abholen"). Das
 * eigentliche Einzeltakt-Gate (`laufenderZyklus`) sitzt in `empfangen.ts` —
 * beide Ausloeser haengen sich bei Ueberlappung an denselben Zyklus an, statt
 * ihn doppelt zu fahren.
 *
 * `istAboniert` entscheidet, ob eine neue Nachricht sofort als gelesen gilt
 * (der Kanal ist gerade offen) oder den Ungelesen-Zaehler erhoeht — sowohl
 * der `postfach_neu`-Aufrufer als auch der `ready`-Aufrufer reichen dafuer
 * denselben Live-Blick auf `subs` durch (`ctx.subs` bzw. `ctx.getSubs()`,
 * s. `ready.ts`), keiner der beiden faellt mehr auf "nie abonniert" zurueck.
 */
export function postfachAbholenUndAnzeigen(istAboniert: (kanalId: string) => boolean): void {
  // Der Schalter ist aus (s. `$lib/krypto/schalter.ts`) — solange bleibt
  // dieser Weckruf wirkungslos, jede DM laeuft ueber `message` weiter.
  if (!E2E_DMS_ENABLED) return;
  // Dynamischer Import: der Krypto-Kern (WASM) soll nicht in jedem
  // Session-Start geladen werden, wenn er nie gebraucht wird.
  void import('$lib/krypto/empfangen')
    .then(({ postfachAbholenUndEntschluesseln }) => postfachAbholenUndEntschluesseln())
    // Abgelegt hat `empfangen.ts` schon selbst; hier kommt nur noch die
    // Anzeige dazu.
    .then((neue) => {
      const me = dispatchingUserId();
      for (const nachricht of neue) {
        messages.upsert(nachricht);
        // Die DM-Liste nachziehen (Bughunt 2026-08-28, FIX 3) — der
        // verschluesselte Weg loest kein `dm_bump` aus, das die
        // Reihenfolge/den Ungelesen-Stand sonst besorgt. Gegenstelle:
        // der Absender, ausser er ist man selbst (eigenes anderes
        // Geraet) — dann bleibt nur der bereits bekannte Kanal-Gegenpart,
        // s. `upsertFromEncrypted`-Docstring.
        if (!me) continue;
        const otherUserId = dmGegenstelle(
          nachricht.author_id,
          me,
          directMessages.byId[nachricht.channel_id]?.other_user_id
        );
        if (otherUserId) {
          directMessages.upsertFromEncrypted({
            channel_id: nachricht.channel_id,
            message_id: nachricht.id,
            otherUserId,
            inhalt: nachricht.content,
            autorId: nachricht.author_id,
            erstelltAm: nachricht.created_at,
            anhaenge: nachricht.attachments
          });
        }
        if (nachricht.author_id !== me) {
          readState.recordSeen(nachricht.channel_id, nachricht.id);
          if (istAboniert(nachricht.channel_id)) {
            readState.markRead(nachricht.channel_id, nachricht.id);
          } else {
            readState.incUnread(nachricht.channel_id);
            // Toast/Ton/In-Page-Benachrichtigung — zieht mit `dm_bump` gleich
            // (Bughunt Runde 4, Befund 1: vorher loeste der verschluesselte
            // Weg keins von beiden aus). Anders als beim Klartext-`dm_bump`
            // liegt der Text hier schon entschluesselt vor und darf deshalb
            // direkt in Toast/Benachrichtigung stehen.
            const cached = userCache.get(nachricht.author_id);
            const senderLabel = cached
              ? m.chat_handler_dm_sender_label({ sender: '@' + (cached.display_name ?? cached.username) })
              : '';
            const snippet = nachricht.content.slice(0, 140);
            if (!isDnd() && !sichtschutzAktiv() && !viewport.isMobile) {
              toast.message(m.chat_handler_dm_new_message({ senderLabel }), {
                description: snippet || undefined,
                action: {
                  label: m.chat_handler_dm_open(),
                  onClick: () => {
                    void goto(`/app/@me/${nachricht.channel_id}`);
                  }
                }
              });
            }
            const senderName = cached?.display_name ?? cached?.username ?? null;
            fireInPageNotification({
              kind: 'dm',
              title: senderName ?? m.chat_handler_dm_notification_unknown_sender(),
              body: snippet || m.chat_handler_dm_notification_body(),
              channelId: nachricht.channel_id,
              messageId: nachricht.id,
              guildId: null
            });
            if (!isDnd()) sounds.play('notification.dm');
          }
        }
      }
    })
    .catch(() => {
      // Nicht quittierte Umschlaege bleiben auf dem Server liegen (s.
      // `empfangen.ts`) — der naechste Weckruf/Connect holt sie nach. Kein
      // Log: eine Fehlermeldung hier duerfte nichts ueber den Inhalt sagen
      // und saehe fuer den Nutzer wie ein Zustellfehler aus, der es nicht ist.
    });
}

export function register(ctx: HandlerContext): void {
  registerWsHandler('message', (evt) => {
    messages.upsert(evt.data);
    void verlaufSpeichern(evt.data.channel_id, [evt.data]);
    // A delivered message means the author just stopped typing — drop their
    // "X schreibt …" immediately instead of waiting out the 6s TTL.
    typing.clear(evt.data.channel_id, evt.data.author_id);
    // Own messages don't make a channel unread for ourselves.
    if (evt.data.author_id !== dispatchingUserId()) {
      readState.recordSeen(evt.data.channel_id, evt.data.id);
      // We only get this op for channels we're subscribed to — i.e. the
      // one we're currently viewing — so it's safe to also mark it read.
      if (ctx.subs.has(evt.data.channel_id)) {
        readState.markRead(evt.data.channel_id, evt.data.id);
      }
    }
  });

  registerWsHandler('message_update', (evt) => {
    messages.update(evt.data);
    void verlaufSpeichern(evt.data.channel_id, [evt.data]);
  });

  registerWsHandler('message_delete', (evt) => {
    messages.remove(evt.data.channel_id, evt.data.id);
    verlaufNachrichtGeloescht(evt.data.channel_id, evt.data.id);
  });

  registerWsHandler('reaction_add', (evt) => {
    messages.applyReaction(evt.data, +1);
  });

  registerWsHandler('reaction_remove', (evt) => {
    messages.applyReaction(evt.data, -1);
  });

  registerWsHandler('typing', (evt) => {
    // Ephemeral "X schreibt …". The sender gets its own echo back — ignore it.
    if (evt.user_id === dispatchingUserId()) return;
    userCache.queue(evt.user_id); // so we can show their name
    typing.mark(evt.channel_id, evt.user_id);
  });

  registerWsHandler('message_ack', () => {
    // No-op on the dispatcher side: the send/ack flow is handled by the
    // optimistic-send path in messages store, not via the registry.
  });

  registerWsHandler('channel_bump', (evt) => {
    if (evt.author_id !== dispatchingUserId() && guilds.byId[evt.guild_id]) {
      readState.recordSeen(evt.channel_id, evt.message_id);
      // If we're currently viewing this channel the message op already
      // ran the markRead — but in case the bump arrived first, do it
      // again here. markRead is idempotent.
      if (ctx.subs.has(evt.channel_id)) {
        readState.markRead(evt.channel_id, evt.message_id);
      } else {
        readState.incUnread(evt.channel_id);
        if (!isRecentMention(evt.message_id) && !isDnd()) {
          sounds.play('notification.message', { guildId: evt.guild_id });
        }
      }
    }
  });

  registerWsHandler('dm_bump', (evt) => {
    // We get this fanned to every connected socket — first decide if
    // we're a member (one of the two user ids). Non-members ignore.
    const me = dispatchingUserId();
    if (!me) return;
    const isMember = evt.user_a_id === me || evt.user_b_id === me;
    if (!isMember) return;
    // Upsert: bumps an existing DM's last_message_id, or creates the
    // record if the other side just opened a new DM with us (we
    // wouldn't have it in the store yet otherwise).
    directMessages.upsertFromBump({
      channel_id: evt.channel_id,
      user_a_id: evt.user_a_id,
      user_b_id: evt.user_b_id,
      message_id: evt.message_id,
      currentUserId: me
    });
    if (evt.author_id !== me) {
      readState.recordSeen(evt.channel_id, evt.message_id);
      if (ctx.subs.has(evt.channel_id)) {
        // Already viewing this DM — mark read, no toast.
        readState.markRead(evt.channel_id, evt.message_id);
      } else {
        readState.incUnread(evt.channel_id);
        dmVorschauAuffrischen();
        // Not currently in this DM. Toast the user. We intentionally
        // surface only the sender's name, not the message content,
        // so the UX stays identical when DMs go E2EE in Phase 2.
        // If the sender isn't in cache yet (we've never rendered them
        // anywhere) we just drop the name from the toast rather than
        // show a "…" placeholder.
        const cached = userCache.get(evt.author_id);
        const senderLabel = cached
          ? m.chat_handler_dm_sender_label({ sender: '@' + (cached.display_name ?? cached.username) })
          : '';
        const channelId = evt.channel_id;
        // Kein Toast, solange der Sichtschutz steht: sonner rendert mit
        // z-index 999999999 und lag damit ÜBER dem Riegel des ferngesteuerten
        // Standplatz-Geräts — der Name des Absenders stand mitten auf dem
        // Bild, das gerade ein Fremder sieht (`$lib/remote/sichtschutz.ts`).
        // Am Handy ebenfalls keiner: dort ist die Chats-Liste selbst die
        // Benachrichtigung (Badge + Vorschau), und ein Toast überdeckt die
        // Bereichs-Leiste unten, die man gerade benutzen will.
        if (!isDnd() && !sichtschutzAktiv() && !viewport.isMobile) {
          toast.message(m.chat_handler_dm_new_message({ senderLabel }), {
            action: {
              label: m.chat_handler_dm_open(),
              onClick: () => {
                void goto(`/app/@me/${channelId}`);
              }
            }
          });
        }
        // OS-level notification when the window is in the background — the
        // toast above is only visible while Pulse is focused. The helper
        // self-gates on background + DND + the onDM toggle. Body stays
        // content-free (sender name only) to match the toast's privacy stance
        // (DMs go E2EE in Phase 2).
        const senderName = cached?.display_name ?? cached?.username ?? null;
        fireInPageNotification({
          kind: 'dm',
          title: senderName ?? m.chat_handler_dm_notification_unknown_sender(),
          body: m.chat_handler_dm_notification_body(),
          channelId: evt.channel_id,
          messageId: evt.message_id,
          guildId: null
        });
        if (!isRecentMention(evt.message_id) && !isDnd()) {
          sounds.play('notification.dm');
        }
      }
    }
  });

  registerWsHandler('postfach_neu', () => {
    postfachAbholenUndAnzeigen((kanalId) => ctx.subs.has(kanalId));
  });

  registerWsHandler('mention_added', (evt) => {
    // Per-user notification fanned out only to mentioned sockets. We
    // intentionally drive the unread-mention badge from THIS event
    // only (not from `message.mentions`) so the counter logic stays
    // idempotent: the backend deduplicates the recipient set, we
    // don't have to. If the user is actively viewing the channel,
    // the inline `markRead` below clears the counter immediately.
    const { channel_id, message_id, guild_id } = evt.data;
    const viewingMentioned = ctx.subs.has(channel_id);
    readState.incMention(channel_id);
    // Record before the matching channel_bump/dm_bump arrives so the
    // generic sound is suppressed.
    markRecentMention(message_id);
    if (viewingMentioned) {
      // Already looking at the channel — clear the counter, no chime
      // (a sound for the focused channel is just noise).
      readState.markRead(channel_id, message_id);
    } else {
      if (!isDnd()) sounds.play('notification.mention', { guildId: guild_id });
    }
    // In-page notification (only fires when tab is in background — the
    // helper gates on visibility + settings). The matching push from the
    // SW collapses on the shared `message_id` tag, so the user sees one
    // popup at most. Look up the message we just received for body text;
    // it may not be in the local store yet if the user has never opened
    // the channel — in that case we fall back to a generic body.
    const msg = messages.for(channel_id).find((m) => m.id === message_id);
    const author = msg ? userCache.get(msg.author_id) ?? null : null;
    const authorName = author?.display_name ?? author?.username ?? m.chat_handler_mention_unknown_author();
    const snippet = msg?.content?.slice(0, 140) ?? m.chat_handler_mention_fallback_body();
    const channelName = (() => {
      if (guild_id) {
        const list = guilds.channelsByGuild[guild_id] ?? [];
        const c = list.find((x) => x.id === channel_id);
        return c?.name ? `#${c.name}` : m.chat_handler_mention_fallback_channel();
      }
      return m.chat_handler_mention_fallback_dm();
    })();
    fireInPageNotification({
      kind: guild_id ? 'mention' : 'dm',
      title: `${authorName} in ${channelName}`,
      body: snippet,
      channelId: channel_id,
      messageId: message_id,
      guildId: guild_id
    });
  });

  registerWsHandler('stream_chat_message', (evt) => {
    streamChat.apply(evt.channel_id, evt.streamer_id, evt.message);
  });

  registerWsHandler('watch_chat_message', (evt) => {
    watchChat.apply(evt.channel_id, evt.party_id, evt.message);
  });

  registerWsHandler('watch_chat_reaction', (evt) => {
    watchChat.applyReaction(evt.data);
  });
}
