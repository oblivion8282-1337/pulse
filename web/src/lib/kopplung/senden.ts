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
 * Versuch (Netz weg, ein Stueck schlaegt fehl) beginnt beim naechsten Mal
 * deshalb nicht bei null — und auch nicht bei „der ersten Luecke", denn eine
 * Luecke kann mittendrin liegen, wenn mehrere Stuecke gleichzeitig unterwegs
 * waren.
 *
 * **Grenze, absichtlich (Bughunt 2026-08-29, Befund 1):** das gilt nur
 * INNERHALB der laufenden Sitzung, angestossen ueber den „Erneut versuchen"-
 * Knopf in `KopplungZeigen.svelte` (`ansichtZustand.ts::kannErneutSchieben`).
 * Code und Kopplungs-Kennung leben ausschliesslich im `$state` dieser
 * Komponente — das bleibt so, der Code darf nirgends sonst hin. Ein
 * vollstaendiges Neuladen der Seite verwirft ihn deshalb ebenfalls, und ein
 * neuer Anlauf legt zwangslaeufig eine NEUE Kopplung mit leerem Stand an.
 * „Fortsetzbar" heisst also: ein fehlgeschlagener Versuch wirft die bereits
 * geleistete Arbeit nicht weg, solange die Seite offen bleibt — nicht, dass
 * ein Neuladen sie ueberlebt.
 *
 * **Warum der Verlauf zweimal geschnitten wird (einmal beim ersten Lauf,
 * einmal beim Fortsetzen) und das trotzdem stimmt:** die Schnittfolge haengt
 * nur an den Saetzen und an `SAETZE_JE_STUECK`/`maxBytes` — alles
 * unveraenderlich zwischen zwei Laeufen, SOLANGE der Verlauf sich nicht
 * aendert. Kommt zwischendurch eine neue Nachricht an, oder wird eine
 * aeltere bearbeitet/geloescht (eine Kopplung lebt bis zu
 * `umzug_frist_stunden`, 48 h Standardwert — genug Zeit dafuer), verschiebt
 * sich der Schnitt.
 *
 * **Die Positionszahl allein beweist das NICHT.** Ergibt die neue Einteilung
 * zufaellig dieselbe Stueckzahl (oder war `gesamt_stuecke` noch nicht
 * gemeldet, s. unten), saehe eine rein zaehlbasierte Pruefung keinen
 * Unterschied — ein veraendertes Stueck bliebe unbemerkt auf dem alten Stand
 * liegen. Deshalb traegt jedes hochgeladene Stueck zusaetzlich eine
 * Inhalts-Kennung (`transport.ts::stueckKennung`, ein HMAC ueber den
 * Klartext mit einem Schluessel, den nur ableiten kann, wer den
 * Kopplungscode kennt — der Server lernt daraus nichts ueber den Inhalt).
 * Beim Fortsetzen zaehlt eine Position nur dann als „schon da", wenn ihre
 * lokal neu berechnete Kennung mit der vom Server zurueckgegebenen
 * uebereinstimmt; sonst wird sie neu geschoben.
 */
import { serversStore } from '../api/servers.svelte';
import { kopplungApi } from '../api/kopplung';
import { verlaufAlleLesen } from '../verlauf/db';
import type { Satz } from '../verlauf/schema';
import { codeErzeugen } from './code';
import { nachweisFuer } from './nachweisRumpf';
import {
  codeHash,
  stueckKennung,
  stueckKennungSchluessel,
  stueckVerschluesseln,
  transportSchluessel
} from './transport';
import { fehlendeStuecke, stueckeSchneiden } from './umzugPlan';
import { vorhandeneNachKennungAbgleich } from './kennungAbgleich';

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

  // Nur Positionen uebernehmen, deren Inhalt nachweislich noch der ist, der
  // damals hochgeladen wurde (s. Modulkopf). Eine Position ohne (mehr)
  // passende Kennung zaehlt als fehlend, auch wenn ihre Nummer schon beim
  // Server steht — der reine Zaehlvergleich `gesamt_stuecke === stuecke.length`
  // ist damit entfallen, er waere bei zufaellig gleicher Stueckzahl blind
  // gewesen.
  const kennungSchluessel = await stueckKennungSchluessel(code, kopplungId);
  const lokaleKennungen = new Map<number, string>();
  for (const folge of stand.vorhandene_stuecke) {
    if (folge >= stuecke.length) continue;
    lokaleKennungen.set(
      folge,
      await stueckKennung(kennungSchluessel, folge, stueckBytes(stuecke[folge]))
    );
  }
  const vorhanden = vorhandeneNachKennungAbgleich(
    stand.vorhandene_stuecke,
    stand.vorhandene_kennungen,
    lokaleKennungen,
    stuecke.length
  );

  const schluessel = await transportSchluessel(code, kopplungId);
  const fehlt = fehlendeStuecke(stuecke.length, vorhanden);
  let geschoben = stuecke.length - fehlt.length;
  melde(geschoben, stuecke.length);

  for (const folge of fehlt) {
    const bytes = stueckBytes(stuecke[folge]);
    const daten = await stueckVerschluesseln(schluessel, kopplungId, folge, bytes);
    const kennung = await stueckKennung(kennungSchluessel, folge, bytes);
    const rumpf = await nachweisFuer(
      'kopplung-stueck',
      kopplungId,
      String(folge),
      daten
    );
    await kopplungApi.stueckAblegen(
      { ...rumpf, kopplung_id: kopplungId, folge, daten, kennung },
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
