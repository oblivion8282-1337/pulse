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
 *
 * SEIT dem E2E-Bughunt (2026-08-28): fuer den Krypto-Pfad ist die lokale
 * Ablage die EINZIGE Kopie — der Server sieht den Klartext nie (`senden.ts`)
 * bzw. hat den Umschlag nach der Quittung geloescht (`empfangen.ts`). Das
 * "wirft nie"-Versprechen von `verlaufSpeichern` waere dort kein Komfort,
 * sondern ein stiller, endgueltiger Datenverlust: eine Quittung nach einem
 * fehlgeschlagenen Schreiben loescht die einzige Kopie auf dem Server, ohne
 * dass je eine zweite entstanden waere. `verlaufSpeichernPflicht` ist deshalb
 * dieselbe Rechnung wie `verlaufSpeichern`, aber OHNE das schluckende
 * `.catch` — ein Fehlschlag wird zu einer abgelehnten Promise, die ein
 * vergessenes `await`/`catch` als sichtbare "unhandled rejection" auffallen
 * laesst statt sie in einen stillen Rueckgabewert `0` zu verwandeln.
 *
 * Zweiter Bughunt (2026-08-28, FIX 1): auch ein Rueckgabewert `0` OHNE Wurf
 * war fuer `verlaufSpeichernPflicht` noch falsch — `krypto/quittierbareIds.ts`
 * wertet jeden nicht werfenden Aufruf als Erfolg und quittiert, egal was der
 * Rueckgabewert sagt. Die beiden Faelle, in denen die alte Fassung `0` OHNE
 * Wurf zurueckgab (`!istDmKanal` und `baueSaetze(...).length === 0`), waren
 * damit "nichts gespeichert" getarnt als Erfolg. Der haeufigste Fall dahinter
 * ist nicht exotisch: die ERSTE Nachricht eines Gespraechs, das der Klient
 * lokal noch nicht als DM-Kanal kennt (der `ready`-Rahmen bzw.
 * `dm_channel_created` ist noch nicht angekommen). Fuer die alleinigen
 * Aufrufer dieser Funktion (`krypto/senden.ts`, `krypto/empfangen.ts`) ist
 * JEDER Kanal, den sie hier sehen, ein DM-Kanal — Postfach-Zustellungen gibt
 * es nur fuer DMs. `istDmKanal === false` ist an dieser Stelle also nie "kein
 * DM, ueberspringen" (das waere `verlaufSpeichern`s Fall), sondern immer
 * "dieser DM-Kanal ist lokal noch nicht bekannt". Verwerfen waere hier
 * endgueltiger Datenverlust, stillschweigend erfolgreich tun waere derselbe
 * Verlust nur einen Schritt spaeter (die Quittung raeumt den Server). Beide
 * Faelle werfen deshalb jetzt `VerlaufSpeichernFehlgeschlagen`: der Aufrufer
 * quittiert nicht, die Zustellung bleibt auf dem Server liegen, und der
 * naechste Abholzyklus versucht es erneut — sobald der Kanal lokal bekannt
 * ist, gelingt der Schreibvorgang.
 */
import { zuSatz, sortierSchluessel, satzZuNachricht, type SatzAlsNachricht } from './satz';
import {
  verlaufPutSaetze,
  verlaufMarkiereGeloescht,
  verlaufLesenSaetze,
  verlaufSatzVorhanden
} from './db';
import { verlaufZustand } from './zustand.svelte';
import { zusammenfuegen, type Mergeposten } from './zusammenfuegen';
import { VerlaufSpeichernFehlgeschlagen, pruefeSpeicherErgebnis } from './speichernPflicht';
import { directMessages } from '$lib/stores/directMessages.svelte';
import type { Message } from '$lib/api/types';

export { VerlaufSpeichernFehlgeschlagen };

/**
 * Nur DM-Kanäle werden lokal abgelegt — Community-Kanäle bleiben serverseitig
 * (Spec §9). Die Unterscheidung läuft über die Kanal-ID, nicht über die
 * Aufrufstelle: `chat.ts`/`gapFill.ts`/`MessageList.svelte` bedienen DM- UND
 * Guild-Kanäle gleichermassen, ein Filter nach Aufrufstelle träfe das falsch.
 */
