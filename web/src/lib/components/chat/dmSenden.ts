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
import { GeraeteIdentitaetGeaendertFehler } from '$lib/krypto/buendelSignatur';
import type { DMChannel, Message } from '$lib/api/types';
import { m } from '$lib/paraglide/messages.js';
import { sendeKlartextDm } from '$lib/components/chat/dmKlartextSenden';
import { vorlaeufigZeigen } from '$lib/components/chat/vorlaeufigVerschluesselt';
import { confirmDialog } from '$lib/components/feedback/confirm.svelte';

interface DmSendeAuftrag {
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
  /** Entscheidung 3.4: genau einmal gerufen (true = der Weg hat das Ergebnis
   *  festgelesen und es war zugestellt; false = fehlgeschlagen). Beim
   *  Gruppen-Weg heisst true „Anzeige ist raus" — ein asynchrones Scheitern
   *  dort meldet sich per Toast, der Composer ist dann schon geleert.
   *  Ohne den Callback verhält sich der Weg wie bisher. */
  melden?: (ok: boolean) => void;
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
    pendingOptimisticTimeouts,
    melden
  } = auftrag;
  if (!userId) return;

  // Private Gruppe: eigener Weg, ohne Klartext-Rueckfall und ohne
  // Gegenstelle (es gibt viele). Antwort-Kennungen werden wie im DM-Weg
  // erst in die kanonische Form uebersetzt — Sender und Empfaenger sehen
  // dieselbe verschluesselte Nachricht unter verschiedenen lokalen IDs.
  if (aktiveGruppe) {
    const gruppenKanal = aktiveGruppe.id;
    // Anhänge fahren seit dem Gruppen-Anhangsweg MIT — verschlüsselt im
    // Megolm-Frame, die Bytes bleiben serverseitig an die Mitglieds-Zustel-
    // lungen gebunden (derselbe sterbliche Weg wie bei DMs).
    const kanonischeId = kanonischeAntwortId(replyToId, visibleMessages);
    // Die Uhr, solange die Sendung läuft (`vorlaeufigVerschluesselt.ts`).
    const vorlaeufig = vorlaeufigZeigen(gruppenKanal, userId, text, kanonischeId, anhaenge);
    void import('$lib/krypto/gruppe/sendenMitAnzeige').then(async ({ gruppeSendenMitAnzeige }) => {
      try {
        const ok = await gruppeSendenMitAnzeige(
          gruppenKanal, text, kanonischeId, anhaenge, vorlaeufig.ersetzen
        );
        melden?.(ok);
      } catch {
        melden?.(false);
      } finally {
        // Ersetzt oder gescheitert — eine übrig gebliebene Kopie muss weg.
        vorlaeufig.entfernen();
      }
    });
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
    // Die Uhr, solange die Sendung läuft (`vorlaeufigVerschluesselt.ts`) —
    // jeder Ausgang unten ersetzt oder entfernt sie.
    const vorlaeufig = vorlaeufigZeigen(cid, userId, text, kanonischeId, anhaenge);
    void import('$lib/krypto/senden').then(async ({ sendeVerschluesselt }) => {
      const senden = () => sendeVerschluesselt(cid, partnerId, text, kanonischeId, anhaenge);
      let ergebnis;
      try {
        try {
          ergebnis = await senden();
        } catch (err) {
          // **TOFU-Bestätigung (Bughunt 2026-09-23):** die Pinnung des Geräts
          // weicht ab — legitimer Grund ist eine echte Neuaufsetzung, und für
          // DIESEN Fall gibt es hier den einzigen Schlüssel zurück: die
          // ausdrückliche Nutzerentscheidung. Abgelehnt oder erneut
          // fehlgeschlagen → derselbe Weg wie jeder andere Fehler unten.
          // Genau EINE Rückfrage pro Sendung — ein Retry, der wieder
          // abweicht, ist ein echter Wechsel während des Sendens und wird
          // nicht ein zweites Mal weggefragt.
          if (!(err instanceof GeraeteIdentitaetGeaendertFehler)) throw err;
          // Haus-Dialog statt nativem confirm(): gleiche Versprechen-Form,
          // aber Pulse-Erscheinungsbild, Esc/Randklick gelten als Ablehnung
          // (eine Vertrauensfrage muss ausdrücklich beantwortet werden).
          const vertrauen = await confirmDialog({
            title: m.dm_tofu_titel(),
            description: m.dm_tofu_identitaet_geaendert_frage({ geraet: err.geraet }),
            confirmLabel: m.direct_trust_accept()
          });
          if (!vertrauen) throw err;
          const { geraetePinnVergessen } = await import('$lib/krypto/geraetePinnung');
          await geraetePinnVergessen(err.geraet);
          ergebnis = await senden();
        }
      } catch (err) {
        vorlaeufig.entfernen();
        melden?.(false);
        // Ein UNERWARTETER Fehler (Bughunt 2026-08-28, zweiter Fund):
        // `sendeVerschluesselt` liefert die BEKANNTEN Faelle (204 =
        // zugestellt, 404 = Route fehlt) regulaer zurueck, nicht per Wurf.
        // Hier steht deshalb nicht fest, ob die Zustellung durch war — ein
        // selbsttaetiger zweiter Anlauf koennte ein Duplikat erzeugen. Also
        // nur sichtbar melden, der Nutzer sendet bei Bedarf erneut.
        // Bughunt Runde 7: der Composer hat Text+Anhänge schon verworfen —
        // den Text wenigstens in die Zwischenablage retten (best-effort),
        // die Wiederherstellung ist dann ein Einfügen statt Neu tippen.
        try {
          if (text) void navigator.clipboard.writeText(text);
        } catch { /* Clipboard verweigert — Toast bleibt die Rückmeldung */ }
        // Menschen lesen diese Meldung: ein unsigniertes Bündel (altes
        // Gerät der Gegenseite) bekommt den Klartext-Rat, nie einen
        // Geräte-Hash (Befund 05.10.).
        const { BuendelUnsigniertFehler } = await import('$lib/krypto/buendelSignatur');
        if (err instanceof BuendelUnsigniertFehler) {
          toast.error(m.dm_senden_altgeraet());
          return;
        }
        toast.error(m.dm_page_send_failed(), { description: (err as Error).message });
        return;
      }
      if (ergebnis?.art === 'verschluesselt') {
        vorlaeufig.ersetzen(ergebnis.nachricht);
        melden?.(true);
        return;
      }
      vorlaeufig.entfernen();
      // NICHTS eingeliefert (kein Zielgeraet auf einer der beiden Seiten,
      // oder der Server hat jeden Empfaenger uebersprungen). Frueher ging
      // die Nachricht hier im Klartext hinaus; seit Spec §3a gibt es diesen
      // Weg nicht mehr. Seit der Aufhebung der Koexistenz-Regel (2026-09-12)
      // ist das der Restfall: ein Konto ueberhaupt ohne Geraet mit
      // Schluesseln (nie angemeldet, oder alles verfallen).
      melden?.(false);
      toast.error(m.dm_page_send_failed(), { description: m.dm_page_senden_kein_geraet() });
    });
    return;
  }

  melden?.(true);
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
