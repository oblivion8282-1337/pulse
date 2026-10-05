/**
 * Einlieferung in den Server-Archiv (Übergabe 2026-10-04, §5): JEDE
 * verschlüsselte Nachricht wird nach erfolgreicher Zustellung zusätzlich
 * verschlüsselt beim Server abgelegt (120 Tage). Fire-and-forget — das
 * Archiv darf die Nachricht nie aufhalten; ein Fehlschlag wird still
 * (console.warn) und der Verlauf bleibt lokal die wahre Kopie.
 *
 * Reihenfolge im Absendeweg: NACH dem `verlaufSpeichernPflicht`, VOR dem
 * Return (`krypto/senden.ts` für DMs, `krypto/gruppe/senden.ts` für
 * private Gruppen — Michaels Entscheidung „Gruppen und Privatchats“,
 * 2026-10-05).
 *
 * Die Wraps für die anderen Teilnehmer reisen JE Sendung mit, aber nur
 * einmal je Sitzung berechnet (`kanalSchluessel.ts`): hatte die Gegenseite
 * beim ersten Senden noch keinen Archiv-Public-Key, richtet ein späteres
 * Senden ihren Zugang nach — ohne Extra-Endpunkt und ohne Existenz-Rückfrage.
 */

import { auth } from '$lib/stores/auth.svelte';
import type { Message } from '$lib/api/types';
import { archivEinliefern, archivPubkeys } from '$lib/api/archiv';
import { erzeugeZufallsId, kanalSchluesselHolen, type ArchivPubkeyZiel } from './kanalSchluessel';
import { verschluessleZeile } from './krypto';
import { baueZeilenKlar } from './zeile';
import { archivPaar } from './konto';

/** Eine laufende Einlieferung je Kanal — zwei schnelle Nachrichten serialisieren. */
const laufend = new Map<string, Promise<void>>();

/**
 * Archiviert eine GESENDETE verschlüsselte DM. Wirft nie.
 */
export function archiviereGesendet(kanalId: string, empfaengerId: string, nachricht: Message): void {
  anstellen(kanalId, async () => {
    // NUR den Partner fragen — die Route erlaubt nur echte DM-Partner,
    // und die eigene Id wäre ihr eigener Partner nie (404, stiller Abbruch).
    const pubkeys = await archivPubkeys([empfaengerId]);
    const fremd = pubkeys[empfaengerId];
    return fremd ? [{ id: empfaengerId, pubkey: fremd }] : [];
  }, nachricht);
}

/**
 * Archiviert eine GESENDETE private Gruppennachricht. Wirft nie.
 * `mitgliederIds` ist die frische Mitgliederliste vom Sendeweg — nur für
 * sie darf der Server Public-Keys herausgeben (Kanal-Skop).
 */
export function archiviereGruppeGesendet(
  kanalId: string,
  mitgliederIds: string[],
  nachricht: Message
): void {
  anstellen(kanalId, async () => {
    const eigeneId = auth.user?.id;
    const andere = mitgliederIds.filter((m) => m !== eigeneId);
    if (andere.length === 0) return [];
    const pubkeys = await archivPubkeys(andere, kanalId);
    return andere.filter((m) => pubkeys[m]).map((m) => ({ id: m, pubkey: pubkeys[m]! }));
  }, nachricht);
}

/** Gemeinsamer Kern: serialisieren, entsperren, Schlüssel + Wraps besorgen,
 *  Zeile verschlüsseln, alles in EINER Anfrage einliefern. Wirft nie. */
function anstellen(
  kanalId: string,
  zieleErmitteln: () => Promise<ArchivPubkeyZiel[]>,
  nachricht: Message
): void {
  const vorher = laufend.get(kanalId) ?? Promise.resolve();
  const lauf = vorher
    .then(async () => {
      const kontoId = auth.user?.id;
      if (!kontoId) return;
      const paar = await archivPaar(kontoId);
      if (!paar) return; // Archiv auf diesem Gerät nicht entsperrt — kein Zwang
      const ziele = await zieleErmitteln();
      const { schluessel, wraps } = await kanalSchluesselHolen(kanalId, paar, ziele);
      await archivEinliefern(
        [
          {
            id: erzeugeZufallsId(),
            channel_id: kanalId,
            nutzlast_b64: bytesZuB64(await verschluessleZeile(schluessel, baueZeilenKlar(nachricht)))
          }
        ],
        wraps
      );
    })
    .catch((e) => console.warn('[archiv] Einlieferung fehlgeschlagen', e))
    .finally(() => {
      if (laufend.get(kanalId) === lauf) laufend.delete(kanalId);
    });
  laufend.set(kanalId, lauf);
}

function bytesZuB64(bytes: Uint8Array): string {
  let binär = '';
  for (const b of bytes) binär += String.fromCharCode(b);
  return btoa(binär);
}
