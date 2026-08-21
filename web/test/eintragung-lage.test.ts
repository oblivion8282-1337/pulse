import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eintragungLage } from '../src/lib/devices/eintragungLage.ts';

const grund = {
  hatEintragung: true,
  geraetGefunden: false,
  communityListeGeladen: true,
  communityBekannt: true,
  geraeteListeGeladen: false,
};

test('ohne lokale Eintragung ist der Rechner einfach nicht eingetragen', () => {
  assert.equal(eintragungLage({ ...grund, hatEintragung: false }), 'keine');
});

test('aufgeloeste Geraetezeile heisst eingetragen', () => {
  assert.equal(eintragungLage({ ...grund, geraetGefunden: true }), 'eingetragen');
});

test('solange keine Antwort da ist, wird nicht geurteilt', () => {
  assert.equal(eintragungLage(grund), 'laedt');
});

test('Community nicht in der Liste des ready-Rahmens: verwaist', () => {
  // Der eigentliche Fall des Bughunts vom 2026-08-21 — Community verlassen,
  // geloescht oder aus ihr entfernt. Die Geraeteliste kommt hier NIE, weil der
  // Abruf in ein 403 laeuft; wer auf sie wartete, bliebe ewig bei „laedt".
  assert.equal(
    eintragungLage({ ...grund, communityBekannt: false, geraeteListeGeladen: false }),
    'verwaist',
  );
});

test('Communityliste noch nicht geseedet: kein Urteil ueber die Community', () => {
  assert.equal(
    eintragungLage({ ...grund, communityListeGeladen: false, communityBekannt: false }),
    'laedt',
  );
});

test('Geraeteliste vollstaendig abgerufen und die Zeile fehlt: verwaist', () => {
  // Community ist da, der Abruf ging durch — dann ist „nicht enthalten" eine
  // Aussage und keine Vermutung.
  assert.equal(eintragungLage({ ...grund, geraeteListeGeladen: true }), 'verwaist');
});

test('eine gefundene Zeile sticht jede Verwaisungs-Anzeige', () => {
  assert.equal(
    eintragungLage({
      ...grund,
      geraetGefunden: true,
      communityBekannt: false,
      geraeteListeGeladen: true,
    }),
    'eingetragen',
  );
});
