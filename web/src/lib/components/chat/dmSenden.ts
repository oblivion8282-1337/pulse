/**
 * Der Sende-Einstieg eines Cloud-Gespraechs (DM oder private Gruppe) —
 * herausgeloest aus `routes/app/@me/[[dmChannelId]]/+page.svelte`, damit die
 * Seite unter der harten Groessen-Grenze bleibt. Reine Weiterleitung, kein
 * Verhalten geaendert: dieselben drei Zweige (Gruppe / verschluesselte DM /
 * Klartext-DM), dieselben Meldungen.
 */
import { toast } from 'svelte-sonner';

import type { AnhangAngabe } from '$lib/krypto/nachrichtNutzlast';
import { kanonischeAntwortId } from '$lib/krypto/kanonischeAntwortId';
import type { DMChannel, Message } from '$lib/api/types';
import { m } from '$lib/paraglide/messages.js';
import { messages } from '$lib/stores/messages.svelte';
import { sendeKlartextDm } from '$lib/components/chat/dmKlartextSenden';

export interface DmSendeAuftrag {
  userId: string | null;
  aktiveGruppe: { id: string } | undefined;
  activeDM: DMChannel | undefined;
  visibleMessages: Message[];
  text: string;
  replyToId: string | null;
  attachmentIds: string[];
  anhaenge: AnhangAngabe[];
  e2eDmsEnabled: boolean;
  cloudRoute: { serverId?: string };
  pendingOptimisticTimeouts: Map<string, ReturnType<typeof setTimeout>>;
}

export function sendeDmNachricht(auftrag: DmSendeAuftrag): void {
  const {
    userId,
    aktiveGruppe,
    activeDM,
    visibleMessages,
    text,
    replyToId,
    attachmentIds,
    anhaenge,
    e2eDmsEnabled,
    cloudRoute,
    pendingOptimisticTimeouts
  } = auftrag;
  if (!userId) return;

  // Private Gruppe: eigener Weg, ohne Klartext-Rueckfall und ohne
  // Gegenstelle (es gibt viele). Antwort-Kennungen werden wie im DM-Weg
  // erst in die kanonische Form uebersetzt — Sender und Empfaenger sehen
  // dieselbe verschluesselte Nachricht unter verschiedenen lokalen IDs.
  if (aktiveGruppe) {
    const gruppenKanal = aktiveGruppe.id;
    if (attachmentIds.length > 0 || anhaenge.length > 0) {
      toast.error(m.gruppe_senden_ohne_anhaenge());
      return;
    }
    const kanonischeId = kanonischeAntwortId(replyToId, visibleMessages);
    void import('$lib/krypto/gruppe/sendenMitAnzeige').then(({ gruppeSendenMitAnzeige }) =>
      gruppeSendenMitAnzeige(gruppenKanal, text, kanonischeId)
    );
    return;
  }

  if (!activeDM) return;
  // Kanal und Gegenstelle JETZT festhalten und weiterreichen: der
  // verschluesselte Weg unten wartet auf einen dynamischen Import und
  // mehrere Netzwerk-Aufrufe, und bis dahin kann der Nutzer laengst in einem
  // anderen Gespraech sein — `activeDM` zeigte dann woanders hin.
  const cid = activeDM.id;
  const partnerId = activeDM.other_user_id;

  // Verschluesselter Weg (Etappe D2, Schalter aus per Vorgabe). Antworten
  // (Kennung in der Nutzlast, s. `nachrichtNutzlast.ts`) UND Anhaenge
  // (Etappe E, Dateischluessel ebendort) fahren mit.
  // **Bei eingeschaltetem Schalter ist das der EINZIGE Weg** (Spec §3a):
  // der Klartext-Rueckfall, der hier bis zum 2026-08-29 stand, ist weg.
  // Bei ausgeschaltetem Schalter gilt weiter der Klartext-Weg unten.
  if (e2eDmsEnabled) {
    // `replyToId` ist bislang nur die LOKALE ID des Ziels (wie der
    // Antwortende es gerade sieht) — Sender und Empfaenger derselben
    // verschluesselten Nachricht haben dafuer verschiedene lokale IDs, s.
    // `krypto/kanonischeAntwortId.ts`. Erst uebersetzen, dann senden.
    const kanonischeId = kanonischeAntwortId(replyToId, visibleMessages);
    void import('$lib/krypto/senden').then(async ({ sendeVerschluesselt }) => {
      let ergebnis;
      try {
        ergebnis = await sendeVerschluesselt(cid, partnerId, text, kanonischeId, anhaenge);
      } catch (err) {
        // Ein UNERWARTETER Fehler (Bughunt 2026-08-28, zweiter Fund):
        // `sendeVerschluesselt` liefert die BEKANNTEN Faelle (204 =
        // zugestellt, 404 = Route fehlt) regulaer zurueck, nicht per Wurf.
        // Hier steht deshalb nicht fest, ob die Zustellung durch war — ein
        // selbsttaetiger zweiter Anlauf koennte ein Duplikat erzeugen. Also
        // nur sichtbar melden, der Nutzer sendet bei Bedarf erneut.
        toast.error(m.dm_page_send_failed(), { description: (err as Error).message });
        return;
      }
      if (ergebnis?.art === 'verschluesselt') {
        messages.upsert(ergebnis.nachricht);
        return;
      }
      // NICHTS eingeliefert (kein Zielgeraet auf einer der beiden Seiten,
      // oder der Server hat jeden Empfaenger uebersprungen). Frueher ging
      // die Nachricht hier im Klartext hinaus; seit Spec §3a gibt es diesen
      // Weg nicht mehr. Den Regelfall („Gegenseite ohne App") faengt schon
      // die Sperre am Eingabefeld ab — hier bleibt der Rest: eigenes Geraet
      // noch ohne Schluessel, oder der Stand war beim Tippen unbekannt.
      toast.error(m.dm_page_send_failed(), { description: m.dm_page_senden_kein_geraet() });
    });
    return;
  }

  sendeKlartextDm({
    cid,
    text,
    autorId: userId,
    replyToId,
    attachmentIds,
    route: cloudRoute,
    zeitgeber: pendingOptimisticTimeouts
  });
}
