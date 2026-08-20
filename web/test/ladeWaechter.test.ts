import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dedupliziertLaden } from '../src/lib/devices/ladeWaechter.ts';
import { umziehenNoetig } from '../src/lib/remote/umzugRegel.ts';

test('ueberlappende Laeufe teilen sich das Ergebnis, statt es zu verlieren', async () => {
  let abrufe = 0;
  let freigabeAufloesen: (v: string[]) => void = () => {};
  const abruf = () =>
    new Promise<string[]>((resolve) => {
      abrufe++;
      freigabeAufloesen = resolve;
    });

  const laufend = new Map<string, Promise<string[]>>();
  // Lauf 1 startet (WS-Verbindung A) und wartet auf die HTTP-Antwort.
  const lauf1 = dedupliziertLaden(laufend, 'device-1', abruf);
  // Lauf 2 startet, WAEHREND Lauf 1 noch offen ist (Reconnect-Race nach
  // einem WS-Abriss, der die parallele HTTP-Anfrage nicht killt).
  const lauf2 = dedupliziertLaden(laufend, 'device-1', abruf);

  // Der Server antwortet mit der dort gepflegten, NICHT-leeren Liste.
  freigabeAufloesen(['bestehende-freigabe']);

  const [ergebnis1, ergebnis2] = await Promise.all([lauf1, lauf2]);

  assert.equal(abrufe, 1, 'nur EIN echter Abruf, kein zweiter parallel gestarteter');
  assert.deepEqual(ergebnis1, ['bestehende-freigabe']);
  assert.deepEqual(ergebnis2, ['bestehende-freigabe']);

  // Angewandt auf die Umzugsregel: der zweite (ueberlappende) Aufrufer sieht
  // dieselbe, nicht-leere Server-Liste wie der erste — kein Ueberschreiben.
  assert.equal(
    umziehenNoetig({
      lokalVorhanden: true,
      serverListeLeer: ergebnis2.length === 0,
      bereitsUmgezogen: false,
    }),
    false,
  );
});

test('nach Abschluss loest ein neuer Aufruf wieder einen echten Abruf aus', async () => {
  let abrufe = 0;
  const laufend = new Map<string, Promise<number>>();
  const abruf = async () => {
    abrufe++;
    return abrufe;
  };
  await dedupliziertLaden(laufend, 'x', abruf);
  await dedupliziertLaden(laufend, 'x', abruf);
  assert.equal(abrufe, 2, 'nach dem Ende des ersten Laufs ist die Bremse wieder offen');
});

test('verschiedene Schluessel bremsen sich nicht gegenseitig', async () => {
  let abrufe = 0;
  const laufend = new Map<string, Promise<number>>();
  const abruf = async () => {
    abrufe++;
    return abrufe;
  };
  await Promise.all([dedupliziertLaden(laufend, 'a', abruf), dedupliziertLaden(laufend, 'b', abruf)]);
  assert.equal(abrufe, 2);
});

test('ein fehlgeschlagener Abruf raeumt auf — der naechste Aufruf versucht es erneut', async () => {
  let abrufe = 0;
  const laufend = new Map<string, Promise<void>>();
  const abruf = async () => {
    abrufe++;
    if (abrufe === 1) throw new Error('kein Netz');
  };
  await assert.rejects(dedupliziertLaden(laufend, 'y', abruf));
  await dedupliziertLaden(laufend, 'y', abruf);
  assert.equal(abrufe, 2);
});
