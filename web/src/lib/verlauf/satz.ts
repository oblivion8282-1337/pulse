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
  antwortAufId: string | null;
  kryptoId: string | null;
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
  const antwortAufId = typeof n.reply_to_id === 'string' ? n.reply_to_id : null;
  const kryptoId = typeof n.krypto_id === 'string' ? n.krypto_id : null;

  return {
    schluessel: sortierSchluessel(kanalId, id),
    kanalId,
    nachrichtId: id,
    autorId: author_id,
    inhalt: content,
    erstelltAm: created_at,
    bearbeitetAm: edited_at,
    geloescht: deleted_at !== null,
    anhaenge,
    antwortAufId,
    kryptoId
  };
}

/**
 * Reduzierte Nachrichtenform fuer die sofortige Anzeige aus einem lokalen
 * Satz — strukturell ein Ausschnitt von `$lib/api/types::Message` (dessen
 * fehlende Felder dort optional sind), aber OHNE dessen Typ zu importieren
 * (importfrei-Pflicht, s. Modulkopf). Reaktionen und Erwaehnungen liegen lokal
 * nicht vor — sie fehlen, bis der Server-Abgleich sie nachliefert. Anhaenge
 * kommen seit Etappe E mit, aber NUR die verschluesselten (Begruendung bei
 * `verschluesselteAnhaenge`).
 */
export type SatzAlsNachricht = {
  id: string;
  channel_id: string;
  author_id: string;
  content: string;
  nonce: null;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
  reply_to_id: string | null;
  /** Wie `Message.krypto_id` (`api/types.ts`) — dort optional-ohne-`null`,
   *  deshalb `undefined` statt `null` bei Fehlen (s. `satzZuNachricht`). */
  krypto_id?: string;
  /** Nur VERSCHLUESSELTE Anhaenge (Etappe E), s. `satzZuNachricht`.
   *  Strukturell der Ausschnitt von `$lib/api/types::Attachment`, den diese
   *  Datei ohne Import beschreiben kann — **mit jenem Typ synchron halten**,
   *  sonst faellt die Zuweisung an `Message.attachments` beim naechsten
   *  Pflichtfeld dort auseinander. */
  attachments?: {
    id: string;
    filename: string | null;
    mime: string | null;
    size: number;
    url: string;
    verschluesselt?: boolean;
  }[];
};

/**
 * Die verschluesselten Anhaenge eines Satzes — und NUR die.
 *
 * Ein Klartext-Anhang wird bewusst NICHT zurueckgegeben, obwohl `zuSatz` ihn
 * mit ablegt: seine `url` ist eine vorsignierte Adresse mit ~30 Minuten
 * Frist, aus dem lokalen Bestand also fast immer abgelaufen. Ihn hier
 * mitzuliefern wuerde den Klartext-Weg aendern (erst eine 403, dann ein
 * Nachsignieren, wo heute schlicht der Server-Bestand gilt) — und der darf
 * sich nicht aendern. Ein verschluesselter Anhang traegt dagegen gar keine
 * Adresse, sondern seinen Schluessel; er ist ohne den lokalen Bestand nach
 * einem Neustart nicht mehr auffindbar, weil der Server die Nachricht nie
 * gesehen hat.
 */
function verschluesselteAnhaenge(anhaenge: unknown[]): SatzAlsNachricht['attachments'] {
  const gefiltert = anhaenge.filter(
    (a): a is NonNullable<SatzAlsNachricht['attachments']>[number] =>
      typeof a === 'object' &&
      a !== null &&
      (a as Record<string, unknown>).verschluesselt === true &&
      typeof (a as Record<string, unknown>).id === 'string'
  );
  return gefiltert.length > 0 ? gefiltert : undefined;
}

/** Kehrt `zuSatz` um: aus einem lokalen Satz wird die Anzeige-Nachricht.
 *  `deleted_at` traegt bei einem Grabstein einen Zeitpunkt (Bearbeitungs-
 *  oder Erstellzeit als Naeherung — der echte Loeschzeitpunkt liegt lokal
 *  nicht vor), sonst `null`. Nur die Existenz eines Werts zaehlt bei den
 *  Aufrufern, nicht seine Genauigkeit. */
export function satzZuNachricht(satz: Satz): SatzAlsNachricht {
  return {
    id: satz.nachrichtId,
    channel_id: satz.kanalId,
    author_id: satz.autorId,
    content: satz.inhalt,
    nonce: null,
    created_at: satz.erstelltAm,
    edited_at: satz.bearbeitetAm,
    deleted_at: satz.geloescht ? (satz.bearbeitetAm ?? satz.erstelltAm) : null,
    reply_to_id: satz.antwortAufId ?? null,
    krypto_id: satz.kryptoId ?? undefined,
    attachments: verschluesselteAnhaenge(satz.anhaenge ?? [])
  };
}
