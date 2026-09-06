/**
 * Gegenprobe zur Nutzdaten-Verschluesselung der Anhaenge
 * (`$lib/krypto/anhangKrypto.ts`, Etappe E).
 *
 * Der Test, auf den es ankommt, ist der erste: **verlustfrei**. Ein Anhang
 * hat keine zweite Kopie — was hier ein Byte verliert, ist ein kaputtes Bild
 * beim Empfaenger, und niemand merkt es an einer Fehlermeldung. Die uebrigen
 * sichern die Zusicherungen, die der Modulkopf gibt: das Siegel faellt auf,
 * ein fremder Schluessel oeffnet nicht, und zwei Verschluesselungen ergeben
 * nie denselben Klumpen (der IV ist wirklich frisch).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  IV_LAENGE,
  neuerDateischluessel,
  verschluessele,
  entschluessele,
  schluesselAlsText,
  schluesselAusText
} from '../src/lib/krypto/anhangKrypto.ts';

function bytes(...werte: number[]): Uint8Array {
  return new Uint8Array(werte);
}

describe('Anhang-Verschluesselung', () => {
  test('ist verlustfrei — auch bei einem leeren und einem grossen Klumpen', async () => {
    const schluessel = neuerDateischluessel();
    for (const klartext of [
      new Uint8Array(0),
      bytes(0, 1, 2, 253, 254, 255),
      crypto.getRandomValues(new Uint8Array(64 * 1024))
    ]) {
      // Je Durchgang ein eigener Schluessel — genau so, wie der Upload es
      // tut (ein Schluessel, eine Verschluesselung, s. Modulkopf dort).
      const eigener = neuerDateischluessel();
      const klumpen = await verschluessele(eigener, klartext);
      const zurueck = await entschluessele(eigener, klumpen);
      assert.deepEqual(Array.from(zurueck), Array.from(klartext));
    }
    // Und der ganz oben erzeugte Schluessel bleibt ungenutzt gueltig.
    assert.equal(schluessel.length, 32);
  });

  test('der Klumpen traegt den IV vorne und ist laenger als der Klartext', async () => {
    const schluessel = neuerDateischluessel();
    const klartext = bytes(1, 2, 3, 4);
    const klumpen = await verschluessele(schluessel, klartext);
    // IV + Klartext + 16 Byte GCM-Siegel.
    assert.equal(klumpen.length, IV_LAENGE + klartext.length + 16);
  });

  test('zwei Verschluesselungen ergeben nie denselben Klumpen', async () => {
    // Wuerde der IV fest gewaehlt, waere das hier gleich — und genau das ist
    // die Bedingung, an der GCM zerbricht.
    const a = await verschluessele(neuerDateischluessel(), bytes(7, 7, 7));
    const b = await verschluessele(neuerDateischluessel(), bytes(7, 7, 7));
    assert.notDeepEqual(Array.from(a), Array.from(b));
  });

  test('ein veraenderter Klumpen laesst sich NICHT oeffnen', async () => {
    const schluessel = neuerDateischluessel();
    const klumpen = await verschluessele(schluessel, bytes(9, 8, 7, 6, 5));
    klumpen[klumpen.length - 1] ^= 0x01; // ein einziges gekipptes Bit
    await assert.rejects(() => entschluessele(schluessel, klumpen));
  });

  test('ein fremder Schluessel oeffnet nicht', async () => {
    const klumpen = await verschluessele(neuerDateischluessel(), bytes(1, 2, 3));
    await assert.rejects(() => entschluessele(neuerDateischluessel(), klumpen));
  });

  test('ein zu kurzer Klumpen wird abgewiesen, statt Muell zu liefern', async () => {
    await assert.rejects(() => entschluessele(neuerDateischluessel(), new Uint8Array(IV_LAENGE)));
  });

  test('Schluessel-Text laeuft verlustfrei hin und zurueck', () => {
    const schluessel = neuerDateischluessel();
    assert.deepEqual(
      Array.from(schluesselAusText(schluesselAlsText(schluessel))),
      Array.from(schluessel)
    );
  });

  test('ein Text falscher Laenge gilt nicht als Schluessel', () => {
    assert.throws(() => schluesselAusText(schluesselAlsText(new Uint8Array(16))));
  });
});
