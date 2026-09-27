/**
 * OS-Benachrichtigung „jemand nimmt deinen Stream auf".
 *
 * Eigenes Modul, weil die Entscheidung darueber hier steht und nicht im
 * Handler: gemeldet wird nur, wenn das Fenster OHNE Fokus ist ( dieselbe
 * Focus-Gate-Konvention wie `$lib/notifications/inPage.ts`), und der NAME
 * des Zuschauers kommt aus dem Nutzer-Cache — der Handler kennt nur IDs.
 */

import { m } from '$lib/paraglide/messages.js';
import { userCache } from '$lib/stores/users.svelte';

/** Start/Clip als System-Meldung — nur im Hintergrund (Fenster ohne Fokus),
 *  nur in der Desktop-App (Browser: der Chip in der Leiste ist genug). */
export function streamRecordOsMeldung(
  fromUserId: string,
  clip: boolean,
  channelId: string,
): void {
  const imHintergrund =
    typeof document !== 'undefined' &&
    (document.visibilityState === 'hidden' || !document.hasFocus());
  if (!imHintergrund) return;
  const api = (
    window as unknown as {
      pulse?: { notify?: { show?: (x: Record<string, unknown>) => Promise<void> } };
    }
  ).pulse?.notify;
  if (!api?.show) return;
  const name = userCache.displayName(fromUserId, `user-${fromUserId}`);
  void api
    .show({
      title: clip ? m.record_notice_clip_title() : m.record_notice_start_title(),
      body: clip
        ? m.record_notice_clip_body({ name })
        : m.record_notice_start_body({ name }),
      channel_id: channelId,
      message_id: `record-${Date.now()}`,
    })
    .catch(() => undefined);
}
