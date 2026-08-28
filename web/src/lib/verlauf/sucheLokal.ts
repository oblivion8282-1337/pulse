/**
 * Verdrahtung fuer C5 (lokale DM-Suche): IndexedDB lesen, die reine Rechnung
 * aus `sucheTreffer.ts` darauf anwenden, `other_user_id` aus dem DM-Kanal-
 * Store ergaenzen (die importfreie Rechnung darf diesen Store nicht kennen,
 * s. dortigen Modulkopf). Reine Verdrahtung, keine eigene Rechnung — deshalb
 * hier, nicht importfrei (Muster wie `nachladen.ts`).
 *
 * Wirft NIE: ein IndexedDB-Fehler bedeutet fuer die Suche nicht "abbrechen",
 * sondern "nur noch die Server-Haelfte" — `verlaufZustand.melde` macht den
 * Grund sichtbar (dieselbe Anzeige wie beim Lesen des Verlaufs, C2).
 *
 * **Unvollstaendigkeit (Spec §7, „eine lokale Suche ist nur so vollstaendig
 * wie der lokale Verlauf"):** fuer eine VERSCHLUESSELTE Nachricht gibt es
 * keinen Server-Rueckfall — findet sie dieses Geraet lokal nicht (weil es
 * die Nachricht nie entschluesselt hat, z. B. weil sie vor dem Koppeln dieses
 * Geraets ankam), ist sie fuer die Suche unauffindbar, OHNE dass das sichtbar
 * waere: eine leere Trefferliste sieht identisch aus wie "es gibt wirklich
 * keinen Treffer". `MobileChatsSuche.svelte` zeigt deshalb, solange
 * `E2E_DMS_ENABLED` steht, einen STATISCHEN Hinweis unter dem
 * Nachrichten-Abschnitt (nicht pro Suchlauf neu, das waere Laerm bei jedem
 * Tastendruck) — s. dortigen Kommentar. Solange der Schalter aus ist
 * (`krypto/schalter.ts`), gibt es keine ausschliesslich-lokale Nachricht,
 * und der Hinweis bleibt folgerichtig unsichtbar.
 */
import { verlaufAlleLesen } from './db';
import { lokaleTreffer, LOKALE_SUCHE_LIMIT } from './sucheTreffer';
import { sucheZusammenfuehren } from './sucheZusammenfuehren';
import { verlaufZustand } from './zustand.svelte';
import { directMessages } from '$lib/stores/directMessages.svelte';
import { chatApi, type DMMessageSearchHit } from '$lib/api/chat';

/**
 * Nur der lokale Anteil — durchsucht ausschliesslich, was dieses Geraet
 * bereits im lokalen Verlauf abgelegt hat (Klartext UND entschluesselte
 * DM-Nachrichten, s. `sucheTreffer.ts`-Modulkopf). Macht KEINEN Netzwerk-
 * Aufruf: der Suchbegriff eines Gespraechs, das nur lokal existiert
 * (verschluesselt, der Server sieht es nie), verlaesst dieses Geraet damit
 * nicht.
 */
export async function sucheLokal(suchbegriff: string): Promise<DMMessageSearchHit[]> {
  const begriff = suchbegriff.trim();
  if (begriff.length < 2) return [];
  let saetze;
  try {
    saetze = await verlaufAlleLesen();
  } catch (err) {
    verlaufZustand.melde(err);
    return [];
  }
  return lokaleTreffer(saetze, begriff).map((t) => ({
    ...t,
    other_user_id: directMessages.byId[t.dm_channel_id]?.other_user_id ?? t.author_id
  }));
}

/**
 * Fuehrt die lokale Suche und die Server-Suche (`GET /dm-channels-search`,
 * unveraendert) zusammen — s. `sucheZusammenfuehren.ts` fuer die
 * Dedup-Begruendung. Beide Aufrufe laufen parallel; scheitert die
 * Server-Anfrage (offline, aelterer Server ohne die Route etc.), bleiben
 * wenigstens die lokalen Treffer bestehen statt gar keiner Antwort — die
 * Server-Suche selbst gilt weiterhin als best-effort (die Route bot vor C5
 * schon kein eigenes Fehler-UI).
 */
export async function sucheKombiniert(suchbegriff: string): Promise<DMMessageSearchHit[]> {
  const [lokal, vomServer] = await Promise.all([
    sucheLokal(suchbegriff),
    chatApi.searchDMMessages(suchbegriff).catch(() => [] as DMMessageSearchHit[])
  ]);
  return sucheZusammenfuehren(lokal, vomServer, LOKALE_SUCHE_LIMIT);
}
