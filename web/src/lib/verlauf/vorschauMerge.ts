import { vergleicheSnowflakeArtigeId } from '../utils/snowflakeZeit.ts';

/**
 * Vorschautext + Sortier-Anker der DM-Liste — lokal ergaenzt, wo der Server
 * (der eine verschluesselte Nachricht nie sieht) einen veralteten oder gar
 * keinen Wert liefert. Etappe C3/C4 des E2E-DM-Umbaus
 * (`docs/superpowers/specs/2026-08-28-e2e-dm-design.md` §7).
 *
 * Importfrei bis auf `../utils/snowflakeZeit.ts` (selbst importfrei, per
 * erweiterungspflichtigem Relativpfad eingebunden) — s. CLAUDE.md „Die
 * Falle" zu `pnpm test:unit`. Der Rest (IndexedDB-Zugriff, das Zusammenspiel
 * mit `directMessages.byId`) bleibt in `stores/directMessages.svelte.ts`.
 *
 * **Server gewinnt, wenn er (noch) gewinnt.** `GET /dm-channels` und der
 * `ready`-Rahmen (`dm_vorschau.py`, zwei Aufrufstellen — s. CLAUDE.md) sind
 * fuer ein rein unverschluesseltes Gespraech immer die vollstaendige
 * Wahrheit: der Server sieht jede Nachricht, sein `last_message_id` ist nie
 * aelter als das lokal abgelegte. Der lokale Wert gewinnt nur, wenn er
 * NACHWEISLICH neuer ist (eingebettete Zeit, s. `vergleicheId` unten) — genau
 * der Fall einer verschluesselten Nachricht, die der Server nie zu Gesicht
 * bekommt. Der Weg fuer unverschluesselte Gespraeche aendert sich dadurch
 * nicht: dort bleibt der Server-Wert immer >= dem lokalen, der Vergleich
 * greift also nie sichtbar ein.
 */

/** ID-Vergleich fuer den Merge — dieselbe Rechnung wie in
 *  `verlauf/zusammenfuegen.ts` (dort ausfuehrlich begruendet): eine
 *  Server-Snowflake und eine lokale Kennung
 *  (`krypto/senden.ts::lokaleNachrichtId()`) sind unterschiedlich lang und
 *  ein reiner Groessenvergleich der rohen Ziffern waere falsch. */
const vergleicheId = vergleicheSnowflakeArtigeId;

//: MUSS mit `dm_vorschau.py::MAX_LAENGE` synchron bleiben — beide kuerzen
//: denselben Ausschnitt fuer dieselbe Listenzeile.
const MAX_LAENGE = 80;
//: MUSS mit den Markern in `dm_vorschau.py` synchron bleiben — der Klient
//: (`MobileChatsList.svelte::vorschau`) uebersetzt genau diese zwei Woerter.
const MARKER_BILD = '__image__';
const MARKER_DATEI = '__file__';

/** Die Felder, die der Server fuer eine DM-Listenzeile liefert (Ausschnitt
 *  von `$lib/api/types::DMChannel`, ohne den Typ hier zu importieren —
 *  importfrei-Pflicht). */
export type ServerDmVorschau = {
  last_message_id: string | null;
  last_message_preview?: string | null;
  last_message_author_id?: string | null;
  last_message_at?: string | null;
};

/** Die letzte lokal abgelegte Nachricht eines DM-Kanals — Ausschnitt von
 *  `schema.ts::Satz`, ebenfalls ohne Import (importfrei-Pflicht). */
export type LokalerLetzterSatz = {
  nachrichtId: string;
  autorId: string;
  erstelltAm: string;
  inhalt: string;
  anhaenge: unknown[];
};

/** Die MIME-Art des ERSTEN Anhangs, oder `null` ohne Anhang — dieselbe Regel
 *  wie `dm_vorschau.py::letzte_nachrichten` (fester `ORDER BY id`): „der erste
 *  Anhang bestimmt den Marker, die Liste zeigt ein Wort, keine Aufzaehlung." */
function ersterAnhangMime(anhaenge: unknown[]): string | null {
  for (const a of anhaenge) {
    if (typeof a !== 'object' || a === null) continue;
    const mime = (a as Record<string, unknown>).mime;
    if (typeof mime === 'string') return mime;
  }
  return null;
}

/** Der Ausschnitt fuer eine Listenzeile aus einem lokalen Satz — Portierung
 *  von `dm_vorschau.py::vorschau()`. `null` heisst „keine Vorschau ableitbar"
 *  (leerer Text, kein Anhang). */
export function vorschauAusText(inhalt: string, ersterMime: string | null): string | null {
  const text = inhalt
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .join(' ')
    .trim();
  if (text) return text.slice(0, MAX_LAENGE);
  if (ersterMime) return ersterMime.startsWith('image/') ? MARKER_BILD : MARKER_DATEI;
  return null;
}

/** Wie `vorschauAusText`, aber nimmt die Anhaenge roh entgegen (statt einer
 *  bereits ermittelten MIME-Art) — fuer Aufrufer, die eine ganze Nachricht
 *  vorliegen haben (`stores/directMessages.svelte.ts::upsertFromEncrypted`,
 *  Senden/Empfangen mit bereits entschluesseltem Klartext). */
export function vorschauAusNachricht(inhalt: string, anhaenge: unknown[]): string | null {
  return vorschauAusText(inhalt, ersterAnhangMime(anhaenge));
}

/**
 * Ergaenzt/ueberschreibt die Vorschau-Felder eines Server-Eintrags mit dem
 * lokalen Bestand — NUR wenn der lokale Satz nachweislich neuer ist als das,
 * was der Server als `last_message_id` fuehrt (oder der Server gar keinen
 * fuehrt). `lokal: null` (kein lokaler Satz bekannt, z. B. frischer Kanal
 * ohne lokale Historie) gibt den Server-Wert unveraendert zurueck.
 */
export function mitLokalerVorschauMergen<T extends ServerDmVorschau>(
  server: T,
  lokal: LokalerLetzterSatz | null
): T {
  if (!lokal) return server;
  if (server.last_message_id !== null && vergleicheId(server.last_message_id, lokal.nachrichtId) >= 0) {
    return server;
  }
  return {
    ...server,
    last_message_id: lokal.nachrichtId,
    last_message_preview: vorschauAusNachricht(lokal.inhalt, lokal.anhaenge),
    last_message_author_id: lokal.autorId,
    last_message_at: lokal.erstelltAm
  };
}
