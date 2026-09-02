/**
 * Der einmalige Uebergang des Pickle-Schluessels: vorhandenen Zustand mit dem
 * ALTEN Schluessel (abgeleitet aus dem Ed25519-Anmeldeschluessel) auftauen,
 * mit dem NEUEN (aus dem krypto-eigenen Geheimnis) wieder einfrieren, die
 * Umstellung vermerken. Ab dann gilt nur noch der neue.
 *
 * Die Rechnung und die Begruendung des Alles-oder-nichts stehen importfrei in
 * `pickelUebergangPlan.ts`; hier ist nur die Verkabelung an IndexedDB und den
 * Krypto-Kern.
 *
 * **Warum das Schreiben in EINER Transaktion liegt:** Marke, Geheimnis und
 * alle umgefrorenen Eintraege gehoeren zusammen. Faellt irgendetwas aus,
 * lehnt die Transaktion als Ganzes ab — nichts ist geschrieben, nichts
 * geloescht, die Marke steht weiter auf „offen", und der naechste Start
 * versucht es unveraendert erneut. Ein halb umgestellter Speicher waere
 * dagegen nicht zu reparieren: dem einzelnen Eintrag sieht niemand an, mit
 * welchem Schluessel er eingefroren wurde.
 *
 * **Was diese Stelle NICHT leistet — bewusst und ausgesprochen.** Sie haelt
 * waehrend des Uebergangs keine Sitzungssperren (`sperren.ts`), und sie kann
 * es nicht: die Sperren gelten je Geraetepaar, und welche Paare es gibt,
 * steht erst im Speicher, den sie gerade liest. Ein zweiter Tab, der in genau
 * diesem Moment eine Sitzung mit dem alten Schluessel sichert, schriebe sie
 * NACH dem Markenwechsel zurueck und machte sie damit unlesbar. Das Fenster
 * ist die Dauer einer IndexedDB-Transaktion, und der Aufrufer legt es an den
 * Anfang des Anmeldewegs, wo noch kein Sende- oder Abholzyklus laeuft
 * (`veroeffentlichen.ts`). Geschlossen ist es damit nicht, nur klein — und
 * mit `E2E_DMS_ENABLED = false` gibt es heute ueberhaupt keinen zweiten
 * Schreiber.
 */
import {
  Identitaet,
  Sitzung,
  Gruppensitzung,
  Gruppenempfang
} from '../../../../krypto/pulse-krypto/pkg/pulse_krypto.js';
import { STORE_NAME, openIdentityDb } from '../identity/idb-shared';
import { altpickelschluesselWennVorhanden, sicherstellenWasm } from './account.svelte';
import {
  IDB_KEY_PICKELGEHEIMNIS,
  IDB_KEY_PICKELMARKE,
  pickelgeheimnisErzeugen,
  pickelgeheimnisLesen,
  pickelmarkeLesen
} from './geraeteGeheimnis';
import { pickelschluesselAusGeheimnis } from './pickelschluessel';
import {
  MARKE_KRYPTOGEHEIMNIS,
  markeDeuten,
  umschreibenPlanen,
  type Pickleart,
  type Speichereintrag
} from './pickelUebergangPlan';

/** Taut mit dem alten Schluessel auf und friert mit dem neuen wieder ein.
 *  Synchron — es laeuft innerhalb der IndexedDB-Transaktion, und die
 *  committet, sobald die Warteschlange ohne offene Anfrage leerlaeuft. Ein
 *  `await` an dieser Stelle wuerde sie unter der Hand schliessen. */
function umfrieren(art: Pickleart, gefroren: string, alt: Uint8Array, neu: Uint8Array): string {
  switch (art) {
    case 'konto':
      return Identitaet.auftauen(gefroren, alt).einfrieren(neu);
    case 'sitzung':
      return Sitzung.auftauen(gefroren, alt).einfrieren(neu);
    case 'gruppensitzung':
      return Gruppensitzung.auftauen(gefroren, alt).einfrieren(neu);
    case 'gruppenempfang':
      return Gruppenempfang.auftauen(gefroren, alt).einfrieren(neu);
  }
}

