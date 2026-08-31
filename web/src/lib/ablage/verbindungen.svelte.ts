/**
 * Verwaltet die verbundenen Ablage-Anbieter eines Geräts — gerätelokal in
 * IndexedDB, nie auf dem Server. Jede Verbindung trägt die Zugangsdaten
 * (Token, Passwort, Endpoint) und den Ablage-Hauptschlüssel für die Kanäle,
 * die über diese Ablage laufen.
 *
 * Der Server sieht von diesem Store NICHTS — weder Verbindungen noch
 * Schlüssel.
 *
 * **Kontowechsel am selben Gerät.** Der Kopf behauptete bis zum 2026-09-01,
 * `_enforceDeviceOwner` räume diesen Store weg. Das tat er nie — die
 * Datenbank kommt in `stores/auth.svelte.ts` überhaupt nicht vor. Ein
 * zweites Konto am selben Fenster las damit die Verbindungen des Vorgängers,
 * samt OAuth-Token, S3-Geheimnis, Freigabe-Link und Ablage-Hauptschlüssel.
 *
 * Behoben nicht durch Wegräumen, sondern wie beim lokalen Verlauf (Bughunt
 * 2026-08-29, Befund 1): jede Verbindung trägt seither `kontoId`, und
 * `laden()` zeigt nur die des GERADE angemeldeten Kontos. Der Grund für diese
 * Wahl ist derselbe, aus dem der Verlauf vom Wächter ausgenommen ist — der
 * Ablage-Hauptschlüssel ist die EINZIGE Kopie: ohne ihn ist alles, was auf
 * dem Laufwerk liegt, für immer unlesbar. Ein Löschen bei jedem
 * Kontowechsel, auch einem versehentlichen, wäre endgültiger Datenverlust.
 *
 * Eine Verbindung OHNE `kontoId` (Bestand von vor diesem Fix) gehört bewusst
 * zu KEINEM Konto — fail-closed statt einer Ratenwette auf den aktuellen
 * Nutzer. Sie ist damit unsichtbar, aber nicht verloren: das
 * Wiederherstellungs-Päckchen (E4) bringt Verbindungen und Schlüssel zurück.
 *
 * Der Store ist bewusst schmal: Er verwaltet Verbindungen, er verschlüsselt
 * nichts selbst — das machen die Adapter und der DateiSpeicher.
 */

import { DateiSpeicher } from './dateispeicher.ts';
import type { AblageAdapter } from './adapter';
import { aktuellesKonto } from '../verlauf/konto';
import { gehoertZuKonto } from '../verlauf/kontoFilter';
import type { Zugang } from './oauth.ts';
import {
  SYNC_ORDNER_VERBINDUNGS_ID,
  bestimmeSyncOrdnerHauptschlüssel,
  base64ZuBytes
} from './syncOrdnerSchluessel.ts';

export type AblageAnbieterArt =
  | 'dropbox'
  | 'onedrive'
  | 'gdrive'
  | 'nextcloud'
  | 'sync_ordner'
  | 's3';

export interface AblageVerbindung {
  id: string;
  anbieter: AblageAnbieterArt;
  /** Anzeigename, z. B. „Dropbox · pulse-probe" */
  name: string;
  /** Provider-spezifische Konfiguration (Token, Endpoint, Pfad …).
   *  Struktur je Anbieter — siehe die jeweiligen Adapter-Module. */
  konfiguration: Record<string, string>;
  /** Der Ablage-Hauptschlüssel (Base64) — verschlüsselt Dateien und Verzeichnis. */
  hauptschlüsselB64: string;
  verbundenAm: string;
  /** Das Konto, dem diese Verbindung gehört (`verlauf/konto.ts`).
   *  Fehlt sie, gehört die Verbindung zu keinem Konto — siehe Modulkopf. */
  kontoId?: string | null;
  /**
   * Die letzte Auffrischung des OAuth-Zugangs (Dropbox/Google Drive) ist
   * endgültig gescheitert — s. `oauth.ts::AnmeldungAbgelaufenFehler`. Wird
   * von `Speicher*`-Komponenten (Aufgabe 5) periodisch nachgestellt und bei
   * einer erfolgreichen Auffrischung wieder gelöscht (`schreibeAufgefrischtenZugang`).
   * Anbieter ohne Auffrisch-Weg (Nextcloud-App-Passwort, Sync-Ordner, S3)
   * setzen dieses Feld nie.
   */
  anmeldungAbgelaufen?: boolean;
  /**
   * Zeitpunkt der letzten erfolgreichen Sicherung — `null`/fehlend heisst
   * „noch nie". Schreibt heute NIEMAND: der Nachzieher (`nachzieher.ts`)
   * kennt nur einzelne Kanäle, keine Ablage-Verbindung, und es läuft noch
   * kein Kanal über eine Verbindung aus diesem Store (folgt mit der
   * Kanal-Anbindung). Die Speicher-Zeile zeigt bis dahin ehrlich „noch
   * nichts gesichert" statt ein erfundenes Datum.
   */
  zuletztGesichertAm?: string | null;
}

