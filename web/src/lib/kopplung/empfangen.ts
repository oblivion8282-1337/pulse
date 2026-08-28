/**
 * Die Empfangsseite des Verlaufsumzugs — das NEUE Geraet (Etappe F, E2E-DM).
 *
 * Ablauf: Code eintippen (oder scannen) → einloesen → eigene Schluessel
 * veroeffentlichen → warten, bis die Gesamtzahl steht → Stuecke holen,
 * entschluesseln, ablegen → abschliessen.
 *
 * **Das Veroeffentlichen der eigenen Schluessel gehoert in die Einloesung,
 * nicht daneben.** Die Spec (§6) nennt beides als das, was bei der Kopplung
 * passiert; getrennt gerufen waere „gekoppelt, aber nicht erreichbar" ein
 * moeglicher Zwischenzustand, und er sieht von aussen wie ein fertiger
 * Vorgang aus.
 *
 * **Warum das Ablegen keinen Zwischenstand braucht.**
 * `verlaufPutSaetze` ist ein Upsert ueber den Primaerschluessel — ein
 * zweimal geholtes und zweimal abgelegtes Stueck ergibt denselben Bestand
 * wie ein einmal abgelegtes. Der Empfaenger darf deshalb nach einem Abriss
 * schlicht von vorne holen; er muss sich nicht merken, wie weit er kam.
 * Teuer ist daran nur die Leitung, und die Alternative — ein eigener
 * Fortschritts-Speicher im Klienten — waere eine zweite Wahrheit neben dem
 * lokalen Verlauf.
 */
import { serversStore } from '../api/servers.svelte';
import { kopplungApi } from '../api/kopplung';
import { veroeffentlicheSchluessel } from '../krypto/veroeffentlichen';
import { verlaufPutSaetze } from '../verlauf/db';
import type { Satz } from '../verlauf/schema';
import { codeNormalisieren } from './code';
import { einloesFehlerAus } from './einloesFehler';
import type { EinloesFehler } from './einloesFehler';
import { nachweisFuer } from './nachweisRumpf';
import { codeHash, stueckEntschluesseln, transportSchluessel } from './transport';

function cloudRoute(): { serverId?: string } {
  return { serverId: serversStore.cloudId() };
}

const DEC = new TextDecoder();

/** Die Oberflaeche uebersetzt den Grund in Text (`messages/{de,en}.json`);
 *  hier steht deshalb keine Nutzersprache. Die Zuordnung selbst liegt
 *  importfrei in `einloesFehler.ts` und ist dort geprueft. */
export class EinloesenFehlgeschlagen extends Error {
  constructor(readonly grund: EinloesFehler) {
    super(`Kopplung fehlgeschlagen: ${grund}`);
  }
}

/**
 * Loest einen eingetippten oder gescannten Code ein.
 *
 * Die Normalisierung laeuft VOR dem Serveraufruf: eine Eingabe, die gar kein
 * Code sein kann, verbraucht sonst eine Rate-Chance und sieht fuer den
 * Nutzer aus wie ein abgelaufener Code (s. `code.ts::codeNormalisieren`).
 */
export async function kopplungEinloesen(
  eingabe: string
): Promise<{ kopplungId: string; code: string; altGeraet: string }> {
  const code = codeNormalisieren(eingabe);
  if (code === null) throw new EinloesenFehlgeschlagen('code_ungueltig');

  const hash = await codeHash(code);
  const rumpf = await nachweisFuer('kopplung-einloesen', hash);
  let antwort;
  try {
    antwort = await kopplungApi.einloesen({ ...rumpf, code_hash: hash }, cloudRoute());
  } catch (fehler) {
    throw new EinloesenFehlgeschlagen(einloesFehlerAus(fehler));
  }

  // Der zweite Teil dessen, was eine Kopplung ausmacht (Spec §6): ab jetzt
  // ist dieses Geraet im Verzeichnis und kann adressiert werden.
  await veroeffentlicheSchluessel();

  return { kopplungId: antwort.id, code, altGeraet: antwort.alt_device_pubkey };
}

/** Was die Oberflaeche vom Empfaenger wissen will. */
export type EmpfangsStand = {
  /** `null`, solange das alte Geraet die Gesamtzahl nicht gemeldet hat. */
  gesamt: number | null;
  geholt: number;
};

/** Fragt, ob der Sender fertig ist und wie weit er kam. */
export async function umzugStand(kopplungId: string): Promise<EmpfangsStand> {
  const rumpf = await nachweisFuer('kopplung-stand', kopplungId);
  const stand = await kopplungApi.stand({ ...rumpf, kopplung_id: kopplungId }, cloudRoute());
  return { gesamt: stand.gesamt_stuecke, geholt: stand.vorhandene_stuecke.length };
}

/** Ein Stueck, wie der Sender es geschnuert hat (`senden.ts::stueckBytes`). */
type StueckInhalt = { saetze: Satz[] };

/**
 * Holt alle Stuecke und legt sie im lokalen Verlauf ab.
 *
 * Gibt die Zahl der uebernommenen Saetze zurueck — das ist die Zahl, die dem
 * Nutzer gezeigt wird, zusammen mit dem Hinweis, dass Bilder und Dateien auf
 * dem alten Geraet bleiben (Begruendung im Kopf von
 * `routes/kopplung_umzug.py`).
 *
 * Wirft, wenn die Gesamtzahl noch nicht steht: ein Umzug ohne sie ist nicht
 * als vollstaendig erkennbar, und ein halber Verlauf, den niemand als halb
 * ausweist, ist schlimmer als gar keiner.
 */
export async function verlaufUebernehmen(
  kopplungId: string,
  code: string,
  melde: (geholt: number, gesamt: number) => void
): Promise<{ saetze: number }> {
  const { gesamt } = await umzugStand(kopplungId);
  if (gesamt === null) throw new Error('Das alte Geraet hat den Umzug noch nicht abgeschlossen');

  const schluessel = await transportSchluessel(code, kopplungId);
  let uebernommen = 0;
  melde(0, gesamt);

  for (let folge = 0; folge < gesamt; folge++) {
    const rumpf = await nachweisFuer('kopplung-stueck-holen', kopplungId, String(folge));
    const stueck = await kopplungApi.stueckHolen(
      { ...rumpf, kopplung_id: kopplungId, folge },
      cloudRoute()
    );
    const klartext = await stueckEntschluesseln(schluessel, kopplungId, folge, stueck.daten);
    const inhalt = JSON.parse(DEC.decode(klartext)) as StueckInhalt;
    await verlaufPutSaetze(inhalt.saetze);
    uebernommen += inhalt.saetze.length;
    melde(folge + 1, gesamt);
  }

  // Erst NACH dem letzten erfolgreichen Ablegen aufraeumen. Umgekehrt waere
  // ein Fehler im letzten Stueck ein endgueltiger Verlust — der Server haelt
  // keine zweite Kopie, und der Sender muesste den ganzen Umzug wiederholen.
  const schlussRumpf = await nachweisFuer('kopplung-abschliessen', kopplungId);
  await kopplungApi.abschliessen(
    { ...schlussRumpf, kopplung_id: kopplungId },
    cloudRoute()
  );

  return { saetze: uebernommen };
}
