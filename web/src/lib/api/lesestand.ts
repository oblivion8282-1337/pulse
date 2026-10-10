/**
 * Serverseitiger Lesefortschritt (Übergabe P0.2) — für DMs UND private
 * Gruppen, aus derselben Quelle (`readState.markRead`).
 *
 * `markRead` läuft bei jedem Kanal-Öffnen — ein REST-Aufruf pro Aufruf
 * wäre Geplänkel. Der Reporter entprellt je Kanal (1,5 s): Wer eine DM
 * öffnet, schickt EINEN Stand, nicht einen je Nachricht. Fire-and-forget:
 * der lokale Stand ist bereits korrekt, der Server-Lauf ist nur die
 * geräteübergreifende Spiegelung; ein Fehlschlag ist der nächste
 * markRead-Ruf gleich wieder los.
 *
 * **Die Kanalart entscheidet die Adresse** (Befund 2026-10-10): bis dahin
 * ging JEDER Stand an `/dm-channels/{id}/lesestand` — eine Gruppe landete
 * dort im 404, ihre Leser meldeten also nur beim Öffnen (eigener Aufruf),
 * nie während sie drin waren; und jeder Community-Kanal schickte einen
 * sinnlosen Aufruf hinterher. Community-Kanäle haben keinen Server-Stand.
 *
 * Die Verkabelung mit `readState` geschieht über `installiereLesestandSync`
 * (einmalig beim App-Start, `routes/app/+layout.svelte`) — der Store selbst
 * importiert bewusst keine API, um den Importkegel schmal zu halten.
 */
import { request } from './client';
import { serversStore } from './servers.svelte';
import { gruppenLesestandSetzen } from './gruppen';
import { readState } from '$lib/stores/readState.svelte';
import { directMessages } from '$lib/stores/directMessages.svelte';
import { privateGruppen } from '$lib/stores/privateGruppen.svelte';

const NACHLAUF_MS = 1500;

const schwebend = new Map<string, ReturnType<typeof setTimeout>>();

function senden(channelId: string, messageId: string): Promise<void> {
  if (privateGruppen.istGruppe(channelId)) return gruppenLesestandSetzen(channelId, messageId);
  return request<void>(
    `/dm-channels/${encodeURIComponent(channelId)}/lesestand`,
    // Bewusst als STRING: 19-stellige lokale E2EE-IDs sprengen den
    // sicheren Number-Bereich, Number() würde still runden (P0.2-Bug).
    { method: 'PUT', body: { last_read_message_id: messageId } },
    // DMs sind cloud-only (Muster wie gruppen.ts) — der Aufruf muss
    // an den Cloud-Server geroutet werden, nicht an den aktiven.
    { serverId: serversStore.cloudId() }
  );
}

function melden(channelId: string, messageId: string): void {
  if (!directMessages.byId[channelId] && !privateGruppen.istGruppe(channelId)) return;
  const bestehend = schwebend.get(channelId);
  if (bestehend) clearTimeout(bestehend);
  schwebend.set(
    channelId,
    setTimeout(() => {
      schwebend.delete(channelId);
      void senden(channelId, messageId).catch(() => {
        // Netz-/Auth-Fehler: still verwerfen — der nächste markRead bzw. das
        // nächste Öffnen (`lesestandErneutMelden`) versucht es erneut; der
        // lokale Stand bleibt unangetastet korrekt.
      });
    }, NACHLAUF_MS)
  );
}

/** Den geltenden eigenen Stand erneut melden, auch ohne Fortschritt — beim
 *  Öffnen eines Gesprächs. `markRead` meldet nur, wenn er vorrückt; eine
 *  zuvor verlorene Meldung käme sonst erst mit der nächsten Nachricht. */
export function lesestandErneutMelden(channelId: string): void {
  const stand = readState.lastReadByChannel[channelId];
  if (stand) melden(channelId, stand);
}

/** Verbindet `readState.markRead` mit dem Server-PUT (einmalig aufrufen). */
export function installiereLesestandSync(): void {
  readState.setServerSync(melden);
}
