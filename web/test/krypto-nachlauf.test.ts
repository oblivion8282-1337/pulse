import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mitNachlaufBeiWeckung } from '../src/lib/krypto/postfachNachlauf.ts';

/**
 * Prueft `mitNachlaufBeiWeckung` (`empfangen.ts::laufenderZyklus`-Nachfolger):
 * eine Weckung, die WAEHREND eines laufenden Zyklus eintrifft, darf nicht
 * verlorengehen, aber auch keinen Dauerlauf ausloesen. S. Modulkopf der
 * geprueften Datei fuer die volle Begruendung.
 */

function warte(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Baut eine steuerbare `aufgabe()`: jeder Aufruf legt sein Ergebnis erst
 *  frei, wenn `freigeben()` fuer genau diesen Aufruf gerufen wurde — so
 *  lassen sich Weckungen gezielt WAEHREND eines laufenden Zyklus ausloesen. */
function steuerbareAufgabe() {
  let anzahlAufrufe = 0;
  const freigaben: Array<() => void> = [];
  const fehlschlagen = new Set<number>();

  async function aufgabe(): Promise<number> {
    const eigeneNummer = anzahlAufrufe;
    anzahlAufrufe += 1;
    await new Promise<void>((resolve) => {
      freigaben[eigeneNummer] = resolve;
    });
    if (fehlschlagen.has(eigeneNummer)) throw new Error(`Lauf ${eigeneNummer} kaputt`);
    return eigeneNummer;
  }

  return {
    aufgabe,
    anzahlAufrufe: () => anzahlAufrufe,
    freigeben: async (nummer: number) => {
      // `freigaben[nummer]` existiert erst, sobald `aufgabe` selbst schon
      // laeuft — kurz abwarten, bis der Aufruf sich eingetragen hat.
      while (!freigaben[nummer]) await warte(0);
      freigaben[nummer]();
    },
    alsFehlschlagMarkieren: (nummer: number) => fehlschlagen.add(nummer)
  };
}

test('ohne Weckung waehrend des Laufs laeuft nichts nach', async () => {
  const { aufgabe, anzahlAufrufe, freigeben } = steuerbareAufgabe();
  const ausloesen = mitNachlaufBeiWeckung(aufgabe);

  const ergebnis = ausloesen();
  await freigeben(0);
  assert.equal(await ergebnis, 0);

  // Kurz warten (Microtask-Runde des `.finally`) — kein zweiter Aufruf darf
  // von selbst entstehen.
  await warte(5);
  assert.equal(anzahlAufrufe(), 1);
});

test('eine Weckung waehrend des Laufs fuehrt zu genau einem weiteren Durchlauf', async () => {
  const { aufgabe, anzahlAufrufe, freigeben } = steuerbareAufgabe();
  const ausloesen = mitNachlaufBeiWeckung(aufgabe);

  const erste = ausloesen();
  await warte(0); // sicherstellen, dass Lauf 0 wirklich schon begonnen hat
  const zweite = ausloesen(); // die Weckung WAEHREND des Laufs

  assert.equal(anzahlAufrufe(), 1, 'die Weckung darf keinen zweiten Lauf sofort starten');

  await freigeben(0);
  // Der Nachlauf startet erst, NACHDEM Lauf 0 sich entschieden hat.
  await warte(0);
  assert.equal(anzahlAufrufe(), 2, 'die vermerkte Weckung muss einen Nachlauf ausloesen');

  await freigeben(1);
  assert.equal(await erste, 0, 'die erste Aufruferin sieht das Ergebnis ihres eigenen Laufs');
  assert.equal(
    await zweite,
    1,
    'wer waehrend des Laufs weckte, muss das Ergebnis des NACHLAUFS sehen — nicht das des schon laufenden Zyklus'
  );
});

test('zehn Weckungen waehrend des Laufs fuehren zu einem Nachlauf, nicht zu zehn', async () => {
  const { aufgabe, anzahlAufrufe, freigeben } = steuerbareAufgabe();
  const ausloesen = mitNachlaufBeiWeckung(aufgabe);

  const erste = ausloesen();
  await warte(0);
  const weitere = Array.from({ length: 10 }, () => ausloesen());

  assert.equal(anzahlAufrufe(), 1);
  await freigeben(0);
  await warte(0);
  // Genau EIN Nachlauf, kein Dauerlauf und keine Warteschlange von zehn.
  assert.equal(anzahlAufrufe(), 2);

  await freigeben(1);
  await erste;
  for (const versprechen of weitere) {
    assert.equal(await versprechen, 1, 'alle zehn Weckungen teilen sich denselben Nachlauf');
  }
  // Nach dem Nachlauf darf ohne weitere Weckung kein dritter Lauf entstehen.
  await warte(5);
  assert.equal(anzahlAufrufe(), 2);
});

test('eine Weckung nach Abschluss startet einen neuen, unabhaengigen Lauf', async () => {
  const { aufgabe, anzahlAufrufe, freigeben } = steuerbareAufgabe();
  const ausloesen = mitNachlaufBeiWeckung(aufgabe);

  const erste = ausloesen();
  await freigeben(0);
  assert.equal(await erste, 0);
  await warte(5); // Zyklus ist fertig, kein Nachlauf vorgemerkt

  const zweite = ausloesen();
  await freigeben(1);
  assert.equal(await zweite, 1);
  assert.equal(anzahlAufrufe(), 2);
});

test('ein scheiternder Lauf haelt den vorgemerkten Nachlauf nicht auf', async () => {
  const { aufgabe, anzahlAufrufe, freigeben, alsFehlschlagMarkieren } = steuerbareAufgabe();
  alsFehlschlagMarkieren(0);
  const ausloesen = mitNachlaufBeiWeckung(aufgabe);

  const erste = ausloesen();
  await warte(0);
  const zweite = ausloesen();

  await freigeben(0);
  await assert.rejects(erste, /Lauf 0 kaputt/);

  await warte(0);
  assert.equal(anzahlAufrufe(), 2, 'der Nachlauf muss trotz Fehlschlag des ersten Laufs starten');

  await freigeben(1);
  assert.equal(await zweite, 1);
});

test('nie zwei Laeufe gleichzeitig unterwegs', async () => {
  const laufend = new Set<number>();
  let maxGleichzeitig = 0;
  let zaehler = 0;

  async function aufgabe(): Promise<number> {
    const eigene = zaehler;
    zaehler += 1;
    laufend.add(eigene);
    maxGleichzeitig = Math.max(maxGleichzeitig, laufend.size);
    await warte(5);
    laufend.delete(eigene);
    return eigene;
  }

  const ausloesen = mitNachlaufBeiWeckung(aufgabe);
  const alle = [ausloesen(), ausloesen(), ausloesen(), ausloesen()];
  await Promise.all(alle);

  assert.equal(maxGleichzeitig, 1, 'zu keinem Zeitpunkt darf mehr als eine Aufgabe laufen');
});
