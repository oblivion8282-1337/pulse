/**
 * Laedt/sichert Megolm-Sitzungen — dieselbe IndexedDB (`pulse-identity`) und
 * derselbe Pickle-Schluessel wie bei den Olm-Sitzungen (`../sitzungen.ts`,
 * `pickelschluesselDesGeraets`). Ein zweites Geheimnis brauchte niemand, und
 * es waere ein zweites, das gepflegt werden muesste.
 *
 * **Zwei Arten von Sitzungen, zwei Schluesselraeume:**
 *
 * * **Ausgehend**, eine je Kanal: `pulse.krypto-gruppensitzung.<kanalId>`.
 *   Neben dem eingefrorenen Zustand liegt dort der Buchhaltungsteil, den
 *   `sitzungswahl.ts` braucht (fuer wen sie angelegt wurde, wer sie schon
 *   hat, wie oft und seit wann). **Der ist bewusst NICHT im Pickle**: er ist
 *   kein Schluesselmaterial (Konto-IDs und Geraete-Pubkeys stehen ohnehin im
 *   Verzeichnis), und er muss lesbar sein, BEVOR entschieden ist, ob die
 *   Sitzung ueberhaupt aufgetaut wird.
 * * **Eingehend**, eine je (Kanal, Absendergeraet, Sitzungskennung):
 *   `pulse.krypto-gruppenempfang.<kanalId>.<geraet>.<sitzungId>`. Die
 *   Sitzungskennung MUSS im Schluessel stehen — ohne sie wuerde ein
 *   Schluesselwechsel die vorherige Sitzung ueberschreiben, und weil
 *   Megolm-Ratchets nur vorwaerts laufen, waeren noch offene Nachrichten aus
 *   der alten Sitzung damit UNWIEDERBRINGLICH verloren, nicht bloss neu
 *   aufzubauen (s. `krypto/pulse-krypto/src/gruppe.rs`).
 *
 * **Auch hier sperrt keine Funktion selbst** (dieselbe Regel wie in
 * `../account.svelte.ts`, Begruendung in `../sperren.ts`): die AUSGEHENDE
 * Sitzung sperrt `senden.ts` ueber Laden, Verschluesseln und Sichern hinweg
 * (`mitGruppensitzungssperre`); die EINGEHENDEN Sitzungen entstehen und
 * ratcheten ausschliesslich im Abholzyklus (`../empfangen.ts`), der als
 * Ganzes unter der Konto-Sperre laeuft — ein zweiter Tab kann deshalb nicht
 * gleichzeitig in denselben Eintrag schreiben. Wer sie an einer NEUEN Stelle
 * ausserhalb des Abholzyklus veraendert, bringt eine eigene Sperre mit.
 *
 * **Was hier NICHT steht: ein Aufraeumen alter eingehender Sitzungen.** Bei
 * jedem Mitgliederwechsel entsteht eine weitere Zeile je Absendergeraet, und
 * keine verschwindet je. Das ist eine bekannte, offene Stelle — sie zu
 * schliessen heisst zu entscheiden, ab wann eine Sitzung sicher nichts mehr
 * oeffnen muss, und diese Entscheidung ist ohne die noch fehlende Anzeige
 * nicht zu treffen (eine Sitzung, deren Nachrichten im lokalen Verlauf
 * liegen, wird nicht mehr gebraucht — aber „liegen" heisst: alle, auch die,
 * die noch unquittiert im Postfach warten).
 */
import type {
  Gruppensitzung,
  Gruppenempfang
} from '../../../../../krypto/pulse-krypto/pkg/pulse_krypto.js';
import {
  Gruppensitzung as GruppensitzungKlasse,
  Gruppenempfang as GruppenempfangKlasse
} from '../../../../../krypto/pulse-krypto/pkg/pulse_krypto.js';
import { openIdentityDb, idbGetIdentity, idbPutIdentity } from '../../identity/idb-shared';
import { pickelschluesselDesGeraets } from '../account.svelte';
import type { Gruppenstand } from './sitzungswahl';

/** Was unter dem Ausgang-Schluessel liegt: der Pickle plus die Buchhaltung
 *  aus `sitzungswahl.ts` (ohne das Sitzungsobjekt selbst). */
type GefrorenerStand = Omit<Gruppenstand<never>, 'sitzung'> & { gefroren: string };

function ausgangSchluessel(kanalId: string): string {
  return `pulse.krypto-gruppensitzung.${kanalId}`;
}

function eingangSchluessel(kanalId: string, geraetePubkey: string, sitzungId: string): string {
  return `pulse.krypto-gruppenempfang.${kanalId}.${geraetePubkey}.${sitzungId}`;
}

/** Die laufende ausgehende Sitzung dieses Kanals — `null`, wenn es keine
 *  gibt. Wirft, wenn eine gespeicherte Sitzung nicht aufzutauen ist: das
 *  waere ein beschaedigter Zustand, und still eine neue anzulegen hiesse,
 *  allen Empfaengern unbemerkt einen zweiten Schluesselwechsel zuzumuten. */
