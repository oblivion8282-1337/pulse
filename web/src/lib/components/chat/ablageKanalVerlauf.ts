/**
 * Der Verlauf-Lade-Einstieg eines Ablage-Kanals — herausgelöst aus der
 * Community-Kanal-Seite, damit sie nicht weiter wächst (dieselbe
 * Begründung wie bei `ablageKanalSenden.ts`). Übernimmt das Muster der
 * privaten Gruppe aus `dmKanalWechsel.svelte.ts`: der Server hat den
 * Klartext eines Ablage-Kanals nie gesehen (Spec §9, B1) — der lokale
 * Bestand IST der massgebliche Zwischenstand, kein Rückfall auf den Server.
 *
 * **Zweite Quelle seit dem 2026-09-01: das Laufwerk selbst**
 * (`ablage/kanalLeseweg.ts::kanalVerlaufLesen`) — die einzige Stelle, an der
 * ein Mitglied ohne lokalen Bestand (frisches Gerät, gerade erst der
 * Zustellung des Ablage-Hauptschlüssels beigetreten) trotzdem den Verlauf zu
 * sehen bekommt. `kanalVerlaufLesen` ist fail-closed (`null`, wenn dieses
 * Gerät den Hauptschlüssel/die Freigabe-Adresse noch nicht kennt) — genau wie
 * ein Netzfehler wird das hier als „nichts vom Laufwerk" behandelt, nie als
 * geworfene Ausnahme: das Öffnen eines Kanals darf nicht daran scheitern,
 * dass ein fremdes Laufwerk gerade nicht erreichbar ist.
 *
 * **Dritte Quelle, seit Task 8 die BEVORZUGTE: der Server-Ordner selbst**
 * (`ablage/kanalOrdnerLeseweg.ts::kanalOrdnerVerlaufLesen`) — liest die vom
 * Server abgelegten Umschlag-Dateien direkt (`api/ablageKanalOrdner.ts`),
 * ohne Umweg über das Nextcloud-Laufwerk des Erstellers. `null` heißt dort
 * „kein Ordner-Kanal"; erst dann greift der ältere Laufwerksweg oben.
 *
 * `hatServerVerlauf()` kennt Ablage-Kanäle bereits (`verlauf/index.ts`) und
 * hält deshalb den Nachlade-Weg (`verlauf/nachladen.ts`, über
 * `MessageList.svelte`) fern vom Server — hier nur der erste Ladeschritt
 * beim Öffnen.
 */
import { verlaufLesen, verlaufMergen } from '$lib/verlauf';
import { messages } from '$lib/stores/messages.svelte';
import { kanalVerlaufLesen } from '$lib/ablage/kanalLeseweg.ts';
import { kanalOrdnerVerlaufLesen } from '$lib/ablage/kanalOrdnerLeseweg.ts';
import { kanalSchluesselNachliefern } from '$lib/krypto/gruppe/kanalSchluesselNachliefern.ts';
import type { AblageNachricht } from '$lib/ablage/nutzlast.ts';
import type { Message } from '$lib/api/types';

/** Übersetzt eine Bestand-Nachricht aus dem Laufwerk in die Wire-Form, die
 *  der Merge (`verlaufMergen`) und die Anzeige (`MessageList.svelte`) kennen.
 *  `verschluesselt: true` wie bei jeder anderen Nachricht dieses Kanals
 *  (`kanalSenden.ts`/`zustellungOeffnen.ts`) — dieselbe Markierung, derselbe
 *  Grund. Anhänge kommen ohne Abruf-Adresse (`nutzlast.ts`-Modulkopf: bewusst
 *  nicht im Schema) — `url: ''`, dieselbe Lücke wie bei jedem anderen
 *  verschlüsselten Anhang, s. `Attachment.url` in `api/types.ts`. */
function ausAblageNachricht(kanalId: string, n: AblageNachricht): Message {
  return {
    id: n.id,
    channel_id: kanalId,
    author_id: n.autor,
    content: n.inhalt,
    nonce: null,
    reply_to_id: n.antwortAuf,
    created_at: n.zeit,
    edited_at: n.bearbeitet,
    verschluesselt: true,
    attachments: n.anhaenge.map((a) => ({
      id: a.id,
      filename: a.name,
      mime: a.mime,
      size: a.groesse,
      url: ''
    }))
  };
}

export async function ladeAblageKanalVerlauf(kanalId: string): Promise<void> {
  const lokal = await verlaufLesen(kanalId, { anzahl: 50 });
  const ausOrdner = await kanalOrdnerVerlaufLesen(kanalId).catch(() => null);
  let ausLaufwerk: Message[];
  if (ausOrdner !== null) {
    ausLaufwerk = ausOrdner;
  } else {
    const vomLaufwerk = await kanalVerlaufLesen(kanalId).catch(() => null);
    ausLaufwerk = vomLaufwerk
      ? vomLaufwerk.nachrichten.map((n) => ausAblageNachricht(kanalId, n))
      : [];
  }
  messages.setInitial(kanalId, verlaufMergen(lokal, ausLaufwerk));

  // Erst NACH dem Lesen, nie darin: `kanalOrdnerVerlaufLesen` haelt oben
  // bereits die Kontosperre (`mitKontosperre`, intern in
  // `kanalOrdnerLeseweg.ts`), und Web Locks sind nicht wiedereintrittsfaehig
  // — ein Aufruf hier waehrend des Lesens wuerde den Tab blockieren, nicht
  // nur diese Nachlieferung. Best-effort: die Schluessel-Uebergabe darf den
  // Verlaufsweg nie stoeren (Aufgabe 10).
  void kanalSchluesselNachliefern(kanalId).catch(() => {});
}
