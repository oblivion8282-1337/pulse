/**
 * Gegenprobe zu `$lib/krypto/geraeteEinrichtung.ts` (B11, 2026-09-02).
 *
 * Anlass: ein frisches App-Profil bekam die „braucht ein Geraet"-Wand, und
 * die App bot keinen Weg, DIESES Geraet einzurichten. Die Steuerung hier ist
 * der sichtbare Teil: der Lauf ist der gewoehnliche Geraete-Anmelde-Fluss,
 * und OB er geholfen hat, entscheidet allein das frisch nachgefragte eigene
 * Schloss — nicht die Behauptung des Laufs. Genau diese Semantik wird hier
 * geprueft, mit nachgebauten Abhaengigkeiten ohne Svelte/Netzwerk.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { geraeteEinrichtungErzeugen } from '../src/lib/krypto/geraeteEinrichtung.ts';

/** Nachbildung: der Lauf (im Betrieb `starteGeraeteAnmeldung`) und das
 *  frisch nachgefragte eigene Schloss (`schloss.erneutFragen`). */
function aufbau() {
  const stand = { laeuft: false, fehlgeschlagen: false };
  const control = {
    laeufe: 0,
    nachfragen: 0,
    laufFehler: null as Error | null,
    /** Was `erneutFragen` antwortet. */
    eigenerStand: false as boolean | undefined,
    /** Ob der Lauf den Stand hebt (der Server zaehlt das Geraet danach). */
    laufHeilt: true
  };

  const einrichtung = geraeteEinrichtungErzeugen(
    async () => {
      control.laeufe += 1;
      if (control.laufFehler) throw control.laufFehler;
      if (control.laufHeilt) control.eigenerStand = true;
    },
    async () => {
      control.nachfragen += 1;
      return control.eigenerStand;
    },
    stand
  );

  return { stand, control, einrichtung };
}

describe('geraeteEinrichtung — Erfolg', () => {
  test('Lauf gelaengt: frischer Stand true, kein Fehler gemeldet', async () => {
    const { stand, einrichtung } = aufbau();
    assert.equal(await einrichtung.starten(), true);
    assert.equal(stand.fehlgeschlagen, false);
    assert.equal(stand.laeuft, false);
  });

  test('Lauf ok, aber der Server zaehlt das Geraet noch nicht: Fehlschlag sichtbar', async () => {
    const { stand, control, einrichtung } = aufbau();
    // Genau die B11-Falle: der Fluss "gelingt", der eigene Stand bleibt
    // false — die Wand darf nicht verschwinden und nichts behaupten.
    control.laufHeilt = false;
    assert.equal(await einrichtung.starten(), false);
    assert.equal(stand.fehlgeschlagen, true);
  });

  test('Stand undefined (Schalter aus / Frage unmoeglich) gilt als nicht gelungen', async () => {
    const { stand, control, einrichtung } = aufbau();
    control.laufHeilt = false;
    control.eigenerStand = undefined;
    assert.equal(await einrichtung.starten(), false);
    assert.equal(stand.fehlgeschlagen, true);
  });
});

describe('geraeteEinrichtung — Fehlschlag des Laufs', () => {
  test('wird nicht verschluckt: fehlgeschlagen=true, Stand wird gar nicht erst nachgefragt', async () => {
    const { stand, control, einrichtung } = aufbau();
    control.laufFehler = new Error('Netz weg');
    assert.equal(await einrichtung.starten(), false);
    assert.equal(stand.fehlgeschlagen, true);
    assert.equal(control.nachfragen, 0);
  });

  test('nach einem Fehlschlag raeumt ein neuer Start die Meldung wieder weg', async () => {
    const { stand, control, einrichtung } = aufbau();
    control.laufFehler = new Error('Netz weg');
    await einrichtung.starten();
    assert.equal(stand.fehlgeschlagen, true);
    control.laufFehler = null;
    assert.equal(await einrichtung.starten(), true);
    assert.equal(stand.fehlgeschlagen, false);
  });
});

describe('geraeteEinrichtung — Automatik und Doppellauf', () => {
  test('automatischAnstossen laeuft hoechstens einmal je Seitenaufruf', () => {
    const { control, einrichtung } = aufbau();
    einrichtung.automatischAnstossen();
    einrichtung.automatischAnstossen();
    einrichtung.automatischAnstossen();
    assert.equal(control.laeufe, 1);
  });

  test('ein laufender Start verzehrt weitere Klicks', async () => {
    const { control, einrichtung } = aufbau();
    // Derselbe Tick: der zweite Aufruf sieht laeuft=true und startet nicht.
    const erster = einrichtung.starten();
    const zweiter = await einrichtung.starten();
    await erster;
    assert.equal(zweiter, false);
    assert.equal(control.laeufe, 1);
  });
});
