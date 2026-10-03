/**
 * Serverseitiger Lesefortschritt (Übergabe P0.2).
 *
 * `markRead` läuft bei jedem Kanal-Öffnen — ein REST-Aufruf pro Aufruf
 * wäre Geplänkel. Der Reporter entprellt je Kanal (1,5 s): Wer eine DM
 * öffnet, schickt EINEN Stand, nicht einen je Nachricht. Fire-and-forget:
 * der lokale Stand ist bereits korrekt, der Server-Lauf ist nur die
 * geräteübergreifende Spiegelung; ein Fehlschlag ist der nächste
 * markRead-Ruf gleich wieder los.
 *
 * Die Verkabelung mit `readState` geschieht über `installiereLesestandSync`
 * (einmalig beim App-Start, `routes/app/+layout.svelte`) — der Store selbst
 * importiert bewusst keine API, um den Importkegel schmal zu halten.
 */
import { request } from './client';
import { serversStore } from './servers.svelte';
import { readState } from '$lib/stores/readState.svelte';

const NACHLAUF_MS = 1500;

const schwebend = new Map<string, ReturnType<typeof setTimeout>>();

function melden(channelId: string, messageId: string): void {
  const bestehend = schwebend.get(channelId);
  if (bestehend) clearTimeout(bestehend);
  schwebend.set(
    channelId,
    setTimeout(() => {
      schwebend.delete(channelId);
      void request(
        `/dm-channels/${encodeURIComponent(channelId)}/lesestand`,
        // Bewusst als STRING: 19-stellige lokale E2EE-IDs sprengen den
        // sicheren Number-Bereich, Number() würde still runden (P0.2-Bug).
        { method: 'PUT', body: { last_read_message_id: messageId } },
        // DMs sind cloud-only (Muster wie gruppen.ts) — der Aufruf muss
        // an den Cloud-Server geroutet werden, nicht an den aktiven.
        { serverId: serversStore.cloudId() }
      ).catch(() => {
        // Netz-/Auth-Fehler: still verwerfen — der nächste markRead versucht
        // es erneut; der lokale Stand bleibt unangetastet korrekt.
      });
    }, NACHLAUF_MS)
  );
}

/** Verbindet `readState.markRead` mit dem Server-PUT (einmalig aufrufen). */
export function installiereLesestandSync(): void {
  readState.setServerSync(melden);
}