const DB_NAME = 'pulse-ablage-verbindungen';
const DB_VERSION = 1;
const STORE = 'verbindungen';

let db: IDBDatabase | null = null;

async function öffneDb(): Promise<IDBDatabase> {
  if (db) return db;
  db = await new Promise<IDBDatabase>((resolve, reject) => {
    const anfrage = indexedDB.open(DB_NAME, DB_VERSION);
    anfrage.onupgradeneeded = () => {
      anfrage.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    anfrage.onsuccess = () => resolve(anfrage.result);
    anfrage.onerror = () => reject(anfrage.error);
  });
  return db;
}

async function leseAlle(): Promise<AblageVerbindung[]> {
  const d = await öffneDb();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, 'readonly');
    const anfrage = tx.objectStore(STORE).getAll();
    anfrage.onsuccess = () => resolve(anfrage.result as AblageVerbindung[]);
    anfrage.onerror = () => reject(anfrage.error);
  });
}

async function schreibe(v: AblageVerbindung): Promise<void> {
  const d = await öffneDb();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(v);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function entferne(id: string): Promise<void> {
  const d = await öffneDb();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---------------------------------------------------------------------------

export class AblageVerbindungsStore {
  verbindungen = $state<AblageVerbindung[]>([]);
  geladen = $state(false);

  async laden(): Promise<void> {
    const alle = await leseAlle();
    const konto = aktuellesKonto();
    // Ohne angemeldetes Konto gibt es nichts zu zeigen — dieselbe
    // fail-closed-Regel wie im Verlauf, nicht ein Sonderfall.
    this.verbindungen =
      konto === null
        ? []
        // `gehoertZuKonto` verlangt das Feld ausdrücklich — hier steht es
        // absichtlich als optional, weil die Aufrufer es nicht setzen: den
        // Stempel vergibt `hinzufügen()` aus dem angemeldeten Konto, damit
        // keine Aufrufstelle ihn vergessen kann.
        : alle.filter((v) => gehoertZuKonto({ kontoId: v.kontoId ?? null }, konto));
    this.geladen = true;
  }

  verbindung(id: string): AblageVerbindung | undefined {
    return this.verbindungen.find((v) => v.id === id);
  }

  async hinzufügen(v: AblageVerbindung): Promise<void> {
    // Der Stempel entsteht beim Schreiben aus dem GERADE angemeldeten Konto
    // — dieselbe Stelle und derselbe Grund wie bei `verlauf/db.ts`.
    const mitKonto: AblageVerbindung = { ...v, kontoId: v.kontoId ?? aktuellesKonto() };
    await schreibe(mitKonto);
    this.verbindungen = [...this.verbindungen, mitKonto];
  }

  async entfernen(id: string): Promise<void> {
    await entferne(id);
    this.verbindungen = this.verbindungen.filter((v) => v.id !== id);
  }

  /**
   * Schreibt eine Teiländerung an einer bestehenden Verbindung fest —
   * gemeinsamer Kern für `markiereAnmeldungAbgelaufen` und
   * `schreibeAufgefrischtenZugang`. Eine unbekannte Id wird still
   * ignoriert: die Verbindung kann inzwischen entfernt worden sein, während
   * eine Zustandsprüfung noch lief.
   */
  private async patch(id: string, aenderung: Partial<AblageVerbindung>): Promise<void> {
    const bestehend = this.verbindung(id);
    if (!bestehend) return;
    const aktualisiert: AblageVerbindung = { ...bestehend, ...aenderung };
    await schreibe(aktualisiert);
    this.verbindungen = this.verbindungen.map((v) => (v.id === id ? aktualisiert : v));
  }

  /** Die Auffrischung des Zugangs ist endgültig gescheitert (Aufgabe 5, Punkt 4). */
  async markiereAnmeldungAbgelaufen(id: string): Promise<void> {
    await this.patch(id, { anmeldungAbgelaufen: true });
  }

  /**
   * Schreibt einen erfolgreich aufgefrischten Zugang zurück — sonst ist er
   * beim nächsten Start wieder weg und jede Sitzung beginnt erneut mit dem
   * alten, bereits abgelehnten Token. Ein fehlendes `nachspieleToken` im
   * neuen Zugang behält das bisherige (manche Anbieter geben beim Auffrischen
   * kein neues Nachspiel-Token zurück).
   */
  async schreibeAufgefrischtenZugang(id: string, zugang: Zugang): Promise<void> {
    const bestehend = this.verbindung(id);
    if (!bestehend) return;
    await this.patch(id, {
      konfiguration: {
        ...bestehend.konfiguration,
        zugangsToken: zugang.zugangsToken,
        ...(zugang.nachspieleToken !== undefined ? { nachspieleToken: zugang.nachspieleToken } : {}),
      },
      anmeldungAbgelaufen: false,
    });
  }

  /** Baut einen DateiSpeicher für eine Verbindung. */
  async dateiSpeicherFür(verbindungId: string): Promise<DateiSpeicher | null> {
    const v = this.verbindung(verbindungId);
    if (!v) return null;
    const hauptschlüssel = base64ZuBytes(v.hauptschlüsselB64);
    const adapter = await adapterFür(v);
    return new DateiSpeicher(adapter, `ablage/${v.id}`, hauptschlüssel);
  }

  /**
   * Der Ablage-Hauptschlüssel für den (einzigen) Sync-Ordner dieses Geräts —
   * eine Verbindung mit fester ID, weil die Speicher-Einstellungen
   * (`SpeicherSektion.svelte`) bislang nur einen Ordner gleichzeitig
   * verwalten. Erster Aufruf legt sie an, jeder weitere
   * findet sie wieder (Rechnung dazu: `syncOrdnerSchluessel.ts`).
   *
   * Kein Umzug aus dem frueheren `localStorage['pulse-ablage-hauptschluessel']`:
   * die Ablage lief bisher ausschliesslich auf Testgeräten, es gibt also
   * keine echte Datei, die dadurch unlesbar würde. Ein Umzugscode für Daten,
   * die nirgends real liegen, wäre ungeprüfter Ballast — bewusste
   * Entscheidung, kein Versehen.
   */
  async hauptschlüsselFürSyncOrdner(): Promise<Uint8Array> {
    if (!this.geladen) await this.laden();
    const bestehend = this.verbindung(SYNC_ORDNER_VERBINDUNGS_ID);
    const zufallsBytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const ergebnis = bestimmeSyncOrdnerHauptschlüssel(bestehend, zufallsBytes);
    if (ergebnis.istNeu) {
      await this.hinzufügen({
        id: SYNC_ORDNER_VERBINDUNGS_ID,
        anbieter: 'sync_ordner',
        name: 'Sync-Ordner',
        konfiguration: {},
        hauptschlüsselB64: ergebnis.hauptschlüsselB64,
        verbundenAm: new Date().toISOString()
      });
    }
    return ergebnis.hauptschlüssel;
  }
}

export const ablageVerbindungen = new AblageVerbindungsStore();

// ---------------------------------------------------------------------------

/**
 * Baut den Laufzeit-Adapter für eine gespeicherte Verbindung — exportiert,
 * damit die Speicher-Einstellungen (Aufgabe 5) denselben Adapter für die
 * periodische Zustandsprüfung verwenden können, den ein echter Kanal-Schreiber
 * auch nähme.
 *
 * `sync_ordner` fehlt absichtlich: die File-System-Access-API gibt ein
 * Verzeichnis-Handle nur aus einer Nutzer-Geste heraus (Ordner-Dialog) frei,
 * es lässt sich nicht aus gespeicherten Werten wiederherstellen. Ein
 * Sync-Ordner braucht deshalb immer eine neue Auswahl im Verbinden-Dialog.
 */
export async function adapterFür(v: AblageVerbindung): Promise<AblageAdapter> {
  switch (v.anbieter) {
    case 's3': {
      const { s3Adapter } = await import('./s3.ts');
      return s3Adapter({
        wirt: v.konfiguration.wirt,
        region: v.konfiguration.region,
        eimer: v.konfiguration.eimer,
        praefix: v.konfiguration.praefix,
        schluessel: v.konfiguration.schluessel,
        geheimnis: v.konfiguration.geheimnis,
      });
    }
    case 'dropbox': {
      const { dropboxAdapter } = await import('./dropbox.ts');
      return dropboxAdapter({
        zugangsToken: v.konfiguration.zugangsToken,
        ordner: v.konfiguration.ordner ?? '',
        nachspieleToken: v.konfiguration.nachspieleToken,
        kundenId: v.konfiguration.kundenId,
        zugangAufgefrischt: (zugang) => {
          void ablageVerbindungen.schreibeAufgefrischtenZugang(v.id, zugang);
        },
      });
    }
    case 'gdrive': {
      const { gdriveAdapter } = await import('./gdrive.ts');
      return gdriveAdapter({
        zugangsToken: v.konfiguration.zugangsToken,
        ordner: v.konfiguration.ordner ?? '',
        nachspieleToken: v.konfiguration.nachspieleToken,
        kundenId: v.konfiguration.kundenId,
        kundenGeheimnis: v.konfiguration.kundenGeheimnis,
        zugangAufgefrischt: (zugang) => {
          void ablageVerbindungen.schreibeAufgefrischtenZugang(v.id, zugang);
        },
      });
    }
    case 'nextcloud': {
      const { webdavAdapter } = await import('./webdav.ts');
      return webdavAdapter({
        basis: v.konfiguration.basis,
        ordner: v.konfiguration.ordner ?? '',
        benutzer: v.konfiguration.benutzer,
        passwort: v.konfiguration.passwort,
      });
    }
    default:
      throw new Error(`Kein Adapter für Anbieter: ${v.anbieter}`);
  }
}

// Re-export für Komponenten
export type { DateiSpeicher };
