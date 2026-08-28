/**
 * Form des lokalen Verlaufs — importfrei, damit Nodes Testlaeufer sie sieht.
 *
 * EIGENE Datenbank, nicht die der Identitaet (`pulse-identity`): deren
 * Version wurde nie erhoeht, es gibt also kein erprobtes Migrationsverfahren,
 * und ein Fehlgriff dort kostet den Geraeteschluessel und damit die Anmeldung.
 */
export const DB_NAME = 'pulse-verlauf';
export const DB_VERSION = 1;
export const STORE_NACHRICHTEN = 'nachrichten';
/** Nach Kanal, damit ein Kanal am Stueck gelesen werden kann. */
export const INDEX_KANAL = 'nach_kanal';

/** Ein Satz des lokalen Nachrichtenverlaufs — eine Zeile in `STORE_NACHRICHTEN`. */
export type Satz = {
  /** Primaerschluessel (`sortierSchluessel`) — sortiert lexikografisch richtig. */
  schluessel: string;
  kanalId: string;
  nachrichtId: string;
  autorId: string;
  inhalt: string;
  erstelltAm: string;
  bearbeitetAm: string | null;
  /** Weiches Loeschen (Grabstein) — die Zeile bleibt, der Inhalt gilt als weg. */
  geloescht: boolean;
  anhaenge: unknown[];
  /** Nachrichten-ID der Nachricht, auf die geantwortet wird — `null` ohne
   *  Antwortbezug. Neu (kein `DB_VERSION`-Bump noetig): IndexedDB erzwingt
   *  kein festes Feldschema, aeltere Zeilen ohne dieses Feld lesen sich beim
   *  Zugriff einfach als `undefined`/fehlend — `satzZuNachricht` behandelt
   *  das wie `null`. */
  antwortAufId: string | null;
  /** Nur bei einer EMPFANGENEN verschluesselten Nachricht gesetzt: die vom
   *  Autor gewaehlte, geraeteuebergreifende ID (`Message.krypto_id`,
   *  `krypto/nachrichtNutzlast.ts`). Muss ueber einen Neustart hinweg
   *  erhalten bleiben, sonst loest eine nach dem Neuladen eintreffende
   *  Antwort auf eine aeltere, schon lokal abgelegte Nachricht nicht mehr
   *  auf. */
  kryptoId: string | null;
};
