/**
 * Die drei Zusagen einer verschluesselten Gruppe, an der ECHTEN Megolm-Kiste
 * geprueft — nicht an einer Attrappe:
 *
 *  (a) zwei Geraete lesen dieselbe Gruppennachricht (EINE Nutzlast, viele
 *      Zustellungen),
 *  (b) wer entfernt wurde, kann eine DANACH gesendete Nachricht nicht lesen —
 *      auch dann nicht, wenn er ihren Geheimtext abfaengt,
 *  (c) wer neu dazukommt, kann eine DAVOR gesendete nicht lesen.
 *
 * Gefahren werden dabei die echten Bausteine des Sendewegs:
 * `sitzungWaehlen`/`standNachSendung` (`krypto/gruppe/sitzungswahl.ts`) und
 * die echten Wire-Formen (`krypto/gruppe/gruppenNutzlast.ts`). Nachgebildet
 * ist nur, was hier nichts beweisen wuerde: der Netzweg (`POST /postfach`)
 * und die 1:1-Olm-Sitzungen, ueber die der Verteilschluessel reist — dass
 * Olm traegt, zeigt `krypto-wasm.test.ts` bereits. Der Test nimmt deshalb
 * genau die Geraete als „beliefert" an, die `sitzungWaehlen` in
 * `nachzuliefern` NENNT. Damit haengt (b) an genau der Entscheidung, um die
 * es geht: nennt die Rechnung das ausgeschiedene Geraet weiter, faellt der
 * Test.
 *
 * Wie `krypto-wasm.test.ts`: fehlt das gebaute WASM-Paket, werden die Tests
 * ausdruecklich uebersprungen statt rot zu werden.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  sitzungWaehlen,
  standNachSendung,
  type Gruppenstand
} from '../src/lib/krypto/gruppe/sitzungswahl.ts';
import {
  baueVerteilNutzlast,
  leseVerteilNutzlast,
  baueGruppenhuelle,
  leseGruppenhuelle,
  neueSitzungId
} from '../src/lib/krypto/gruppe/gruppenNutzlast.ts';

const pfad = new URL('../../krypto/pulse-krypto/pkg/pulse_krypto.js', import.meta.url);
const wasmPfad = new URL('../../krypto/pulse-krypto/pkg/pulse_krypto_bg.wasm', import.meta.url);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let modul: any = null;
let fehlgrund = '';
try {
  modul = await import(pfad.href);
  await modul.default(await readFile(wasmPfad));
} catch (fehler) {
  modul = null;
  fehlgrund =
    'WASM-Paket nicht gebaut — `bash krypto/pulse-krypto/bauen-wasm.sh` ' +
    `ausfuehren. (${(fehler as Error).message})`;
}
const wennGebaut = fehlgrund ? { skip: fehlgrund } : {};

const KANAL = '1234567890';
const text = new TextEncoder();
const lesbar = new TextDecoder();

/** Ein Empfaengergeraet: haelt seine eingehenden Gruppensitzungen, nach
 *  Sitzungskennung. Genau das tut auch der echte Klient — dort in IndexedDB
 *  (`gruppe/gruppenSitzungen.ts`), hier im Arbeitsspeicher. */
type Geraet = {
  pubkey: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  empfang: Map<string, any>;
};

function geraet(pubkey: string): Geraet {
  return { pubkey, empfang: new Map() };
}

/** Was eine Sendung erzeugt: ein Geheimtext fuer alle, und die Schluessel-
 *  Umschlaege fuer die Geraete, die `sitzungWaehlen` benannt hat. */
type Sendung = {
  daten: string;
  schluesselAn: { pubkey: string; nutzlast: Uint8Array }[];
  empfaenger: string[];
  grund: string | null;
};

/** Der Sendeweg in Kurzform — dieselbe Reihenfolge wie `gruppe/senden.ts`:
 *  Sitzung waehlen, Verteilschluessel an die genannten Geraete, EINMAL
 *  verschluesseln, Stand nachtragen. */
