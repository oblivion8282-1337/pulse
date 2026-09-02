/**
 * Der Verlauf eines Ordner-Kanals aus den Server-Dateien selbst — die
 * zweite, neuere Quelle neben `kanalLeseweg.ts::kanalVerlaufLesen` (der die
 * Nachrichten direkt vom Nextcloud-Laufwerk des Erstellers liest). Diese
 * Datei liest stattdessen den ABLAGE-ORDNER, den der Server pro Kanal
 * fuehrt (`api/ablageKanalOrdner.ts`-Modulkopf): jeder Nachrichten-Umschlag
 * liegt dort als eigene Datei, in derselben Umschlag-Form wie das Postfach
 * (`PostfachZustellung`) — geoeffnet wird deshalb mit demselben
 * `zustellungOeffnen`, das auch der Postfach-Zyklus benutzt
 * (`krypto/empfangen.ts`).
 *
 * **Nichts wird quittiert — es gibt keine Zustellung.** Der Ordner ist der
 * dauerhafte Bestand des Kanals, keine Abholschlange; eine Datei bleibt
 * liegen, damit sie beim naechsten Lesen (auf diesem oder einem anderen
 * Geraet) erneut zur Verfuegung steht. Genau deshalb duerfen einzelne
 * Dateien beim Oeffnen scheitern (Sitzung fehlt, Netzfehler, kaputter
 * Inhalt), ohne dass der ganze Lesevorgang abbricht — sie werden
 * uebersprungen und gezaehlt, nie geworfen.
 *
 * **`null` heisst „kein Ordner-Kanal"**, nicht „leer": `ordnerListe` wirft
 * `ApiError(404)` dafuer (s. dort) — das uebersetzt diese Funktion in den
 * Rueckgabewert `null`, das Signal fuer den Aufrufer
 * (`components/chat/ablageKanalVerlauf.ts`), stattdessen den aelteren
 * direkten Laufwerksweg zu versuchen. Ein leerer, aber echter Ordner-Kanal
 * liefert `[]`.
 *
 * **Dieselbe Konto-Sperre wie der Postfach-Zyklus** (`krypto/sperren.ts`,
 * `mitKontosperre`): `zustellungOeffnen` kann einen eingehenden
 * Sitzungsaufbau ausloesen, der einen Einmalschluessel auf dem
 * `Identitaet`-Objekt verbraucht (s. `krypto/empfangen.ts`-Modulkopf). Liefe
 * dieser Lesevorgang OHNE die Sperre neben einem laufenden Postfach-Zyklus,
 * koennten beide denselben Schluessel doppelt verbrauchen. Aus demselben
 * Grund wird `ident` bei einem gescheiterten Konto-Sichern
 * (`KontoSicherungFehlgeschlagen`) frisch aus IndexedDB nachgeladen, statt
 * mit dem kompromittierten Zwischenstand weiterzumachen — dieselbe Regel wie
 * in `krypto/empfangen.ts` (dort ausfuehrlich begruendet), hier ohne
 * `verarbeiteMitWiederherstellung`: die Dateien werden blockweise, nicht
 * einzeln rueckverfolgt geoeffnet (s. unten).
 *
 * **Erst ALLES holen, dann unter der Sperre oeffnen.** Der Netzteil laeuft
 * vollstaendig VOR `mitKontosperre`: das Holen braucht die Sperre nicht (es
 * ruehrt weder `ident` noch eine Sitzung an), und es ist der mit Abstand
 * langsamste Teil — beim ersten Oeffnen eines gewachsenen Kanals sind das
 * Hunderte Netzrunden zu einer fremden Cloud, jede mit moeglicher Geduld bei
 * 429 (`api/ablageKanalOrdner.ts`). Laege das unter der Konto-Sperre,
 * stuende der gesamte Postfach-Zyklus dieses Browserprofils fuer die ganze
 * Dauer still — nicht nur dieser Kanal, und nicht nur dieser Tab (Web Locks
 * gelten profilweit). Unter der Sperre bleibt danach nur das Entschluesseln,
 * das sie wirklich braucht.
 *
 * **Parallelitaet nur beim Netzabruf, nicht beim Oeffnen.** Die Dateien
 * werden blockweise parallel geholt (`ordnerDatei`, Blockgroesse 8 — genug,
 * um die Round-Trips zu ueberlappen, ohne den Server mit hunderten
 * gleichzeitigen Anfragen zu treffen), aber NACHEINANDER an
 * `zustellungOeffnen` gegeben: die Funktion mutiert das gemeinsame `ident`
 * (Sitzungsaufbau), und zwei gleichzeitige Mutationen auf demselben
 * Objekt waeren eine Wettlaufbedingung, die `mitSitzungssperre` (je
 * Sender-Geraet) allein nicht ausschliesst — sie schuetzt nur gegen einen
 * ZWEITEN Zyklus, nicht gegen zwei Aufrufe in DIESEM.
 */
import { ordnerListe, ordnerDatei } from '../api/ablageKanalOrdner';
import { sortiereNamen } from './ordnerDateien';
import { naechsterCursor, fertig } from './ordnerSeiten';
import { ApiError } from '../api/client';
import { zustellungOeffnen, KontoSicherungFehlgeschlagen } from '../krypto/zustellungOeffnen';
import { kryptoAccountLaden } from '../krypto/account.svelte';
import { mitKontosperre } from '../krypto/sperren';
import { loeschungAnwenden } from '../krypto/loeschungAnwenden';
import { verlaufSpeichernPflicht } from '../verlauf';
import { verlaufZustand } from '../verlauf/zustand.svelte';
import type { Message } from '../api/types';
import type { PostfachZustellung } from '../api/postfach';

