/**
 * Sitzungswahl für einen Ablage-Kanal — der ereignisgetriebene Zwilling zu
 * `senden.ts`s Weg für private Gruppen.
 *
 * **`sitzungswahl.ts` selbst bleibt unangetastet.** Sie ist laut eigenem
 * Modulkopf bereits generisch über den Sitzungstyp `S` — die echte
 * Megolm-Sitzung ist eine WASM-Klasse, dieselbe für private Gruppen und
 * Ablage-Kanäle, und die Speicherung in `gruppenSitzungen.ts` hängt nur an
 * einer `kanalId`-Zeichenkette, der es egal ist, ob sie zu einer privaten
 * Gruppe oder einem Guild-Kanal gehört. Ein eigener „Kanal-Sitzungstyp" ist
 * deshalb NICHT nötig und wäre auch falsch: `sitzungWaehlen` bräuchte dafür
 * keine Änderung, sie unterscheidet nie, WOHER `mitglieder`/`geraete`
 * kommen. Was fehlt, ist nur eine andere Quelle für `mitglieder` — und die
 * gehört nicht in die Wahl-Funktion selbst, sonst verlöre der
 * Gruppen-Weg seine Garantie „immer frisch vom Server" (deren Modulkopf das
 * ausdrücklich als Fundament nennt).
 *
 * **Der Unterschied sitzt VOR `sitzungWaehlen`, hier:** private Gruppen
 * lesen die Mitgliederliste vor JEDER Sendung neu (kein Ereignis
 * existiert). Ein Guild-Kanal hat Ereignisse für Mitglieder- und
 * Rechteänderungen (`kanalWechselErkennung.ts`) — die Sitzungswahl hängt
 * sich daran: **Ereignis → Sitzung als überholt markieren → erst beim
 * nächsten Senden wird tatsächlich neu geholt und ggf. rotiert.** Ohne ein
 * Ereignis seit der letzten Sendung liefert `mitgliederFuerNaechstesSenden`
 * die im Stand gemerkte Liste zurück — kein `GET`, kein `keys/claim` extra.
 * Das ist der Punkt der ganzen Datei: bei hundert Mitgliedern kostet ein
 * Wechsel eine Verteilrunde, keine hundert Nachrichten je eine.
 *
 * **Ohne Wechsel darf NICHT rotiert werden.** Das übernimmt weiterhin
 * `wechselgrund` (Mengenvergleich) — diese Datei sorgt nur dafür, dass die
 * Mitgliederliste, die dort hineingeht, mal frisch (nach einem Ereignis)
 * und mal die alte (ohne Ereignis) ist. Fällt beides zusammen — Ereignis
 * kam, aber die tatsächliche `VIEW_CHANNEL`-Menge hat sich nicht geändert
 * (z. B. eine Rollenrechte-Änderung, die diesen Kanal gar nicht betraf) —
 * bleibt die Sitzung trotzdem stehen: `wechselgrund` sieht dieselbe Menge
 * und liefert `null`.
 *
 * **`ueberholt` wird erst zurückgesetzt, wenn der neue Stand tatsächlich
 * übernommen wurde** (`kanalStandUebernehmen`), nicht schon beim Holen der
 * Liste. Bricht das Senden dazwischen ab (Netzfehler, Sperre, was auch
 * immer) und `kanalStandUebernehmen` läuft nie, bleibt `ueberholt` wahr —
 * der nächste Versuch holt erneut frisch. Umgekehrt wäre eine bereits
 * gelöschte Markierung ohne übernommenen Stand eine Lücke: der übernächste
 * Aufruf griffe wieder auf die ALTE, nie aktualisierte Liste zurück, obwohl
 * ein Wechsel längst gemeldet wurde.
 *
 * **Was das nicht leistet, ehrlich benannt:** ein Ausgeschiedener kann
 * weiterlesen, was er schon hat, und bis zur nächsten Rotation auch noch
 * Mitgelesenes öffnen. Das ist die Zusage eines ehrlichen Absenders, keine
 * kryptografische Garantie mit sofortiger Wirkung — genau wie bei privaten
 * Gruppen (`sitzungswahl.ts`-Modulkopf), und es deckt sich mit der
 * Entscheidung des Eigentümers, dass ab dem Rauswurf nichts Neues mehr
 * ankommt, nicht damit, dass bereits Ausgeliefertes ungeschehen wird.
 */
import { sitzungWaehlen, standNachSendung } from './sitzungswahl.ts';
import type { Gruppenstand, Sitzungswahl, Wechselgrenzen } from './sitzungswahl.ts';
import { machtKanalUeberholt } from './kanalWechselErkennung.ts';
import type { KanalWechselEreignis } from './kanalWechselErkennung.ts';

// Re-Export, damit ein Aufrufer nicht zusätzlich aus `sitzungswahl.ts`
// importieren muss, um eine Sendung durchzuführen.
export { sitzungWaehlen, standNachSendung };
export type { Gruppenstand, Sitzungswahl, Wechselgrenzen, KanalWechselEreignis };

/** Zustand einer laufenden Kanal-Sitzungswahl — hält den Stand plus die
 *  Überholt-Markierung. `S` ist derselbe Sitzungstyp wie in `Gruppenstand`. */
export type KanalSitzungState<S> = {
  stand: Gruppenstand<S> | null;
  /** Ein relevantes Ereignis kam seit der letzten übernommenen Sendung. */
  ueberholt: boolean;
};

/** Frischer Zustand für einen Kanal, ohne laufende Sitzung. */
export function neuerKanalSitzungState<S>(): KanalSitzungState<S> {
  return { stand: null, ueberholt: false };
}

/**
 * Von einem WS-Listener gerufen, sobald ein Ereignis eintrifft. Markiert
 * nur — rotiert NICHT (das passiert frühestens beim nächsten
 * `mitgliederFuerNaechstesSenden` + `sitzungWaehlen`). Rein bis auf das
 * eine Flag; kein Netzaufruf.
 */
export function kanalEreignisVerarbeiten<S>(
  state: KanalSitzungState<S>,
  evt: KanalWechselEreignis,
  guildId: string,
  kanalId: string
): void {
  if (machtKanalUeberholt(evt, guildId, kanalId)) state.ueberholt = true;
}

/**
 * Die Mitgliederliste, mit der die nächste Sendung `sitzungWaehlen`
 * aufrufen soll. Ohne Ereignis seit der letzten Übernahme (und mit
 * vorhandenem Stand) wird NICHTS geholt — die gemerkte Liste reicht, denn
 * an ihr hat sich nachweislich nichts geändert. Beim allerersten Senden
 * (kein Stand) oder nach einem Ereignis wird `mitgliederHolen` gerufen.
 */
export async function mitgliederFuerNaechstesSenden<S>(
  state: KanalSitzungState<S>,
  mitgliederHolen: () => Promise<string[]>
): Promise<string[]> {
  if (!state.ueberholt && state.stand !== null) {
    return state.stand.mitglieder;
  }
  return mitgliederHolen();
}

/**
 * Nach einer erfolgreichen `sitzungWaehlen`-Runde aufrufen: übernimmt den
 * neuen Stand und löscht die Überholt-Markierung. Erst hier — nicht schon
 * beim Holen der Liste — s. Modulkopf.
 */
export function kanalStandUebernehmen<S>(
  state: KanalSitzungState<S>,
  wahl: Sitzungswahl<S>
): void {
  state.stand = wahl.stand;
  state.ueberholt = false;
}
