import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startAdresse } from '../electron/startAdresse.ts';

test('die Normal-App startet auf /app, nie auf der Landingpage', () => {
  // Die Wurzel ist in der Cloud die Werbeseite, und die leitet nur
  // Angemeldete weiter — ohne Sitzung saesse der Nutzer dort fest.
  assert.equal(startAdresse('https://howispulse.com', false), 'https://howispulse.com/app');
});

test('die Dev-Adresse bekommt denselben Pfad', () => {
  assert.equal(startAdresse('http://localhost:5173', false), 'http://localhost:5173/app');
});

test('ein Schraegstrich am Ende erzeugt keinen doppelten', () => {
  assert.equal(startAdresse('https://howispulse.com/', false), 'https://howispulse.com/app');
});

test('die Server-App startet ihre Login-Phase auf /login, nicht auf /app', () => {
  // `startLoginWatch` haelt jede Navigation nach /app fuer einen Login-Erfolg;
  // ein Start direkt dort wuerde ohne Sitzung auf server.html wechseln.
  assert.equal(startAdresse('https://howispulse.com', true), 'https://howispulse.com/login');
});
