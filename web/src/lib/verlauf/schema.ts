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
 *
 * FASSUNG 3 (Medien-Nachziehen, Stufe B1, Plan
 * `docs/plans/2026-09-08-medien-nachziehen.md`): der Speicher `medien` ist
 * dazugekommen — derselbe Bump-Zwang wie bei Fassung 2 (neuer
 * Objektspeicher, nur in `onupgradeneeded` anlegbar). Er ist ein reiner
 * ABLEGER: jede Zeile ist aus dem Satz in `nachrichten` wiederherstellbar,
 * der Nachzug (`medienNachzug.ts`) fuellt ihn zusaetzlich mit
 * Server-Metadaten, die lokal nie als Satz anlagen (alte Uploads, ferne
 * Kanaele). Bestandsdaten wandern nicht: der Index baut sich beim ersten
 * Schreiben ueber `verlaufPutSaetze` selbst.
 */
export const DB_VERSION = 3;
export const STORE_NACHRICHTEN = 'nachrichten';
/** Entschluesselte Anhang-Bytes (Etappe E) — s. `anhangSchema` unten. */
export const STORE_ANHAENGE = 'anhaenge';
/** Geraeteweiter Medien-Index (Stufe B1) — s. `MedienZeile` unten. */
export const STORE_MEDIEN = 'medien';
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
  /** E2EE-Nachricht — überlebt im Satz, damit die Aktions-Gates auch nach
   *  einem Reload richtig verzweigen (`Message.verschluesselt`). Alte Sätze
   *  ohne dieses Feld lesen sich als `false`. */
  verschluesselt: boolean;
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
  /**
   * Reaktionen auf eine VERSCHLUESSELTE Nachricht (Uebergabe P1.5): je Zeile
   * ein (Autor, Emoji)-Paar, gepflegt ueber Reaktions-Umschlaege
   * (`krypto/reaktionen.ts` rechnet Merge und Anzeige-Form). Bewusst NICHT
   * die Server-Aggregate einer Klartext-Nachricht — die haben keine Autoren
   * und liessen sich nicht idempotent zusammenfuehren; fuer sie bleibt der
   * Server die Wahrheit. Kein `DB_VERSION`-Bump (neues FELD, s. `antwortAufId`);
   * Altsaetze ohne das Feld lesen sich als „keine Reaktionen".
   */
  reaktionen?: { emoji: string; userId: string }[];
  /**
   * Bughunt 2026-08-29 (Befund 1): welches Konto diesen Satz geschrieben hat
   * (`verlauf/konto.ts::aktuellesKonto`, dieselbe Cloud-User-ID wie
   * `auth.svelte.ts::_enforceDeviceOwner`). `pulse-verlauf` ist pro
   * Browserprofil global, nicht pro Konto — ohne dieses Feld sah ein zweites
   * Konto auf demselben Geraet (z. B. ueber die lokale Suche) den kompletten
   * Bestand des ersten, samt Gespraechspartnern und Zeitpunkten.
   *
   * Kein `DB_VERSION`-Bump: ein neues FELD in einem Satz braucht keinen
   * neuen Objektspeicher, s. `antwortAufId` oben und den Modulkopf zu
   * `DB_VERSION`. Bestandsdaten von vor diesem Fix haben das Feld nicht —
   * `verlauf/kontoFilter.ts::gehoertZuKonto` behandelt das als „gehoert zu
   * keinem Konto" (fail-closed), nicht als Treffer fuer irgendwen.
   */
  kontoId: string;
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

/**
 * Eine Zeile des geraeteweiten Medien-Index (Stufe B1) — Primaerschluessel
 * `id` (die Anhang-Snowflake des Servers, als String). Ein ABLEGER, kein
 * zweites Archiv: alles hier steckt entweder im Satz (`nachrichten`) oder
 * kommt vom Nachzug-Endpunkt (`GET /meine-anhaenge`) — geloescht werden kann
 * eine Zeile, indem man sie vergisst; der naechste Schreibweg baut sie neu.
 *
 * Zwei Wege fuellen den Speicher (beide enden in `verlauf/db.ts`):
 * `medienZeilenAusSatz` beim Ablegen eines Satzes (kennt Schluessel und
 * Namen auch bei E2EE) und `medienNachzug.ts::zeileAusServerAnhang` fuer
 * Server-Metadaten (bei E2EE ohne Namen und ohne Schluessel — die sieht der
 * Server bewusst nicht, `routes/meine_anhaenge.py`). `kontoId` ist Pflicht:
 * `kontoFilter.ts`-Regeln gelten, der Speicher ist pro Browserprofil
 * global, nicht pro Konto.
 */
export type MedienZeile = {
  id: string;
  kontoId: string;
  kanalId: string;
  /** Wer den Anhang hochgeladen hat. Beim Nachzug immer das eigene Konto
   *  (der Endpunkt liefert nur eigene Uploads) — deshalb traegt diese Zeile
   *  dieselbe ID wie `kontoId`. */
  autorId: string;
  erstelltAm: string;
  /** NULL bei E2EE-Server-Zeilen — der Name lebt im verschluesselten
   *  Umschlag; lokale Saetze ergaenzen ihn. */
  dateiname: string | null;
  mime: string | null;
  size: number;
  verschluesselt: boolean;
  hatThumb: boolean;
  /** Dateischluessel (Base64) — nur von lokalen Saetzen, NIE vom Server. */
  schluessel: string | null;
  /** True, sobald die Bytes im eigenen Cloud-Laufwerk liegen (§11.1) — der
   *  Objektspeicher antwortet dann 410, der Klient liest lokal. */
  laufwerkVerteilt: boolean;
};

/** Die Index-Zeilen der Anhaenge EINES Satzes — der Zweit-Schreibweg in
 *  `verlaufPutSaetze`. Reine Rechnung (importfrei, Node-testbar). Fail-closed
 *  wie `zuSatz`: ein Anhang ohne kennbaren `id`-String wird uebersprungen,
 *  statt Muell in den Index zu legen. Grabstein-Saetze liefern bewusst keine
 *  Zeilen — ein geloeschtes Medium ist keins mehr, und der Server liefert
 *  seine Zeile ebenfalls nicht mehr. */
export function medienZeilenAusSatz(satz: Satz): MedienZeile[] {
  if (satz.geloescht || !Array.isArray(satz.anhaenge)) return [];
  const zeilen: MedienZeile[] = [];
  for (const a of satz.anhaenge) {
    if (typeof a !== 'object' || a === null) continue;
    const roh = a as Record<string, unknown>;
    if (typeof roh.id !== 'string' || roh.id === '') continue;
    zeilen.push({
      id: roh.id,
      kontoId: satz.kontoId,
      kanalId: satz.kanalId,
      autorId: satz.autorId,
      erstelltAm: satz.erstelltAm,
      dateiname: typeof roh.filename === 'string' ? roh.filename : null,
      mime: typeof roh.mime === 'string' ? roh.mime : null,
      size: typeof roh.size === 'number' ? roh.size : 0,
      verschluesselt: roh.verschluesselt === true,
      hatThumb:
        roh.thumb_schluessel != null ||
        (roh.thumb_url != null && roh.thumb_url !== ''),
      schluessel: typeof roh.schluessel === 'string' ? roh.schluessel : null,
      // Der Satz kennt die Server-Spalte nicht — `true` kann hier nur der
      // Nachzug schreiben, der an der Overlap-Abbruchgrenze endet. Bis dahin
      // gilt: lokal unbekannt (Anzeige-Frage, B2).
      laufwerkVerteilt: false
    });
  }
  return zeilen;
}
