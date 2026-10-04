/**
 * Bearbeiten, Loeschen und Reagieren im Cloud-Gespraech — herausgeloest aus
 * `routes/app/@me/[[dmChannelId]]/+page.svelte`, als diese mit dem
 * Gruppen-Zweig (Etappe G) ueber die harte Groessen-Grenze gewachsen waere.
 *
 * Der Umzug aendert kein Verhalten: dieselben Routen, dieselbe Cloud-
 * Skopierung, dieselben Fehlermeldungen. Die drei Aufrufe gelten fuer DMs und
 * private Gruppen gleichermassen — sie sprechen den Kanal ueber die
 * Nachrichten-ID an, nicht ueber die Kanalart.
 *
 * **Was fuer eine verschluesselte Nachricht davon wirkt, entscheidet der
 * Server, nicht diese Datei** — mit den Aktions-Umschlaegen (Loesch-Frame,
 * Reaktions-Umschlag, Bearbeitungs-Umschlag), die bei verschluesselten DMs
 * UND verschluesselten privaten Gruppen über das Postfach an die Geraete
 * laufen: bei einer DM per Olm-Paarung an die Gegenstelle, in einer Gruppe
 * per Megolm durch den Gruppen-Sendeweg (`gruppe/frameSenden.ts`) an alle
 * Mitglieder-Geraete. Der Aufrufer sagt ueber `opts` (`partnerId` bzw.
 * `gruppe`), welcher Weg es ist.
 */
import { toast } from 'svelte-sonner';

import { chatApi } from '$lib/api/chat';
import { ApiError } from '$lib/api/client';
import { confirmDialog } from '$lib/components/feedback/confirm.svelte';
import { m } from '$lib/paraglide/messages.js';
import { auth } from '$lib/stores/auth.svelte';
import { messages } from '$lib/stores/messages.svelte';
import {
  verlaufBearbeitungAnwenden,
  verlaufNachrichtGeloescht,
  verlaufReaktionAnwenden
} from '$lib/verlauf';
import { kanonischeAntwortId } from '$lib/krypto/kanonischeAntwortId';
import { sendeBearbeitung, sendeLoeschung, sendeReaktion } from '$lib/krypto/senden';
import {
  sendeGruppenBearbeitung,
  sendeGruppenLoeschung,
  sendeGruppenReaktion
} from '$lib/krypto/gruppe/frameSenden';
import type { Message } from '$lib/api/types';

type Route = { serverId?: string };

export async function nachrichtBearbeiten(
  msg: Message,
  content: string,
  route: Route,
  /** Verschluesseltes Gespraech: `gruppe` waehlt den Gruppen-Umschlag (Megolm
   *  an alle Mitglieder-Geraete), `partnerId` den DM-Umschlag (Olm-Paarung).
   *  Fehlt beides (unverschluesselter Kontext), laeuft der Server-Weg. */
  opts: { partnerId?: string; gruppe?: boolean } = {}
): Promise<void> {
  if (msg.verschluesselt && (opts.partnerId || opts.gruppe)) {
    // E2EE: keine Server-Zeile — die Bearbeitung reist als Umschlag an alle
    // Zielgeräte. Ziel in KANONISCHER Form.
    const ziel = kanonischeAntwortId(msg.id, [msg]) ?? msg.id;
    try {
      const zugestellt = opts.gruppe
        ? await sendeGruppenBearbeitung(msg.channel_id, ziel, content)
        : await sendeBearbeitung(msg.channel_id, opts.partnerId as string, ziel, content);
      if (!zugestellt) throw new Error('Bearbeitungs-Umschlag nicht zugestellt');
      // Lokal nachziehen — "ERST NACH der Zustellung": der Frame kehrt zum
      // sendenden Geraet nicht zurueck (das eigene aktuelle Geraet bleibt
      // bewusst Empfaenger aussen), und ein WS-Echo wie beim Klartext-Weg
      // existiert hier nicht.
      const bearbeitetAm = new Date().toISOString();
      if (await verlaufBearbeitungAnwenden(msg.channel_id, msg.id, content, bearbeitetAm)) {
        messages.bearbeiteInhalt(msg.channel_id, msg.id, content, bearbeitetAm);
      }
    } catch (e) {
      toast.error(m.dm_page_edit_failed());
      console.error(e);
    }
    return;
  }
  try {
    await chatApi.editMessage(msg.id, content, {}, route);
  } catch (e) {
    toast.error(m.dm_page_edit_failed());
    console.error(e);
  }
}

