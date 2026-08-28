/**
 * Die Sendeseite des Verlaufsumzugs — das ALTE Geraet (Etappe F, E2E-DM).
 *
 * Ablauf: Code erzeugen → Kopplung anlegen → Code anzeigen → warten, bis
 * jemand einloest → Verlauf lesen, schneiden, verschluesseln, schieben →
 * Gesamtzahl melden.
 *
 * **Fortsetzbar heisst hier: der Stand kommt vom SERVER, nicht aus dem
 * Gedaechtnis dieses Laufs.** `POST /kopplung/stand` liefert
 * `vorhandene_stuecke`; geschoben wird genau die Differenz. Ein abgebrochener
 * Lauf (Fenster zu, Netz weg) beginnt beim naechsten Mal deshalb nicht bei
 * null — und auch nicht bei „der ersten Luecke", denn eine Luecke kann
 * mittendrin liegen, wenn mehrere Stuecke gleichzeitig unterwegs waren.
 *
 * **Warum der Verlauf zweimal geschnitten wird (einmal beim ersten Lauf,
 * einmal beim Fortsetzen) und das trotzdem stimmt:** die Schnittfolge haengt
 * nur an den Saetzen und an `SAETZE_JE_STUECK`/`maxBytes` — alles
 * unveraenderlich zwischen zwei Laeufen, SOLANGE der Verlauf sich nicht
 * aendert. Kommt zwischendurch eine neue Nachricht an, verschiebt sich der
 * Schnitt, und ein fortgesetzter Umzug mischte zwei Schnittfolgen. Deshalb
 * wird die Schnittfolge **einmal** festgelegt und ueber die Gesamtzahl
 * gebunden: weicht die neu berechnete Stueckzahl von einer bereits
 * gemeldeten ab, beginnt der Umzug neu, statt still Unsinn zu liefern.
 */
import { serversStore } from '../api/servers.svelte';
import { kopplungApi } from '../api/kopplung';
import { verlaufAlleLesen } from '../verlauf/db';
import type { Satz } from '../verlauf/schema';
import { codeErzeugen } from './code';
import { nachweisFuer } from './nachweisRumpf';
import { codeHash, stueckVerschluesseln, transportSchluessel } from './transport';
import { fehlendeStuecke, stueckeSchneiden } from './umzugPlan';

function cloudRoute(): { serverId?: string } {
  return { serverId: serversStore.cloudId() };
}

/**
 * Die Byte-Grenze, unter der geschnitten wird.
 *
 * Der Server deckelt bei `umzug_max_stueck_bytes` = 512 KiB **nach** dem
 * Base64-Dekodieren. Gerechnet wird hier auf dem KLARTEXT, und zwischen
 * beiden liegen: JSON-Rahmen, 12 Byte IV und 16 Byte GCM-Siegel. Die Reserve
 * ist grosszuegig statt knapp — ein zu grosses Stueck kostet einen
 * abgewiesenen Umzug, ein zu kleines nur ein paar Anfragen mehr.
 */
const KLARTEXT_GRENZE = 384 * 1024;

const ENC = new TextEncoder();

/** Legt eine Kopplung an und gibt Code und ID zurueck. Der Code wird
 *  NIRGENDS gespeichert — er lebt nur in der Anzeige und im Aufrufer. */
export async function kopplungStarten(): Promise<{ kopplungId: string; code: string }> {
  const code = codeErzeugen();
  const hash = await codeHash(code);
  const rumpf = await nachweisFuer('kopplung', hash);
  const { id } = await kopplungApi.anlegen({ ...rumpf, code_hash: hash }, cloudRoute());
  return { kopplungId: id, code };
}

/** Bricht ab und raeumt weg — auch fuer „Code doch nicht zeigen". */
export async function kopplungAbbrechen(kopplungId: string): Promise<void> {
  const rumpf = await nachweisFuer('kopplung-abschliessen', kopplungId);
  await kopplungApi.abschliessen({ ...rumpf, kopplung_id: kopplungId }, cloudRoute());
}

/** Ob schon jemand eingeloest hat — die Oberflaeche pollt damit. */
export async function istEingeloest(kopplungId: string): Promise<boolean> {
  const rumpf = await nachweisFuer('kopplung-stand', kopplungId);
  const stand = await kopplungApi.stand({ ...rumpf, kopplung_id: kopplungId }, cloudRoute());
  return stand.eingeloest;
}

/** Ein Stueck als Klartext-Bytes — JSON, weil die Gegenseite dieselben
 *  `Satz`-Objekte wieder ablegt und keine eigene Form braucht. */
function stueckBytes(saetze: Satz[]): Uint8Array {
  return ENC.encode(JSON.stringify({ saetze }));
}

/**
 * Schiebt den Verlauf hinueber — fortsetzbar, mit Fortschrittsmeldung.
 *
 * `melde` wird nach JEDEM Stueck gerufen, auch beim ersten Ueberspringen
 * eines schon vorhandenen: die Anzeige soll beim Fortsetzen sofort auf dem
 * richtigen Stand stehen, statt bei null zu beginnen und aufzuholen.
 */
export async function verlaufSchieben(
  kopplungId: string,
  code: string,
  melde: (geschoben: number, gesamt: number) => void
): Promise<{ gesamt: number }> {
  const alle = await verlaufAlleLesen();
  const stuecke = stueckeSchneiden(
    alle,
    (satz) => ENC.encode(JSON.stringify(satz)).length,
    KLARTEXT_GRENZE
  );

  const standRumpf = await nachweisFuer('kopplung-stand', kopplungId);
  const stand = await kopplungApi.stand(
    { ...standRumpf, kopplung_id: kopplungId },
    cloudRoute()
  );

  // Die Schnittfolge hat sich seit dem letzten Lauf geaendert (neue
  // Nachrichten sind dazugekommen). Alles Bisherige gehoert zu einer anderen
  // Einteilung und wird ueberschrieben — die Positionen sind dieselben
  // Zahlen, aber nicht mehr dieselben Inhalte.
  const einteilungPasst =
    stand.gesamt_stuecke === null || stand.gesamt_stuecke === stuecke.length;
  const vorhanden = einteilungPasst ? stand.vorhandene_stuecke : [];

  const schluessel = await transportSchluessel(code, kopplungId);
  const fehlt = fehlendeStuecke(stuecke.length, vorhanden);
  let geschoben = stuecke.length - fehlt.length;
  melde(geschoben, stuecke.length);

  for (const folge of fehlt) {
    const daten = await stueckVerschluesseln(
      schluessel,
      kopplungId,
      folge,
      stueckBytes(stuecke[folge])
    );
    const rumpf = await nachweisFuer(
      'kopplung-stueck',
      kopplungId,
      String(folge),
      daten
    );
    await kopplungApi.stueckAblegen(
      { ...rumpf, kopplung_id: kopplungId, folge, daten },
      cloudRoute()
    );
    geschoben += 1;
    melde(geschoben, stuecke.length);
  }

  // ZULETZT, und nur wenn wirklich alles liegt: die Gesamtzahl ist das
  // Signal „vollstaendig" fuer die Gegenseite. Frueher gemeldet, koennte ein
  // Empfaenger einen abgebrochenen Umzug fuer fertig halten.
  const fertigRumpf = await nachweisFuer(
    'kopplung-fertig',
    kopplungId,
    String(stuecke.length)
  );
  await kopplungApi.fertig(
    { ...fertigRumpf, kopplung_id: kopplungId, gesamt_stuecke: stuecke.length },
    cloudRoute()
  );

  return { gesamt: stuecke.length };
}
