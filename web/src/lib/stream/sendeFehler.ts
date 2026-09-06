/**
 * Geteilte Fehlerdeutung fürs Stream-Chat-Senden (Panel + Inline-Input).
 * Das Backend antwortet mit 410, wenn der Streamer offline ist, und mit
 * 429 bei zu schnellem Senden — beide verdienen eine eigene, ruhige Meldung
 * statt des generellen "Senden fehlgeschlagen" (dessen description den
 * rohen Fehlertext zeigt).
 */
import { errText } from '$lib/utils/errText';
import { toast } from 'svelte-sonner';
import { m } from '$lib/paraglide/messages.js';

export function meldeSendeFehler(
  e: unknown,
  texte: { offline: string; tooFast: string; failed: string }
): void {
  const msg = errText(e);
  if (msg.includes('410')) {
    toast.error(texte.offline);
  } else if (msg.includes('429')) {
    toast.warning(texte.tooFast);
  } else {
    toast.error(texte.failed, { description: msg });
  }
}