export async function gruppensitzungLaden(
  kanalId: string
): Promise<Gruppenstand<Gruppensitzung> | null> {
  const db = await openIdentityDb();
  const roh = (await idbGetIdentity(db, ausgangSchluessel(kanalId))) as
    | GefrorenerStand
    | undefined;
  db.close();
  if (!roh) return null;
  const schluessel = await pickelschluesselDesGeraets();
  return {
    sitzungId: roh.sitzungId,
    sitzung: GruppensitzungKlasse.auftauen(roh.gefroren, schluessel),
    mitglieder: roh.mitglieder,
    beliefert: roh.beliefert,
    nachrichten: roh.nachrichten,
    angelegtAm: roh.angelegtAm
  };
}

/** Friert die ausgehende Sitzung ein und schreibt sie samt Buchhaltung.
 *  MUSS nach JEDER Verschluesselung laufen — der Megolm-Ratchet ist dann
 *  schon weitergedreht, und ein Absturz danach wuerde beim naechsten Start
 *  einen Zaehlerstand wiederverwenden. */
export async function gruppensitzungSichern(
  kanalId: string,
  stand: Gruppenstand<Gruppensitzung>
): Promise<void> {
  const schluessel = await pickelschluesselDesGeraets();
  const roh: GefrorenerStand = {
    sitzungId: stand.sitzungId,
    gefroren: stand.sitzung.einfrieren(schluessel),
    mitglieder: stand.mitglieder,
    beliefert: stand.beliefert,
    nachrichten: stand.nachrichten,
    angelegtAm: stand.angelegtAm
  };
  const db = await openIdentityDb();
  await idbPutIdentity(db, ausgangSchluessel(kanalId), roh);
  db.close();
}

export async function gruppenempfangLaden(
  kanalId: string,
  geraetePubkey: string,
  sitzungId: string
): Promise<Gruppenempfang | null> {
  const db = await openIdentityDb();
  const gefroren = (await idbGetIdentity(
    db,
    eingangSchluessel(kanalId, geraetePubkey, sitzungId)
  )) as string | undefined;
  db.close();
  if (!gefroren) return null;
  const schluessel = await pickelschluesselDesGeraets();
  return GruppenempfangKlasse.auftauen(gefroren, schluessel);
}

/** Wie `sitzungSichern` bei Olm: nach JEDEM Entschluesseln, VOR der
 *  Quittung. Die Quittung loescht die einzige Kopie auf dem Server. */
export async function gruppenempfangSichern(
  kanalId: string,
  geraetePubkey: string,
  sitzungId: string,
  empfang: Gruppenempfang
): Promise<void> {
  const schluessel = await pickelschluesselDesGeraets();
  const gefroren = empfang.einfrieren(schluessel);
  const db = await openIdentityDb();
  await idbPutIdentity(db, eingangSchluessel(kanalId, geraetePubkey, sitzungId), gefroren);
  db.close();
}

/**
 * Legt einen frisch empfangenen Verteilschluessel als eingehende Sitzung ab.
 *
 * **Ein bereits vorhandener Eintrag wird NICHT ueberschrieben.** Denselben
 * Verteilschluessel bekommt man durchaus zweimal (ein zweites Geraet des
 * Absenders liefert nach, eine Zustellung wurde nicht quittiert und kommt
 * wieder) — die abgelegte Sitzung ist dann aber schon weitergeratscht.
 * Ueberschreiben setzte sie auf den Anfangsstand zurueck; das wuerde zwar
 * nichts unlesbar machen (der Ratchet laeuft von dort erneut vorwaerts),
 * aber jede seither gelesene Nachricht ein zweites Mal entschluesselbar
 * machen — und damit die Wiedereinspiel-Erkennung ueber den
 * Nachrichtenzaehler aushebeln, die der Krypto-Kern ausdruecklich anbietet.
 */
export async function gruppenempfangAnlegenFallsNeu(
  kanalId: string,
  geraetePubkey: string,
  sitzungId: string,
  verteilschluessel: string
): Promise<void> {
  const db = await openIdentityDb();
  const schluessel = eingangSchluessel(kanalId, geraetePubkey, sitzungId);
  const vorhanden = await idbGetIdentity(db, schluessel);
  if (vorhanden !== undefined) {
    db.close();
    return;
  }
  const pickel = await pickelschluesselDesGeraets();
  const empfang = GruppenempfangKlasse.ausVerteilschluessel(verteilschluessel);
  await idbPutIdentity(db, schluessel, empfang.einfrieren(pickel));
  db.close();
}

/** Eine frische ausgehende Sitzung — als Funktion, damit `sitzungWaehlen`
 *  sie nur dann erzeugt, wenn sie wirklich gebraucht wird. */
export function neueGruppensitzung(): Gruppensitzung {
  return new GruppensitzungKlasse();
}
