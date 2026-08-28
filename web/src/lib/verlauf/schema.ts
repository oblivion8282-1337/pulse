/**
 * Form des lokalen Verlaufs — importfrei, damit Nodes Testlaeufer sie sieht.
 *
 * EIGENE Datenbank, nicht die der Identitaet (`pulse-identity`): deren
 * Version wurde nie erhoeht, es gibt also kein erprobtes Migrationsverfahren,
 * und ein Fehlgriff dort kostet den Geraeteschluessel und damit die Anmeldung.
 */
export const DB_NAME = 'pulse-verlauf';
/**
 * FASSUNG 2 (Etappe E): der Speicher `anhaenge` ist dazugekommen. Eine
 * Fassungsnummer war hier zwingend und ist NICHT dieselbe Frage wie beim
 * Nutzlast-Format (`krypto/nachrichtNutzlast.ts`, wo die Nummer bewusst
 * STEHEN bleibt): IndexedDB erzwingt zwar kein Feldschema — ein neues Feld
 * in einem Satz braucht deshalb keinen Bump —, aber ein neuer OBJEKTSPEICHER
 * laesst sich ausschliesslich in `onupgradeneeded` anlegen, und das laeuft
 * nur bei einer hoeheren Nummer. Ohne den Bump wuerde jeder Zugriff auf
 * `anhaenge` mit `NotFoundError` scheitern.
 *
 * Bestandsdaten wandern nicht: `nachrichten` bleibt unveraendert, `anhaenge`
 * faengt leer an. Ein Anhang, den dieses Geraet vor der Umstellung empfangen
 * haette, kann es nicht geben — der verschluesselte Weg ist mit diesem
 * Speicher zusammen entstanden.
 */
export const DB_VERSION = 2;
export const STORE_NACHRICHTEN = 'nachrichten';
/** Entschluesselte Anhang-Bytes (Etappe E) — s. `anhangSchema` unten. */
export const STORE_ANHAENGE = 'anhaenge';
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

/**
 * Die ENTSCHLUESSELTEN Bytes eines verschluesselten Anhangs — eine Zeile in
 * `STORE_ANHAENGE`, Primaerschluessel `id` (die Anhang-Kennung des Servers).
 *
 * **Warum die Bytes lokal liegen muessen und nicht nur die Angaben:** das
 * Recht, den Klumpen vom Server zu holen, haengt an der eigenen offenen
 * Zustellung (`postfach_anhaenge.py::darf_anhang_abrufen`), und der Klumpen
 * selbst faellt, sobald die LETZTE Zustellung quittiert ist
 * (`postfach_pflege.py::sweep_verwaiste_anhaenge`). Nach der eigenen Quittung
 * gibt es also weder ein Abrufrecht noch — kurz darauf — etwas abzurufen.
 * Der Absender hat ueberhaupt nie eine Zustellung an sich selbst und koennte
 * seinen eigenen Anhang nie wieder holen. Wer hier nur Schluessel und Namen
 * ablegte, haette nach dem naechsten Neustart die Beschriftung eines Bildes,
 * das niemand mehr oeffnen kann.
 *
 * `kanalId` steht dabei, damit ein spaeteres Loeschen eines Gespraechs die
 * Bytes mitnehmen kann.
 */
export type AnhangBytes = {
  id: string;
  kanalId: string;
  /** Klartext-Bytes der Datei. */
  daten: Blob;
  /** Klartext-Bytes des Vorschaubildes, falls es eines gab. */
  vorschau: Blob | null;
};