/**
 * Stellt sicher, dass der Pickle-Schluessel aus dem krypto-eigenen Geheimnis
 * kommt. Ist er das schon, kehrt die Funktion sofort zurueck.
 *
 * **Muss VOR dem ersten Zugriff auf eingefrorenen Zustand laufen** — nicht,
 * weil sonst etwas kaputtginge (bis zum Markenwechsel gilt weiterhin der
 * alte Schluessel, alles funktioniert), sondern weil der alte Schluessel
 * verschwindet, sobald der Anmeldeschluessel geloescht wird. Wer bis dahin
 * nicht umgestellt hat, kann es nie mehr.
 *
 * **Wirft laut statt still zu heilen.** Zwei der drei Aufrufer von
 * `veroeffentlicheSchluessel()` fangen Fehler ab und ignorieren sie
 * (`issue-flow.ts`, `cert-rotation.svelte.ts`) — dort verschwaende der Wurf.
 * Nur der dritte reicht ihn weiter: `kopplung/empfangen.ts::
 * kopplungEinloesen` ruft ungefangen, ein gescheiterter Uebergang laesst die
 * Einloesung dort also sichtbar fehlschlagen. Fuer die beiden anderen steht
 * deshalb zusaetzlich eine Meldung auf der Konsole: sie ist die
 * einzige Spur, die ein gescheiterter Uebergang sonst hinterliesse. Der
 * eigene Text nennt nur die Fehlerart. Der angehaengte Fehler kann aus
 * IndexedDB oder dem Krypto-Kern kommen; der Krypto-Kern traegt nichts
 * Geheimes hinaus (nachgesehen: `identitaet.rs::auftauen` wirft die flache
 * Variante `KryptoFehler::AuftauenFehlgeschlagen`, ohne den Pickle).
 */
export async function pickelUebergangSicherstellen(): Promise<void> {
  const db = await openIdentityDb();
  if (markeDeuten(await pickelmarkeLesen(db)) === 'schon_umgestellt') {
    db.close();
    return;
  }

  await sicherstellenWasm();

  // Ein vorhandenes Geheimnis wiederverwenden: es kann aus einem zuvor
  // abgelehnten Versuch stammen (Transaktion abgelehnt, Marke nicht gesetzt).
  // Ein zweites zu erzeugen waere nicht falsch, aber es liesse einen
  // Waisenwert liegen, den spaeter niemand mehr zuordnen kann.
  const geheimnis = (await pickelgeheimnisLesen(db)) ?? (await pickelgeheimnisErzeugen());
  const neu = await pickelschluesselAusGeheimnis(geheimnis);
  // `null`, wenn dieses Geraet keinen Anmeldeschluessel (mehr) hat. Das ist
  // KEIN Fehler, solange es auch nichts Eingefrorenes gibt — genau der
  // Erstlauf eines frischen Geraets, der ohne Zutun schon den neuen Weg
  // faehrt. Gibt es dagegen Zustand, ist es der Totalverlust-Fall, und die
  // Planung unten wirft.
  const alt = await altpickelschluesselWennVorhanden();

  try {
    await schreibeUebergang(db, geheimnis, alt, neu);
  } catch (fehler) {
    console.error('[krypto] Pickle-Uebergang fehlgeschlagen — nichts geschrieben:', fehler);
    throw fehler;
  }
  db.close();
}

/** Liest den ganzen Store, plant das Umfrieren und schreibt Plan, Geheimnis
 *  und Marke — alles in EINER Transaktion, s. Modulkopf. */
function schreibeUebergang(
  db: IDBDatabase,
  geheimnis: CryptoKey,
  alt: Uint8Array | null,
  neu: Uint8Array
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const speicher = tx.objectStore(STORE_NAME);
    // Beide Anfragen laufen in der Reihenfolge ihrer Abgabe und liefern beide
    // in aufsteigender Schluesselreihenfolge — wenn `werte` da sind, sind es
    // die `schluessel` auch, und die Indizes passen zueinander.
    const schluessel = speicher.getAllKeys();
    const werte = speicher.getAll();

    werte.onsuccess = () => {
      try {
        const eintraege: Speichereintrag[] = schluessel.result.map((k, i) => ({
          schluessel: String(k),
          wert: werte.result[i]
        }));
        const plan = umschreibenPlanen(eintraege, (art, gefroren) => {
          if (!alt) throw new Error('PICKELUEBERGANG_OHNE_ALTSCHLUESSEL');
          return umfrieren(art, gefroren, alt, neu);
        });
        for (const eintrag of plan) speicher.put(eintrag.wert, eintrag.schluessel);
        speicher.put(geheimnis, IDB_KEY_PICKELGEHEIMNIS);
        // Zuletzt: sie ist die Zusage, dass alles darueber steht.
        speicher.put(MARKE_KRYPTOGEHEIMNIS, IDB_KEY_PICKELMARKE);
      } catch (fehler) {
        // Ausdruecklich abbrechen statt die Transaktion auslaufen zu lassen:
        // ohne `abort()` wuerden die bereits abgesetzten `put`s committen.
        try {
          tx.abort();
        } catch {
          /* schon abgebrochen */
        }
        reject(fehler);
      }
    };
    werte.onerror = () => reject(werte.error);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('PICKELUEBERGANG_ABGEBROCHEN'));
    tx.oncomplete = () => resolve();
  });
}
