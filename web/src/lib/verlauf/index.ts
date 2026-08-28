/**
 * Speichern darf die App NIE stoerten.
 *
 * In dieser Etappe liest niemand aus dem Verlauf; ein Fehlschlag ist deshalb
 * folgenlos. IndexedDB faellt in der Praxis aus: privates Fenster, voller
 * Speicher, ein Browser mit abgeschalteten Seitendaten. Wer das nach oben
 * durchreicht, laesst die Nachrichtenliste an etwas scheitern, das sie gar
 * nicht braucht.
 *
 * ACHTUNG fuer C2: sobald LOKAL GELESEN wird, ist ein verschluckter Fehler
 * kein Schulterzucken mehr, sondern ein leerer Verlauf ohne Erklaerung. Diese
 * Stelle muss dann laut werden.
 */
import { zuSatz, sortierSchluessel } from './satz';
import { verlaufPutSaetze, verlaufMarkiereGeloescht } from './db';
import { directMessages } from '$lib/stores/directMessages.svelte';

/**
 * Nur DM-Kanäle werden lokal abgelegt — Community-Kanäle bleiben serverseitig
 * (Spec §9). Die Unterscheidung läuft über die Kanal-ID, nicht über die
 * Aufrufstelle: `chat.ts`/`gapFill.ts`/`MessageList.svelte` bedienen DM- UND
 * Guild-Kanäle gleichermassen, ein Filter nach Aufrufstelle träfe das falsch.
 */
function istDmKanal(kanalId: string): boolean {
  return kanalId in directMessages.byId;
}

/**
 * Legt ankommende Nachrichten eines Kanals im lokalen Verlauf ab (nur wenn es
 * ein DM-Kanal ist). Gibt zurück, wie viele Sätze abgelegt wurden — der
 * Rückgabewert ist reine Diagnose, kein Aufrufer wertet ihn heute aus.
 * Wirft nie: siehe Kommentar oben.
 */
export function verlaufSpeichern(kanalId: string, nachrichten: unknown[]): Promise<number> {
  if (!istDmKanal(kanalId)) return Promise.resolve(0);
  const saetze = [];
  for (const nachricht of nachrichten) {
    const satz = zuSatz(kanalId, nachricht);
    if (satz) saetze.push(satz);
  }
  if (saetze.length === 0) return Promise.resolve(0);
  return verlaufPutSaetze(saetze)
    .then(() => saetze.length)
    .catch(() => 0);
}

/**
 * Setzt den Grabstein für eine gelöschte Nachricht. `message_delete` trägt
 * am WS keine volle Nachricht (nur `channel_id`+`id`) — deshalb kein Umweg
 * über `verlaufSpeichern`/`zuSatz`, sondern direkt über den Schlüssel.
 * Wirft nie: siehe Kommentar oben.
 */
export function verlaufNachrichtGeloescht(kanalId: string, nachrichtId: string): void {
  if (!istDmKanal(kanalId)) return;
  void verlaufMarkiereGeloescht(sortierSchluessel(kanalId, nachrichtId)).catch(() => {
    /* wirft nie nach aussen — s. Kommentar oben */
  });
}
