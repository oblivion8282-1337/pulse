/**
 * Der Verlauf-Lade-Einstieg eines Ablage-Kanals — herausgelöst aus der
 * Community-Kanal-Seite, damit sie nicht weiter wächst (dieselbe
 * Begründung wie bei `ablageKanalSenden.ts`). Übernimmt das Muster der
 * privaten Gruppe aus `dmKanalWechsel.svelte.ts`: der Server hat den
 * Klartext eines Ablage-Kanals nie gesehen (Spec §9, B1) — der lokale
 * Bestand IST der Verlauf, kein Rückfall, kein zusätzlicher Serverabruf.
 *
 * `hatServerVerlauf()` kennt Ablage-Kanäle bereits (`verlauf/index.ts`) und
 * hält deshalb den Nachlade-Weg (`verlauf/nachladen.ts`, über
 * `MessageList.svelte`) fern vom Server — hier nur der erste Ladeschritt
 * beim Öffnen.
 */
import { verlaufLesen, verlaufMergen } from '$lib/verlauf';
import { messages } from '$lib/stores/messages.svelte';

export async function ladeAblageKanalVerlauf(kanalId: string): Promise<void> {
  const lokal = await verlaufLesen(kanalId, { anzahl: 50 });
  messages.setInitial(kanalId, verlaufMergen(lokal, []));
}
