/**
 * Bloecke ins Postfach einliefern — herausgeloest aus `senden.ts` (Etappe G2,
 * Bughunt 2026-08-28/29, belegter Fehler), als die Datei mit der
 * Wiederherstellungslogik ueber die Groessen-Policy (PLAN.md §12.1)
 * gewachsen waere. Der Umzug selbst aendert kein Verhalten.
 */
import { postfachApi, type PostfachNutzlast } from '../../api/postfach';
import { serversStore } from '../../api/servers.svelte';

function cloudRoute(): { serverId?: string } {
  return { serverId: serversStore.cloudId() };
}

/**
 * Eine einzelne Einlieferung. Gibt die Geraete-Pubkeys zurueck, die der
 * Server uebersprungen hat (unbekanntes Buendel, Kontingent voll) — bei
 * einem koerperlosen 2xx eine leere Liste, denn dann hat er nichts
 * uebersprungen GESAGT, und ohne Gegenbeweis gilt zugestellt (dieselbe
 * Deutung wie `wurdeZugestellt`, s. `../zustellErgebnis.ts`).
 *
 * **Wirft absichtlich weiter.** Der DM-Weg faengt hier einen 404 ab und
 * faellt auf den Klartext zurueck (`../zustellErgebnis.ts`) — fuer eine
 * Gruppe gibt es diesen Weg nicht, ein verschluckter Fehler waere eine
 * Nachricht, die niemand bekommen hat und die niemand vermisst.
 */
export async function einliefernEinmal(
  kanalId: string,
  geraeteKennung: string,
  nutzlasten: PostfachNutzlast[]
): Promise<string[]> {
  const ergebnis = await postfachApi.einliefern(
    { channel_id: kanalId, device_pubkey: geraeteKennung, nutzlasten },
    cloudRoute()
  );
  return ergebnis?.uebersprungene_empfaenger ?? [];
}

/**
 * Liefert mehrere Bloecke NACHEINANDER ein und faengt den Fehlschlag EINES
 * Blocks ab, statt die Schleife abzubrechen. Ohne das riss ein einzelner
 * geworfener Block (z. B. ein Geraet darin, das gerade sein Kanal-Recht
 * verlor) alle NACHFOLGENDEN Bloecke mit — obwohl deren Empfaenger laengst
 * beliefert waren, bevor die Ausnahme den Aufrufer verliess. Der servereigene
 * Fix (`services/chat-gateway/.../routes/postfach.py`) nimmt genau diesen
 * Fall fuer ein entferntes Gruppenmitglied schon vorweg — dieser Wall bleibt
 * trotzdem die zweite Verteidigungslinie fuer jeden ANDEREN Fehlschlag
 * (Netz, ein voller Server, …).
 *
 * Gibt die Geraete zurueck, die TATSAECHLICH beliefert wurden: ein Block
 * zaehlt nur mit, wenn er nicht geworfen hat, und je Geraet nur, wenn der
 * Server es nicht selbst uebersprungen hat. Ein geworfener Block liefert
 * keinem seiner Geraete etwas — sie gelten beim naechsten Senden weiterhin
 * als offen (`nachzuliefern`/`sitzungWaehlen`).
 */
export async function bloeckeEinliefern(
  kanalId: string,
  geraeteKennung: string,
  bloecke: PostfachNutzlast[][]
): Promise<{ beliefert: Set<string>; letzterFehler: unknown }> {
  const beliefert = new Set<string>();
  let letzterFehler: unknown;
  for (const block of bloecke) {
    const geraeteImBlock = block.flatMap((n) => n.empfaenger);
    try {
      const uebersprungeneDesBlocks = await einliefernEinmal(kanalId, geraeteKennung, block);
      for (const g of geraeteImBlock) {
        if (!uebersprungeneDesBlocks.includes(g)) beliefert.add(g);
      }
    } catch (err) {
      letzterFehler = err;
    }
  }
  return { beliefert, letzterFehler };
}