function istDmKanal(kanalId: string): boolean {
  return kanalId in directMessages.byId;
}

/** Baut die zu schreibenden Saetze — geteilte Rechnung von
 *  `verlaufSpeichern`/`verlaufSpeichernPflicht`. Kein expliziter Rueckgabetyp:
 *  `Satz` (aus `satz.ts`) ist absichtlich nicht exportiert (importfrei-Pflicht
 *  dort), die Inferenz aus `zuSatz` traegt hier genauso. */
function baueSaetze(kanalId: string, nachrichten: unknown[]) {
  const saetze: NonNullable<ReturnType<typeof zuSatz>>[] = [];
  for (const nachricht of nachrichten) {
    const satz = zuSatz(kanalId, nachricht);
    if (satz) saetze.push(satz);
  }
  return saetze;
}

/**
 * Legt ankommende Nachrichten eines Kanals im lokalen Verlauf ab (nur wenn es
 * ein DM-Kanal ist). Gibt zurück, wie viele Sätze abgelegt wurden — der
 * Rückgabewert ist reine Diagnose, kein Aufrufer wertet ihn heute aus.
 * Wirft nie: siehe Kommentar oben. Fuer den C1/C2-Lesepfad (der Server hat
 * ohnehin eine eigene Kopie) — der Krypto-Pfad braucht `verlaufSpeichernPflicht`.
 */
export function verlaufSpeichern(kanalId: string, nachrichten: unknown[]): Promise<number> {
  if (!istDmKanal(kanalId)) return Promise.resolve(0);
  const saetze = baueSaetze(kanalId, nachrichten);
  if (saetze.length === 0) return Promise.resolve(0);
  return verlaufPutSaetze(saetze)
    .then(() => saetze.length)
    .catch((err) => {
      verlaufZustand.melde(err);
      return 0;
    });
}

/**
 * Wie `verlaufSpeichern`, aber fuer Aufrufer, denen der lokale Speicher die
 * EINZIGE Kopie einer Nachricht ist (`krypto/senden.ts`, `krypto/empfangen.ts`)
 * — wirft bei einem Fehlschlag, statt ihn zu verschlucken (s. Modulkopf). Ein
 * Aufrufer MUSS reagieren: entweder die Quittung/den Abschluss zurückhalten,
 * oder den Fehler an den Nutzer weitergeben. Wirft auch dann, wenn NICHTS zu
 * speichern war (unbekannter DM-Kanal, keine speicherbaren Saetze) — ein
 * Rueckgabewert `0` sah bislang wie Erfolg aus; die Entscheidung, wann das
 * gilt, steht importfrei (und damit direkt testbar) in `speichernPflicht.ts`
 * (s. Modulkopf FIX 1).
 */
export function verlaufSpeichernPflicht(
  kanalId: string,
  nachrichten: unknown[]
): Promise<number> {
  try {
    const dmBekannt = istDmKanal(kanalId);
    const saetze = dmBekannt ? baueSaetze(kanalId, nachrichten) : [];
    pruefeSpeicherErgebnis(kanalId, dmBekannt, saetze.length);
    return verlaufPutSaetze(saetze).then(() => saetze.length);
  } catch (err) {
    return Promise.reject(err);
  }
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

/**
 * `true`, wenn fuer diese Nachrichten-ID im DM-Kanal bereits ein Satz liegt —
 * fuer `krypto/empfangen.ts` FIX 3 (Bughunt-Runde 3, s. dortigen Modulkopf):
 * eine Zustellung, deren Quittung zuletzt fehlschlug, aber deren Klartext
 * schon sicher abgelegt ist, darf ohne erneutes Entschluesseln quittiert
 * werden. Wirft nie (wie die uebrigen Lesefunktionen hier) — ein Lesefehler
 * heisst hier nur "sicherheitshalber wie neu behandeln", der Aufrufer bleibt
 * dann beim bestehenden, langsameren Pfad.
 */
export function verlaufSchonAbgelegt(kanalId: string, nachrichtId: string): Promise<boolean> {
  if (!istDmKanal(kanalId)) return Promise.resolve(false);
  return verlaufSatzVorhanden(kanalId, nachrichtId).catch((err) => {
    verlaufZustand.melde(err);
    return false;
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
