/**
 * Nachricht → Satz des lokalen Verlaufs — importfrei, damit Nodes
 * Testlaeufer sie sieht (kein erweiterungsloser Laufzeit-Import moeglich).
 *
 * Die Satzform selbst (`Satz`) steht in `schema.ts`; hier nur der
 * strukturell identische Rueckgabetyp, um KEINEN Import zu brauchen.
 */

type Satz = {
  schluessel: string;
  kanalId: string;
  nachrichtId: string;
  autorId: string;
  inhalt: string;
  erstelltAm: string;
  bearbeitetAm: string | null;
  geloescht: boolean;
  anhaenge: unknown[];
};

/**
 * Snowflakes sind Zeichenketten (JS `Number` kann 64 Bit nicht exakt
 * darstellen, s. CLAUDE.md). Ein IndexedDB-Schluessel sortiert lexikografisch
 * — ungepolstert stuende "10" vor "9". 20 Stellen reichen: die groesste
 * 64-Bit-Zahl hat 20 Dezimalstellen. Trennzeichen `:` kommt in keiner
 * Snowflake und keiner Kanal-ID vor (beide sind reine Ziffernfolgen).
 */
const ID_BREITE = 20;
const TRENNER = ':';

export function sortierSchluessel(kanalId: string, nachrichtId: string): string {
  return `${kanalId}${TRENNER}${nachrichtId.padStart(ID_BREITE, '0')}`;
}

/**
 * Wandelt eine rohe Nachricht (vom Server oder aus dem WS) in einen Satz um.
 * Fail-closed: fehlt ein Pflichtfeld oder hat es den falschen Typ, gibt es
 * `null` zurueck statt Muell abzulegen — sonst faellt der Fehler erst beim
 * Lesen auf, Wochen spaeter.
 */
export function zuSatz(kanalId: string, nachricht: unknown): Satz | null {
  if (typeof nachricht !== 'object' || nachricht === null) return null;
  const n = nachricht as Record<string, unknown>;
  const { id, author_id, content } = n;
  if (typeof id !== 'string' || typeof author_id !== 'string' || typeof content !== 'string') {
    return null;
  }
  const created_at = n.created_at;
  if (typeof created_at !== 'string') return null;
  const edited_at = typeof n.edited_at === 'string' ? n.edited_at : null;
  const deleted_at = typeof n.deleted_at === 'string' ? n.deleted_at : null;
  const anhaenge = Array.isArray(n.attachments) ? n.attachments : [];

  return {
    schluessel: sortierSchluessel(kanalId, id),
    kanalId,
    nachrichtId: id,
    autorId: author_id,
    inhalt: content,
    erstelltAm: created_at,
    bearbeitetAm: edited_at,
    geloescht: deleted_at !== null,
    anhaenge
  };
}