export async function nachrichtLoeschen(
  msg: Message,
  route: Route,
  /** Verschluesseltes Gespraech, s. `nachrichtBearbeiten`. Fehlt beides
   *  (private Gruppe ohne Krypto oder alter Kontext), bleibt die Loeschung
   *  geraetelokal bzw. beim Server-Weg. */
  opts: { partnerId?: string; gruppe?: boolean } = {}
): Promise<void> {
  const ok = await confirmDialog({
    description: m.dm_page_delete_confirm(),
    destructive: true
  });
  if (!ok) return;
  // Der Loesch-Frame je nach Gespraechsart: Gruppe -> Gruppen-Sendeweg
  // (Megolm an alle Mitglieder-Geraete), DM -> Olm-Paarung an die
  // Gegenstelle. `null` = es gibt keinen Frame-Weg (lokal genug).
  const loeschFrame = opts.gruppe
    ? () => sendeGruppenLoeschung(msg.channel_id, msg.id)
    : opts.partnerId
      ? () => sendeLoeschung(msg.channel_id, opts.partnerId as string, msg.id)
      : null;
  const frameWeg = async (): Promise<void> => {
    if (!loeschFrame) return;
    try {
      await loeschFrame();
    } catch (e) {
      toast.error(m.dm_page_delete_failed());
      console.error(e);
    }
  };
  if (msg.verschluesselt) {
    // E2EE: keine Server-Zeile — der Grabstein läuft lokal (Verlauf +
    // Sicherungs-Archiv) und der Lösch-Frame an die anderen Geräte über den
    // verschlüsselten Sendeweg. Schlägt das Senden fehl, ist die lokale
    // Löschung trotzdem gültig; der Fehler wird sichtbar gemacht.
    verlaufNachrichtGeloescht(msg.channel_id, msg.id);
    messages.remove(msg.channel_id, msg.id);
    await frameWeg();
    return;
  }
  // Eine ID jenseits von int64 kann in keiner Server-Zeile liegen (Postgres-
  // BIGINT sprengt sie, der Versuch endet in einem 500) — direkt der E2E-Weg.
  const ueberInt64 = (() => {
    try {
      return BigInt(msg.id) > BigInt('9223372036854775807');
    } catch {
      return false;
    }
  })();
  if (ueberInt64) {
    verlaufNachrichtGeloescht(msg.channel_id, msg.id);
    messages.remove(msg.channel_id, msg.id);
    await frameWeg();
    return;
  }

  try {
    await chatApi.deleteMessage(msg.id, route);
  } catch (e) {
    // Selbstheilung für Altsätze (2026-09-02): eine verschlüsselte Nachricht
    // ohne überlebten Marker antwortet hier mit 404 — der Beweis, dass es
    // keine Server-Zeile gibt. Dann greift derselbe E2E-Weg wie oben; ein
    // 404 für eine echte Klartext-Zeile heißt "schon weg" und verträgt den
    // lokalen Grabstein ebenfalls.
    if (e instanceof ApiError && e.status === 404 && loeschFrame) {
      verlaufNachrichtGeloescht(msg.channel_id, msg.id);
      messages.remove(msg.channel_id, msg.id);
      await frameWeg();
      return;
    }
    toast.error(m.dm_page_delete_failed());
    console.error(e);
  }
}

export async function reaktionUmschalten(
  msg: Message,
  emoji: string,
  currentlyMine: boolean,
  route: Route,
  /** Verschluesseltes Gespraech, s. `nachrichtBearbeiten`. Fehlt beides
   *  (private Gruppe ohne Krypto), laeuft der Server-Weg. */
  opts: { partnerId?: string; gruppe?: boolean } = {}
): Promise<void> {
  if (msg.verschluesselt && (opts.partnerId || opts.gruppe)) {
    // E2EE: keine Server-Zeile — die Reaktion reist als Umschlag an alle
    // Zielgeräte (auch die eigenen) und wird ERST NACH der Zustellung lokal
    // angewendet, wie der Klartext-Weg auf sein WS-Echo wartet. Ziel in
    // KANONISCHER Form, s. `kanonischeAntwortId.ts`.
    const eigeneUserId = auth.user?.id ?? null;
    if (eigeneUserId === null) return;
    try {
      // kanonischeAntwortId ist typisiert als string | null — der Fallback
      // auf die eigene ID ist der dokumentierte Endpunkt der Kette.
      const ziel = kanonischeAntwortId(msg.id, [msg]) ?? msg.id;
      const zugestellt = opts.gruppe
        ? await sendeGruppenReaktion(msg.channel_id, ziel, emoji, currentlyMine)
        : await sendeReaktion(msg.channel_id, opts.partnerId as string, ziel, emoji, currentlyMine);
      if (!zugestellt) {
        throw new Error('Reaktions-Umschlag nicht zugestellt');
      }
    } catch (e) {
      toast.error(m.dm_page_reaction_failed());
      console.error(e);
      return;
    }
    const reactions = await verlaufReaktionAnwenden(
      msg.channel_id,
      msg.id,
      eigeneUserId,
      emoji,
      currentlyMine
    );
    if (reactions) messages.setReactions(msg.channel_id, msg.id, reactions);
    return;
  }
  const action = currentlyMine ? chatApi.removeReaction : chatApi.addReaction;
  try {
    await action(msg.id, emoji, route);
  } catch (e) {
    toast.error(m.dm_page_reaction_failed());
    console.error(e);
  }
}
