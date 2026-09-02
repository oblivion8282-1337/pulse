/**
 * Wendet einen geoeffneten Loesch-Frame lokal an — herausgeloest aus
 * `empfangen.ts` (dort der Zweig `ergebnis.art === 'loeschung'`), damit
 * `ablage/kanalOrdnerLeseweg.ts` denselben Block benutzt statt ihn zu
 * kopieren. Reiner Umzug, kein Verhalten geaendert — die Begruendung
 * (welche lokale ID ein Frame trifft, warum ein Fehltreffer wirkungslos
 * bleibt statt zu werfen) steht weiterhin im Modulkopf von `empfangen.ts`
 * unter „Loesch-Frame" sowie in `loeschZiel.ts`.
 */
import { verlaufNachrichtGeloescht, verlaufLokaleIdFuerKryptoId } from '../verlauf';
import { messages } from '../stores/messages.svelte';
import { lokaleIdsFuerLoeschung } from './loeschZiel';

/**
 * Setzt den Grabstein fuer jeden lokalen Satz, den der Frame trifft
 * (`lokaleIdsFuerLoeschung`: eigenes Geraet des Absenders ODER jedes
 * empfangende Geraet ueber `krypto_id`). Kein Treffer im geladenen Fenster?
 * Dann der dauerhafte Verlauf selbst (`verlaufLokaleIdFuerKryptoId`) — bleibt
 * auch das erfolglos, steht der Frame-Wert unveraendert als letzter Versuch
 * da: ein Grabstein auf eine unbekannte ID ist wirkungslos, nie ein Fehler.
 */
export async function loeschungAnwenden(channelId: string, nachrichtId: string): Promise<void> {
  let ziele = lokaleIdsFuerLoeschung(nachrichtId, messages.for(channelId));
  if (ziele.length === 0) {
    const imVerlauf = await verlaufLokaleIdFuerKryptoId(channelId, nachrichtId);
    ziele = [imVerlauf ?? nachrichtId];
  }
  for (const lokaleId of ziele) {
    verlaufNachrichtGeloescht(channelId, lokaleId);
    messages.remove(channelId, lokaleId);
  }
}
