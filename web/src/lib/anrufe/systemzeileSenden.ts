/**
 * Die Anruf-Systemzeile als GEMEINSAME Nachricht (Anrufe-Epic B): nach dem
 * Ende trägt der Einleiter-Client „Anruf verpasst“ / „Anruf abgelehnt“ /
 * „Anruf · Dauer“ in den Kanal ein — als ganz normale Nachricht, ohne eigenen
 * Endpunkt. Ob und was geschrieben wird, entscheidet `systemzeileKern.ts`;
 * diese Datei ist nur der Weg.
 *
 * Sie wird vom WS-Bootstrap (`ws/handlers/anrufe.ts`) über
 * `anrufe.zeilenZielSetzen` angedockt — bewusst Injektion statt Import im
 * Store: die Sendekette zieht den halben WS-/Krypto-Stack nach sich, der
 * Store liefe in einen Zyklus. Ob die Nachricht verschlüsselt hinausgeht,
 * entscheidet allein `E2E_DMS_ENABLED` — derselbe Schalter wie beim Composer
 * (`chat/dmSenden.ts`), damit Zeile und getippte Nachrichten denselben Weg
 * nehmen.
 *
 * Eine verpasste Zustellung wird still ignoriert: die Zeile dokumentiert nur,
 * sie darf nach dem Auflegen keinen Fehler-Toast werfen und kein Duplikat-
 * Risiko durch einen zweiten Anlauf eingehen.
 */
import { m } from '$lib/paraglide/messages.js';
import { formatiereDauer } from '$lib/attachments/aufnahmeKern';
import { directMessages } from '$lib/stores/directMessages.svelte';
import { auth } from '$lib/stores/auth.svelte';
import { messages } from '$lib/stores/messages.svelte';
import { serversStore } from '$lib/api/servers.svelte';
import { E2E_DMS_ENABLED } from '$lib/krypto/schalter';
import type { AnrufZeilenSchluessel } from './systemzeileKern';

export function sendeAnrufSystemzeile(
  kanalId: string,
  schluessel: AnrufZeilenSchluessel,
  dauerSek: number
): void {
  const dm = directMessages.byId[kanalId];
  if (!dm || !auth.user) return; // kein DM-Gespräch mehr / abgemeldet — nichts zu dokumentieren
  const autorId = auth.user.id;
  const text =
    schluessel === 'verpasst'
      ? m.anruf_zeile_verpasst()
      : schluessel === 'abgelehnt'
        ? m.anruf_zeile_abgelehnt()
        : m.anruf_zeile_dauer({ dauer: formatiereDauer(dauerSek) });

  if (E2E_DMS_ENABLED) {
    // Der verschlüsselte Sendeweg — dynamisch importiert, s. Modulkopf.
    // `unverschluesselt` (Gegenseite ohne App-Gerät) bleibt aus: dieselbe
    // Koexistenz-Regel wie beim Composer, dessen Sperre diesen Fall vorher
    // abfängt.
    void import('$lib/krypto/senden').then(async ({ sendeVerschluesselt }) => {
      try {
        const ergebnis = await sendeVerschluesselt(kanalId, dm.other_user_id, text);
        if (ergebnis?.art === 'verschluesselt') messages.upsert(ergebnis.nachricht);
      } catch {
        // Nur Dokumentation — still, s. Modulkopf.
      }
    });
    return;
  }

  // Klartext-Weg (Schalter aus): derselbe Pfad wie der Composer —
  // optimistisch plus WS-Schnellweg. Der Zeitgeber ist eine Wegwerf-Map, ihr
  // einziges Zeitlimit (10 s) räumt sich selbst ab.
  void import('$lib/components/chat/dmKlartextSenden').then(({ sendeKlartextDm }) => {
    sendeKlartextDm({
      cid: kanalId,
      text,
      autorId,
      replyToId: null,
      attachmentIds: [],
      route: { serverId: serversStore.cloudId() },
      zeitgeber: new Map()
    });
  });
}
