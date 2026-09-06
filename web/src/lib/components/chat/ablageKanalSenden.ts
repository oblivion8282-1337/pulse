/**
 * Der Sende-Einstieg eines Ablage-Kanals — herausgelöst aus der
 * Community-Kanal-Seite, damit sie nicht weiter wächst (dieselbe
 * Begründung wie bei `chat/dmSenden.ts` für die DM-Seite). Dynamischer
 * Import hält den Krypto-Kern (WASM) aus dem Seitenaufbau heraus, wie
 * überall sonst im Krypto-Weg auch.
 *
 * **Kein Klartext-Rückfall** (`kanalSenden.ts`-Modulkopf: der Server nimmt
 * für Ablage-Kanäle auf KEINEM Weg Klartext an). Ein Fehlschlag muss
 * deshalb sichtbar werden — `kanalSendenMitAnzeige` übernimmt das per
 * Toast; hier nur der Anhang-Riegel VOR dem Import, aus demselben Grund
 * wie beim privaten-Gruppen-Weg (`chat/dmSenden.ts`): Anhänge gibt es für
 * diesen Weg noch nicht (`kanalSenden.ts` nimmt nur Klartext + Antwort-Id
 * entgegen).
 */
import { toast } from 'svelte-sonner';
import { m } from '$lib/paraglide/messages.js';

export function sendeAblageKanalNachricht(
  guildId: string,
  kanalId: string,
  text: string,
  replyToId: string | null,
  attachmentIds: string[]
): void {
  if (attachmentIds.length > 0) {
    toast.error(m.ablage_kanal_senden_ohne_anhaenge());
    return;
  }
  void import('$lib/krypto/gruppe/kanalSendenMitAnzeige').then(({ kanalSendenMitAnzeige }) =>
    kanalSendenMitAnzeige(guildId, kanalId, text, replyToId)
  );
}
