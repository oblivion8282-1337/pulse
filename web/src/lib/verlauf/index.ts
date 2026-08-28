/**
 * Speichern/Lesen darf die App NIE blockieren — IndexedDB faellt in der
 * Praxis aus: privates Fenster, voller Speicher, ein Browser mit
 * abgeschalteten Seitendaten. Der Rueckfall auf den Server bleibt in jedem
 * Fall bestehen (s. `verlaufZustand.melde` unten).
 *
 * SEIT C2 (Lesen): ein verschluckter Fehler ist kein Schulterzucken mehr,
 * sondern ein leerer Verlauf ohne Erklaerung. Jeder Fehlschlag meldet sich
 * deshalb bei `verlaufZustand`, das der Oberflaeche den Grund gibt — wirft
 * aber weiterhin nie nach aussen, s. einzelne Funktionen.
 */
import { zuSatz, sortierSchluessel, satzZuNachricht, type SatzAlsNachricht } from './satz';
import { verlaufPutSaetze, verlaufMarkiereGeloescht, verlaufLesenSaetze } from './db';
import { verlaufZustand } from './zustand.svelte';
import { zusammenfuegen, type Mergeposten } from './zusammenfuegen';
import { directMessages } from '$lib/stores/directMessages.svelte';
import type { Message } from '$lib/api/types';

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
    .catch((err) => {
      verlaufZustand.melde(err);
      return 0;
    });
}

/**
 * Setzt den Grabstein für eine gelöschte Nachricht. `message_delete` trägt
 * am WS keine volle Nachricht (nur `channel_id`+`id`) — deshalb kein Umweg
 * über `verlaufSpeichern`/`zuSatz`, sondern direkt über den Schlüssel.
 * Wirft nie: siehe Kommentar oben.
 */
export function verlaufNachrichtGeloescht(kanalId: string, nachrichtId: string): void {
  if (!istDmKanal(kanalId)) return;
  void verlaufMarkiereGeloescht(sortierSchluessel(kanalId, nachrichtId)).catch((err) => {
    verlaufZustand.melde(err);
    /* wirft nie nach aussen — s. Kommentar oben */
  });
}

/**
 * Liest bis zu `anzahl` Saetze eines DM-Kanals aus dem lokalen Speicher.
 * Fuer Guild-Kanaele (nicht lokal abgelegt, s. `istDmKanal`) immer `[]` —
 * bewusst KEIN Fehlerfall, ein Aufrufer kann uebergangslos beide Kanalarten
 * anfragen. Wirft nie: ein Lesefehler faellt auf den leeren Bestand zurueck
 * (der Aufrufer fragt dann ohnehin den Server), meldet sich aber bei
 * `verlaufZustand` — das ist der Unterschied zu C1 (s. Modulkopf).
 */
export function verlaufLesen(
  kanalId: string,
  opts: { vor?: string; anzahl: number }
): Promise<SatzAlsNachricht[]> {
  if (!istDmKanal(kanalId)) return Promise.resolve([]);
  return verlaufLesenSaetze(kanalId, opts)
    .then((saetze) => saetze.map(satzZuNachricht))
    .catch((err) => {
      verlaufZustand.melde(err);
      return [];
    });
}

/** Ein Merge-Posten fuer `zusammenfuegen` — trägt die anzuzeigende Nachricht
 *  als Nutzlast mit, ohne dass die importfreie Merge-Rechnung sie kennen
 *  muss (sie liest nur `id`/`bearbeitetAm`/`geloescht`). */
type Posten = Mergeposten & { nachricht: Message };

function lokalZuPosten(lokal: SatzAlsNachricht[]): Posten[] {
  return lokal.map((n) => ({
    id: n.id,
    bearbeitetAm: n.edited_at,
    geloescht: n.deleted_at !== null,
    nachricht: n
  }));
}

function serverZuPosten(vomServer: Message[]): Posten[] {
  // Der Server liefert geloeschte Nachrichten grundsaetzlich nicht mehr aus
  // (`Message.deleted_at.is_(None)`-Filter, s. `routes/messages.py`) — jeder
  // Posten von hier gilt deshalb als nicht geloescht.
  return vomServer.map((n) => ({ id: n.id, bearbeitetAm: n.edited_at ?? null, geloescht: false, nachricht: n }));
}

/**
 * Fuehrt lokalen Bestand und Serverantwort zu der Liste zusammen, die
 * angezeigt wird. Grabsteine bleiben aussen vor (wie ein `message_delete`-
 * Event sie auch heute schon hart aus dem `MessageStore` entfernt) — die
 * eigentliche Rechnung steht importfrei in `zusammenfuegen.ts`.
 */
export function verlaufMergen(lokal: SatzAlsNachricht[], vomServer: Message[]): Message[] {
  const merged = zusammenfuegen(lokalZuPosten(lokal), serverZuPosten(vomServer));
  return merged.filter((p) => !p.geloescht).map((p) => p.nachricht);
}