/** Wieviele Namen `ordnerListe` je Seite liefert. */
const SEITENGROESSE = 200;
/** Wieviele Dateien parallel geholt werden — s. Modulkopf. */
const BLOCKGROESSE = 8;

/** Alle Dateinamen des Ordners, blattweise geholt. `null`, wenn
 *  `ordnerListe` mit 404 antwortet (kein Ordner-Kanal).
 *
 *  Der Cursor kommt aus `ordnerSeiten.ts` — er ist die NUTZLAST-ID des
 *  letzten Namens, nicht der Name selbst (der Server liest ihn als Zahl und
 *  antwortet sonst 422). Liefert eine volle Seite keinen brauchbaren Cursor,
 *  wird abgebrochen statt mit dem alten weiterzufragen: das waere eine
 *  Endlosschleife auf derselben Seite. */
async function alleNamenHolen(kanalId: string): Promise<string[] | null> {
  const namen: string[] = [];
  let nach: string | null = null;
  for (;;) {
    let seite: string[];
    try {
      seite = await ordnerListe(kanalId, nach, SEITENGROESSE);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }
    namen.push(...seite);
    if (fertig(seite, SEITENGROESSE)) break;
    const weiter = naechsterCursor(seite);
    if (weiter === null) break;
    nach = weiter;
  }
  return namen;
}


/** Holt alle Dateien blockweise — OHNE Konto-Sperre, s. Modulkopf. `null`
 *  je Eintrag heisst „nicht zu holen oder nicht zu deuten" (der Aufrufer
 *  zaehlt sie als uebersprungen). Reihenfolge bleibt die von `namen`. */
async function alleDateienHolen(
  kanalId: string,
  namen: readonly string[]
): Promise<(PostfachZustellung | null)[]> {
  const geholt: (PostfachZustellung | null)[] = [];
  for (let i = 0; i < namen.length; i += BLOCKGROESSE) {
    const block = namen.slice(i, i + BLOCKGROESSE);
    geholt.push(
      ...(await Promise.all(block.map((name) => ordnerDatei(kanalId, name).catch(() => null))))
    );
  }
  return geholt;
}

/**
 * Liest den Verlauf eines Ordner-Kanals aus den Server-Dateien.
 * `null`, wenn `kanalId` kein Ordner-Kanal ist (s. Modulkopf) — der
 * Aufrufer faellt dann auf `kanalLeseweg.ts::kanalVerlaufLesen` zurueck.
 */
export async function kanalOrdnerVerlaufLesen(kanalId: string): Promise<Message[] | null> {
  const namen = await alleNamenHolen(kanalId);
  if (namen === null) return null;

  const sortiert = sortiereNamen(namen);
  if (sortiert.length === 0) return [];

  // Der ganze Netzteil VOR der Sperre, s. Modulkopf.
  const zustellungen = await alleDateienHolen(kanalId, sortiert);

  return mitKontosperre(async () => {
    let ident = await kryptoAccountLaden();
    const gesammelt: Message[] = [];
    let uebersprungen = 0;

    for (const z of zustellungen) {
      if (!z) {
        uebersprungen++;
        continue;
      }
      try {
        const ergebnis = await zustellungOeffnen(ident, z);
        if (!ergebnis) {
          uebersprungen++;
          continue;
        }
        if (ergebnis.art === 'loeschung') {
          await loeschungAnwenden(ergebnis.channelId, ergebnis.nachrichtId);
          continue;
        }
        if (ergebnis.art === 'neu') {
          gesammelt.push(ergebnis.nachricht);
          // Sofort ablegen, nicht erst am Ende sammeln — bricht ein
          // spaeterer Schritt ab, bleibt, was schon offen war, trotzdem
          // lokal erhalten. Ein Fehlschlag hier darf den Lesevorgang nicht
          // abwuergen: die Quelle bleibt der Ordner, ein spaeteres Oeffnen
          // liest dieselbe Datei einfach erneut.
          await verlaufSpeichernPflicht(kanalId, [ergebnis.nachricht]).catch((err) =>
            verlaufZustand.melde(err)
          );
        }
        // 'schonAbgelegt': liegt lokal bereits vor, nichts zu tun.
      } catch (err) {
        if (err instanceof KontoSicherungFehlgeschlagen) {
          // Derselbe Fall wie in `krypto/empfangen.ts` (Bughunt-Runde 3,
          // FIX 2): `ident` traegt eine verbrauchte, aber nicht durabel
          // gesicherte Mutation — frisch aus IndexedDB nachladen, statt
          // den kompromittierten Stand weiterzuverwenden.
          ident = await kryptoAccountLaden();
        }
        uebersprungen++;
      }
    }

    if (uebersprungen > 0) {
      // Kein Fehlerpfad — nur ein Hinweis fuers Debuggen, s. Modulkopf
      // „Fehler beim Oeffnen einzelner Dateien schlucken und zaehlen".
      console.debug(
        `kanalOrdnerVerlaufLesen(${kanalId}): ${uebersprungen} Datei(en) uebersprungen`
      );
    }

    return gesammelt;
  });
}
