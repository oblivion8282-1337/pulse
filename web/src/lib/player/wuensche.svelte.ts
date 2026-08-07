/**
 * Was der Zuschauer fuer EINE Kachel will — getrennt von der Sitzung, die es
 * ausfuehrt (`store.svelte.ts`).
 *
 * Drei Wuensche, alle je *(channel, user, slot)*: „ins eigene Fenster",
 * „wieder in die Kachel" und „mach mir den Chat auf". Sie ueberleben die
 * Sitzung bewusst — eine Sitzung kann scheitern und ersetzt werden, der Wunsch
 * des Zuschauers bleibt derselbe.
 *
 * Eigenes Modul, weil `store.svelte.ts` mit diesem Teil ueber die harte
 * Groessen-Grenze von 500 Zeilen gewachsen war (`PLAN.md` §12.1) — und weil die
 * Abhaengigkeit nur in eine Richtung laeuft: die Sitzung liest die Wuensche,
 * die Wuensche wissen von keiner Sitzung.
 */
import { SvelteMap, SvelteSet } from 'svelte/reactivity';

export const keyOf = (channelId: string, userId: string, slot: number): string =>
  `${channelId}:${userId}:${slot}`;

/**
 * Welche Kacheln der Zuschauer ins eigene Fenster geschickt hat.
 *
 * WARUM NEBEN `playerSettings.useNativePlayer`: Der Schalter ist eine
 * **Vorgabe für alle** Streams; das hier ist eine **Entscheidung fuer einen**.
 * Seit der Abkoppel-Knopf unter Electron das eigene Fenster oeffnet (statt
 * eines zweiten Chromium-Fensters), ist das der uebliche Weg — der Nutzer
 * waehlt pro Stream, nicht ein fuer alle Mal.
 */
const requests = new SvelteSet<string>();

/**
 * Kacheln, deren Fenster der Nutzer selbst zugemacht hat — die Automatik laesst
 * sie danach in Ruhe.
 *
 * **Warum es das braucht.** `playerSettings.useNativePlayer` ist eine Vorgabe
 * fuer alle Streams, und sie steht auch dann noch, wenn das Fenster gerade
 * geschlossen wurde. Bis zum 2026-08-08 hiess das: Fenster zumachen → die
 * Kachel will unveraendert ins Fenster → `nativePlayerSessions.ensure` findet
 * eine geschlossene Sitzung vor, haelt sie fuer kaputt und ersetzt sie → das
 * Fenster ging sofort wieder auf. Jede Runde holte eine neue WHEP-Adresse und
 * baute eine volle WebRTC-Verbindung auf. Nach fuenf Runden griff die Bremse
 * (`ERSATZ_MAX`) — und liess die Kachel dauerhaft auf `connecting` stehen,
 * schwarz, weil eine GESCHLOSSENE Sitzung nicht als gescheitert gilt und der
 * `<video>`-Rueckfall deshalb nie ansprang.
 *
 * Der Abkoppel-Knopf war davon nur zur Haelfte betroffen: er nahm die
 * Anforderung zurueck (richtig) und schloss die Sitzung (auch richtig) — mit
 * gesetzter Vorgabe-fuer-alles reichte das aber nicht, weil die Vorgabe die
 * Kachel weiter ins Fenster schickte. Der 10-bit-Zwang war nie betroffen: dort
 * schickt der Player zusaetzlich `player:closeRequest` und die Kachel geht ganz
 * zu.
 *
 * Zurueckgesetzt wird der Merker beim naechsten ausdruecklichen Wunsch
 * ([`nativeWindowRequests.request`]) und wenn die Kachel verschwindet
 * ([`merkerAufraeumen`]) — dieselbe Reichweite wie der `<video>`-Rueckfall nach
 * einem Fehler: bis zum naechsten Mount. **Nicht** beim blossen Schliessen der
 * Sitzung: genau das tut der Abkoppel-Knopf, und dort ist der Merker der Punkt.
 */
const automatikAus = new SvelteSet<string>();

/**
 * „Chat aufmachen" aus dem Player-Fenster — ein Zaehler je Stream.
 *
 * Ein Zaehler statt eines Ja/Nein: der Nutzer kann den Knopf mehrfach
 * druecken, und beim zweiten Mal muss die Kachel wieder reagieren. Ein `true`,
 * das schon `true` war, loest keinen Effect aus.
 */
const chatWuensche = new SvelteMap<string, number>();

export const nativeChatRequests = {
  /** Wie oft der Chat fuer diesen Stream angefordert wurde. */
  count(channelId: string, userId: string, slot = 0): number {
    return chatWuensche.get(keyOf(channelId, userId, slot)) ?? 0;
  },
  bump(channelId: string, userId: string, slot = 0): void {
    const k = keyOf(channelId, userId, slot);
    chatWuensche.set(k, (chatWuensche.get(k) ?? 0) + 1);
  },
};

export const nativeWindowRequests = {
  has(channelId: string, userId: string, slot = 0): boolean {
    return requests.has(keyOf(channelId, userId, slot));
  },
  /** Der Nutzer will DIESEN Stream im Fenster — das hebt eine vorherige
   *  Schliessung wieder auf, sonst waere der Knopf nach einmal Zumachen tot. */
  request(channelId: string, userId: string, slot = 0): void {
    const k = keyOf(channelId, userId, slot);
    automatikAus.delete(k);
    requests.add(k);
  },
  release(channelId: string, userId: string, slot = 0): void {
    requests.delete(keyOf(channelId, userId, slot));
  },
  /** Der Nutzer hat das Fenster zugemacht: Anforderung zurueck UND die
   *  Automatik anhalten. Beides gehoert zusammen — die Anforderung allein
   *  zurueckzunehmen liess die Vorgabe-fuer-alles sofort ein neues Fenster
   *  aufreissen (s. [`automatikAus`]). */
  zugemacht(channelId: string, userId: string, slot = 0): void {
    const k = keyOf(channelId, userId, slot);
    requests.delete(k);
    automatikAus.add(k);
  },
  /** Hat der Nutzer das Fenster dieser Kachel selbst zugemacht? Dann oeffnet
   *  die Vorgabe-fuer-alles es nicht von sich aus wieder (s. [`automatikAus`]). */
  automatikAus(channelId: string, userId: string, slot = 0): boolean {
    return automatikAus.has(keyOf(channelId, userId, slot));
  },
};

/**
 * Merker der Kacheln vergessen, die es nicht mehr gibt.
 *
 * Getrennt von der Sitzungs-Registry, weil eine uebersprungene Kachel dort gar
 * keinen Eintrag hat. Ohne dieses Aufraeumen bliebe „der Nutzer hat zugemacht"
 * ueber das Ende der Kachel hinaus stehen, und das Fenster ginge beim naechsten
 * Mount nicht mehr auf.
 */
export function merkerAufraeumen(wantedKeys: Set<string>): void {
  for (const k of [...automatikAus]) {
    if (!wantedKeys.has(k)) automatikAus.delete(k);
  }
}