function sende(
  welt: { stand: Gruppenstand<unknown> | null },
  mitglieder: string[],
  geraete: Geraet[],
  klartext: string,
  jetzt = Date.now()
): Sendung {
  const wahl = sitzungWaehlen(
    welt.stand,
    mitglieder,
    geraete.map((g) => g.pubkey),
    () => ({ sitzung: new modul.Gruppensitzung(), sitzungId: neueSitzungId() }),
    jetzt
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sitzung = wahl.stand.sitzung as any;
  const schluesselAn = wahl.nachzuliefern.map((pubkey) => ({
    pubkey,
    nutzlast: baueVerteilNutzlast(KANAL, wahl.stand.sitzungId, sitzung.verteilschluessel())
  }));
  const geheim = sitzung.verschluesseln(text.encode(klartext));
  welt.stand = standNachSendung(wahl.stand, wahl.nachzuliefern);
  return {
    daten: baueGruppenhuelle(wahl.stand.sitzungId, geheim),
    schluesselAn,
    empfaenger: geraete.map((g) => g.pubkey),
    grund: wahl.grund
  };
}

/** Zustellung der Schluessel-Umschlaege an die Geraete, die sie bekommen
 *  sollen — mehr tut der Server auch nicht. */
function verteile(sendung: Sendung, geraete: Geraet[]): void {
  for (const { pubkey, nutzlast } of sendung.schluesselAn) {
    const ziel = geraete.find((g) => g.pubkey === pubkey);
    if (!ziel) continue;
    const gelesen = leseVerteilNutzlast(nutzlast);
    assert.ok(gelesen, 'Verteilschluessel muss lesbar sein');
    assert.equal(gelesen.kanal, KANAL);
    ziel.empfang.set(gelesen.sitzung, modul.Gruppenempfang.ausVerteilschluessel(gelesen.schluessel));
  }
}

/** Leseversuch mit der Sitzung, die die Huelle NENNT — der normale Weg. */
function lies(g: Geraet, daten: string): string | null {
  const huelle = leseGruppenhuelle(daten);
  if (!huelle) return null;
  const empfang = g.empfang.get(huelle.sitzung);
  if (!empfang) return null;
  try {
    return lesbar.decode(empfang.entschluesseln(huelle.nachricht).klartext());
  } catch {
    return null;
  }
}

/** Leseversuch mit JEDER Sitzung, die dieses Geraet je bekommen hat — die
 *  boesartige Variante. Ein Ausgeschiedener haelt sich nicht an die
 *  Sitzungskennung in der Huelle; er probiert alles, was er hat. Nur wenn
 *  auch das scheitert, ist die Zusage echt. */
function liesMitAllem(g: Geraet, daten: string): string | null {
  const huelle = leseGruppenhuelle(daten);
  if (!huelle) return null;
  for (const empfang of g.empfang.values()) {
    try {
      return lesbar.decode(empfang.entschluesseln(huelle.nachricht).klartext());
    } catch {
      /* naechste Sitzung */
    }
  }
  return null;
}

test('(a) zwei Geraete lesen dieselbe Gruppennachricht', wennGebaut, () => {
  const handy = geraet('geraet-anna-handy');
  const laptop = geraet('geraet-bert-laptop');
  const welt: { stand: Gruppenstand<unknown> | null } = { stand: null };

  const sendung = sende(welt, ['anna', 'bert'], [handy, laptop], 'hallo Gruppe');
  verteile(sendung, [handy, laptop]);

  // EINE Nutzlast, beide Geraete als Empfaenger — genau das Modell des
  // Postfachs (Nutzlast 1:n Zustellung).
  assert.deepEqual(sendung.empfaenger, [handy.pubkey, laptop.pubkey]);
  assert.equal(lies(handy, sendung.daten), 'hallo Gruppe');
  assert.equal(lies(laptop, sendung.daten), 'hallo Gruppe');
});

test('(b) wer entfernt wurde, liest die naechste Nachricht nicht', wennGebaut, () => {
  const anna = geraet('geraet-anna');
  const bert = geraet('geraet-bert');
  const cara = geraet('geraet-cara');
  const welt: { stand: Gruppenstand<unknown> | null } = { stand: null };

  const erste = sende(welt, ['anna', 'bert', 'cara'], [anna, bert, cara], 'noch zu dritt');
  verteile(erste, [anna, bert, cara]);
  assert.equal(lies(cara, erste.daten), 'noch zu dritt');

  // Cara wird entfernt. Der Absender liest die Mitgliederliste vor der
  // naechsten Sendung neu — mehr braucht es nicht, s. Modulkopf von
  // `sitzungswahl.ts`.
  const zweite = sende(welt, ['anna', 'bert'], [anna, bert], 'jetzt ohne Cara');
  verteile(zweite, [anna, bert, cara]);

  // Die Sicherheitszusage ZUERST: Caras Geraet steht nicht mehr unter den
  // Empfaengern, bekommt den Geheimtext ueber das Postfach also gar nicht.
  // Der Test gibt ihn ihr trotzdem — selbst wer mitschneidet, kommt nicht
  // hinein, und zwar mit KEINER seiner Sitzungen.
  assert.equal(liesMitAllem(cara, zweite.daten), null);
  assert.equal(lies(cara, zweite.daten), null);
  assert.ok(!zweite.empfaenger.includes(cara.pubkey));
  assert.equal(zweite.grund, 'mitgliederwechsel');
  assert.equal(lies(anna, zweite.daten), 'jetzt ohne Cara');
  assert.equal(lies(bert, zweite.daten), 'jetzt ohne Cara');
});

test('(c) wer neu dazukommt, liest das Alte nicht', wennGebaut, () => {
  const anna = geraet('geraet-anna');
  const bert = geraet('geraet-bert');
  const dora = geraet('geraet-dora');
  const welt: { stand: Gruppenstand<unknown> | null } = { stand: null };

  const erste = sende(welt, ['anna', 'bert'], [anna, bert], 'vor Doras Zeit');
  verteile(erste, [anna, bert]);

  const zweite = sende(welt, ['anna', 'bert', 'dora'], [anna, bert, dora], 'jetzt mit Dora');
  verteile(zweite, [anna, bert, dora]);

  // Der Geheimtext von vorher liegt beim Server nicht mehr (die Zustellungen
  // sind quittiert), aber angenommen, Dora bekaeme ihn — sie kann ihn mit
  // KEINER ihrer Sitzungen oeffnen.
  //
  // **Nachgemessen (Gegenprobe): diese beiden Zeilen traegt nicht der
  // Schluesselwechsel, sondern Megolm selbst.** Mit ausgeschalteter
  // Mitglieder-Regel bleiben sie gruen, weil Dora dann den LAUFENDEN
  // Schluessel ab dem aktuellen Ratchet-Stand bekaeme — und der Ratchet
  // laeuft nur vorwaerts. Rot wird ohne die Regel allein die naechste Zeile.
  // Der Wechsel macht die Zusage also unabhaengig vom Ratchet-Stand, statt
  // sie erst zu schaffen. (Bei (b) ist es umgekehrt: dort ist der Wechsel
  // das Einzige, was traegt.)
  assert.equal(liesMitAllem(dora, erste.daten), null);
  assert.equal(lies(dora, erste.daten), null);
  assert.equal(zweite.grund, 'mitgliederwechsel');
  assert.equal(lies(dora, zweite.daten), 'jetzt mit Dora');
});

test('ein neues Geraet eines BESTEHENDEN Mitglieds kostet keine neue Sitzung', wennGebaut, () => {
  const anna = geraet('geraet-anna');
  const bert = geraet('geraet-bert');
  const bertZweit = geraet('geraet-bert-zweit');
  const welt: { stand: Gruppenstand<unknown> | null } = { stand: null };

  const erste = sende(welt, ['anna', 'bert'], [anna, bert], 'eins');
  verteile(erste, [anna, bert]);

  const zweite = sende(welt, ['anna', 'bert'], [anna, bert, bertZweit], 'zwei');
  verteile(zweite, [anna, bert, bertZweit]);

  // Dieselbe Sitzung laeuft weiter — nur das neue Geraet wird beliefert.
  assert.equal(zweite.grund, null);
  assert.deepEqual(
    zweite.schluesselAn.map((s) => s.pubkey),
    [bertZweit.pubkey]
  );
  assert.equal(lies(bertZweit, zweite.daten), 'zwei');
  // Und es sieht die aeltere Nachricht NICHT: der Verteilschluessel kommt ab
  // dem aktuellen Ratchet-Stand. Das ist hier kein Schutz, sondern der Preis
  // — ein frisch gekoppeltes Geraet startet in einer Gruppe leer.
  assert.equal(liesMitAllem(bertZweit, erste.daten), null);
});

test('eine Gruppensitzung ueberlebt einen Neustart (einfrieren/auftauen)', wennGebaut, () => {
  const anna = geraet('geraet-anna');
  const welt: { stand: Gruppenstand<unknown> | null } = { stand: null };
  const pickel = new Uint8Array(32).fill(11);

  const erste = sende(welt, ['anna', 'bert'], [anna], 'vor dem Neustart');
  verteile(erste, [anna]);
  assert.equal(lies(anna, erste.daten), 'vor dem Neustart');

  // Sende- UND Empfangsseite einfrieren und wieder auftauen — beides muss
  // gehen, sonst waere nach einem App-Neustart entweder keine Fortsetzung
  // moeglich (Sendeseite) oder jede offene Sitzung verloren (Empfangsseite).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const gefroren = (welt.stand!.sitzung as any).einfrieren(pickel);
  welt.stand = { ...welt.stand!, sitzung: modul.Gruppensitzung.auftauen(gefroren, pickel) };
  for (const [id, empfang] of anna.empfang) {
    anna.empfang.set(id, modul.Gruppenempfang.auftauen(empfang.einfrieren(pickel), pickel));
  }

  const zweite = sende(welt, ['anna', 'bert'], [anna], 'nach dem Neustart');
  verteile(zweite, [anna]);
  assert.equal(zweite.grund, null, 'derselbe Mitgliederstand -> dieselbe Sitzung');
  assert.equal(lies(anna, zweite.daten), 'nach dem Neustart');
});
