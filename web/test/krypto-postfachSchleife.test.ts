import { test } from 'node:test';
import assert from 'node:assert/strict';

// FIX 2 (Bughunt 2026-08-28): `postfachZyklus` (`empfangen.ts`) teilt EIN
// geladenes `Identitaet`-Objekt ueber die ganze Abholschleife. Scheitert das
// atomare Konto+Sitzungs-Sichern fuer eine Zustellung, bleibt das Konto im
// Arbeitsspeicher mit einer verbrauchten, aber nicht durabel gesicherten
// Mutation zurueck — eine SPAETERE erfolgreiche Zustellung wuerde diesen
// Zwischenstand sonst kumulativ mit einfrieren. Geprueft wird die
// importfreie Abbruch-Schleife, s. deren Modulkopf.
import { verarbeiteBisAbbruch } from '../src/lib/krypto/postfachSchleife.ts';

class Abbruchfehler extends Error {}
class AndererFehler extends Error {}

test('bricht NACH dem ersten Abbruchgrund ab und verarbeitet Nachfolgende nicht', async () => {
  const versucht: number[] = [];
  const verarbeite = async (n: number) => {
    versucht.push(n);
    if (n === 2) throw new Abbruchfehler('Konto/Sitzung nicht sicherbar');
    return n * 10;
  };

  const { ergebnisse, abgebrochen } = await verarbeiteBisAbbruch(
    [1, 2, 3, 4],
    verarbeite,
    (err) => err instanceof Abbruchfehler
  );

  // Element 1 wurde erfolgreich verarbeitet, Element 2 hat abgebrochen —
  // Elemente 3 und 4 duerfen GAR NICHT versucht worden sein: haette die
  // Schleife weitergelaufen, koennte eine ihrer erfolgreichen Verarbeitungen
  // genau den kompromittierten Zwischenstand einfrieren, den FIX 2
  // verhindern soll.
  assert.deepEqual(versucht, [1, 2]);
  assert.deepEqual(ergebnisse, [10]);
  assert.equal(abgebrochen, true);
});

test('bereits erfolgreich verarbeitete Elemente bleiben im Ergebnis', async () => {
  const { ergebnisse } = await verarbeiteBisAbbruch(
    [1, 2, 3],
    async (n) => {
      if (n === 3) throw new Abbruchfehler('kaputt');
      return `ok-${n}`;
    },
    (err) => err instanceof Abbruchfehler
  );
  assert.deepEqual(ergebnisse, ['ok-1', 'ok-2']);
});

test('ein anderer Fehler wird weitergereicht, statt die Schleife nur anzuhalten', async () => {
  await assert.rejects(
    verarbeiteBisAbbruch(
      [1, 2],
      async (n) => {
        if (n === 1) throw new AndererFehler('unlesbarer Umschlag');
        return n;
      },
      (err) => err instanceof Abbruchfehler
    ),
    AndererFehler
  );
});

test('ohne Fehler laeuft die gesamte Liste durch', async () => {
  const { ergebnisse, abgebrochen } = await verarbeiteBisAbbruch(
    [1, 2, 3],
    async (n) => n * 2,
    (err) => err instanceof Abbruchfehler
  );
  assert.deepEqual(ergebnisse, [2, 4, 6]);
  assert.equal(abgebrochen, false);
});
