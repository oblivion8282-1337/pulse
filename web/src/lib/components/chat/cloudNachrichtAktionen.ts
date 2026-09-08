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
 * Server, nicht diese Datei** — mit zwei Ausnahmen, die gar nicht erst zum
 * Server gehen: Loeschen (Loesch-Frame, 2026-09-02) und Reagieren
 * (Reaktions-Umschlag, P1.5) laufen bei einer verschluesselten DM ueber das
 * Postfach an die Geraete. Bearbeiten bleibt gesperrt (`MessageList::
 * canEditMessage`); eine verschluesselte Nachricht hat keine Server-Zeile,
 * die Route findet sie nicht, und der Fehler wird angezeigt, nicht
 * verschluckt.
 */
import { toast } from 'svelte-sonner';

import { chatApi } from '$lib/api/chat';
import { ApiError } from '$lib/api/client';
import { confirmDialog } from '$lib/components/feedback/confirm.svelte';
import { m } from '$lib/paraglide/messages.js';
import { auth } from '$lib/stores/auth.svelte';
import { messages } from '$lib/stores/messages.svelte';
import { verlaufNachrichtGeloescht, verlaufReaktionAnwenden } from '$lib/verlauf';
import { kanonischeAntwortId } from '$lib/krypto/kanonischeAntwortId';
import { sendeLoeschung, sendeReaktion } from '$lib/krypto/senden';
import type { Message } from '$lib/api/types';

type Route = { serverId?: string };

export async function nachrichtBearbeiten(
  msg: Message,
  content: string,
  route: Route
): Promise<void> {
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
  /** Nur bei einer verschlüsselten DM: die Gegenstelle, an die der
   *  Lösch-Frame geht. Fehlt sie (private Gruppe), bleibt die Löschung
   *  gerätelokal — ein Gruppen-Fan-out ist ein anderes Bauvorhaben. */
  opts: { partnerId?: string } = {}
): Promise<void> {
  const ok = await confirmDialog({
    description: m.dm_page_delete_confirm(),
    destructive: true
  });
  if (!ok) return;
  if (msg.verschluesselt) {
    // E2EE: keine Server-Zeile — der Grabstein läuft lokal (Verlauf +
    // Sicherungs-Archiv) und der Lösch-Frame an die Gegenseite über den
    // verschlüsselten Sendeweg. Schlägt das Senden fehl, ist die lokale
    // Löschung trotzdem gültig; der Fehler wird sichtbar gemacht.
    verlaufNachrichtGeloescht(msg.channel_id, msg.id);
    messages.remove(msg.channel_id, msg.id);
    if (opts.partnerId) {
      try {
        await sendeLoeschung(msg.channel_id, opts.partnerId, msg.id);
      } catch (e) {
        toast.error(m.dm_page_delete_failed());
        console.error(e);
      }
    }
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
    if (opts.partnerId) {
      try {
        await sendeLoeschung(msg.channel_id, opts.partnerId, msg.id);
      } catch (e) {
        toast.error(m.dm_page_delete_failed());
        console.error(e);
      }
    }
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
    if (e instanceof ApiError && e.status === 404 && opts.partnerId) {
      verlaufNachrichtGeloescht(msg.channel_id, msg.id);
      messages.remove(msg.channel_id, msg.id);
      try {
        await sendeLoeschung(msg.channel_id, opts.partnerId, msg.id);
      } catch (frameErr) {
        toast.error(m.dm_page_delete_failed());
        console.error(frameErr);
      }
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
  /** Nur bei einer verschlüsselten DM: die Gegenstelle für den Reaktions-
   *  Umschlag (P1.5). Fehlt sie (private Gruppe), bleibt der Server-Weg —
   *  und damit für eine verschlüsselte Gruppen-Nachricht der 404, den die
   *  Anzeige ohnehin vorher sperrt (`MessageList::canReactMessage`). */
  opts: { partnerId?: string } = {}
): Promise<void> {
  if (msg.verschluesselt && opts.partnerId) {
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
      if (!(await sendeReaktion(msg.channel_id, opts.partnerId, ziel, emoji, currentlyMine))) {
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
