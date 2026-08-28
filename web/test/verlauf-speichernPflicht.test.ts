import { test } from 'node:test';
import assert from 'node:assert/strict';

// FIX 1 (Bughunt 2026-08-28): `verlaufSpeichernPflicht` darf "nichts
// gespeichert" nie als Erfolg (Rueckgabewert `0` ohne Wurf) melden —
// `krypto/quittierbareIds.ts` wertet jeden nicht werfenden Aufruf als
// Erfolg und quittiert dann eine Zustellung, deren einzige Kopie nirgends
// abgelegt wurde. Geprueft wird die importfreie Entscheidung aus
// `speichernPflicht.ts`, s. dessen Modulkopf, warum nicht `index.ts` direkt.
import {
  pruefeSpeicherErgebnis,
  VerlaufSpeichernFehlgeschlagen
} from '../src/lib/verlauf/speichernPflicht.ts';

test('ein noch unbekannter DM-Kanal wirft, statt als Erfolg zu gelten', () => {
  // Der haeufigste konkrete Fall: die erste Nachricht eines Gespraechs, das
  // der Klient lokal noch nicht kennt.
  assert.throws(
    () => pruefeSpeicherErgebnis('kanal-neu', false, 0),
    VerlaufSpeichernFehlgeschlagen
  );
});

test('keine speicherbaren Saetze wirft ebenfalls, statt als Erfolg zu gelten', () => {
  // Kanal ist bekannt, aber `baueSaetze` hat alles herausgefiltert.
  assert.throws(
    () => pruefeSpeicherErgebnis('kanal-bekannt', true, 0),
    VerlaufSpeichernFehlgeschlagen
  );
});

test('ein bekannter Kanal mit mindestens einem Satz wirft nicht', () => {
  assert.doesNotThrow(() => pruefeSpeicherErgebnis('kanal-bekannt', true, 1));
});
