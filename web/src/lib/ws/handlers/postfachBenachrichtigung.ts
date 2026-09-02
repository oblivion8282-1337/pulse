/**
 * Die Meldung ueber eine neu entschluesselte Nachricht — Toast, In-Page-
 * Benachrichtigung, Ton.
 *
 * Herausgeloest aus `chat.ts`, als der Gruppen-Zweig (Etappe G) diese sonst
 * ueber die Groessen-Policy getrieben haette. Der Umzug aendert kein
 * Verhalten: dieselben Bedingungen (Nicht-Stoeren, Sichtschutz, Handy),
 * dieselbe Reihenfolge, dieselbe Zielroute.
 *
 * **Der Text darf hier stehen, weil er schon entschluesselt ist.** Anders als
 * beim Klartext-`dm_bump`, dessen Rahmen bewusst inhaltslos ist, liegt der
 * Inhalt an dieser Stelle bereits im Klienten vor — er verlaesst das Geraet
 * nicht.
 */
import { goto } from '$app/navigation';
import { toast } from 'svelte-sonner';

import { fireInPageNotification, isDnd } from '$lib/notifications/inPage';
import { m } from '$lib/paraglide/messages.js';
import { sichtschutzAktiv } from '$lib/remote/sichtschutz';
import { sounds } from '$lib/sounds/engine';
import { userCache } from '$lib/stores/users.svelte';
import { viewport } from '$lib/stores/viewport.svelte';
import type { Message } from '$lib/api/types';

export function meldeNeueZustellung(nachricht: Message, gruppenName: string | null): void {
  const cached = userCache.get(nachricht.author_id);
  const senderLabel = cached
    ? m.chat_handler_dm_sender_label({
        sender: '@' + (cached.display_name ?? cached.username)
      })
    : '';
  const snippet = nachricht.content.slice(0, 140);
  // In einer Gruppe sagt „Neue Nachricht von @x" nicht, WO — und der Ort ist
  // dort die eigentliche Auskunft.
  const kopfzeile = gruppenName
    ? m.chat_handler_gruppe_new_message({ gruppe: gruppenName, senderLabel })
    : m.chat_handler_dm_new_message({ senderLabel });
  if (!isDnd() && !sichtschutzAktiv() && !viewport.isMobile) {
    toast.message(kopfzeile, {
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
    // Weiterhin `dm`: die Benachrichtigungs-Art steuert Ziel und Aussehen,
    // und eine private Gruppe fuehrt an denselben Ort (`/app/@me/<id>`). Eine
    // eigene Art einzufuehren, ohne dass sich etwas daran unterscheidet,
    // waere eine Unterscheidung ohne Unterschied.
    kind: 'dm',
    title: gruppenName ?? senderName ?? m.chat_handler_dm_notification_unknown_sender(),
    body:
      snippet ||
      (gruppenName
        ? m.chat_handler_gruppe_notification_body()
        : m.chat_handler_dm_notification_body()),
    channelId: nachricht.channel_id,
    messageId: nachricht.id,
    guildId: null
  });
  if (!isDnd()) sounds.play('notification.dm');
}
