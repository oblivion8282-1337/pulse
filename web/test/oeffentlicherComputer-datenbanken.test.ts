import { test } from 'node:test';
import assert from 'node:assert/strict';

import { OEFFENTLICHER_COMPUTER_DATENBANKEN } from '../src/lib/components/settings/oeffentlicherComputerDatenbanken.ts';

// Bughunt 2026-08-29, Befund 2: der "oeffentlicher Computer"-Knopf loeschte
// nur `pulse-identity` + `pulse-stream` — die Liste wurde nie nachgezogen,
// als der lokale Verlauf (`pulse-verlauf`, die EINZIGE Kopie verschluesselter
// Nachrichten samt entschluesselter Anhang-Bytes) dazukam.

test('die Loeschliste enthaelt den lokalen Verlauf', () => {
  assert.ok(
    OEFFENTLICHER_COMPUTER_DATENBANKEN.includes('pulse-verlauf'),
    'pulse-verlauf fehlt — die einzige Kopie verschluesselter Nachrichten bliebe auf einem geteilten Geraet stehen'
  );
});

test('die Loeschliste enthaelt weiterhin die bisherigen Datenbanken', () => {
  assert.ok(OEFFENTLICHER_COMPUTER_DATENBANKEN.includes('pulse-identity'));
  assert.ok(OEFFENTLICHER_COMPUTER_DATENBANKEN.includes('pulse-stream'));
});

test('die Loeschliste enthaelt die Presence-Datenbank', () => {
  // `StatusPicker.svelte`/`service-worker.ts` — traegt keinen Nachrichten-
  // inhalt, gehoert aber ebenso zum vorigen Nutzer.
  assert.ok(OEFFENTLICHER_COMPUTER_DATENBANKEN.includes('pulse_presence'));
});

test('die Loeschliste kennt JEDE Datenbank, die die App oeffnet', async () => {
  // Der eigentliche Fix, und der Grund steht in der Geschichte dieser Datei:
  // die Tests darueber zaehlen bekannte Namen einzeln auf und koennen eine
  // NEUE vergessene Datenbank grundsaetzlich nicht finden. Genau das ist
  // zweimal passiert — erst mit `pulse-verlauf` (Bughunt 2026-08-29), dann
  // mit `pulse-ablage-verbindungen`, die die Zugaenge zu fremden Cloud-
  // Systemen traegt und trotzdem stehenblieb, waehrend der Knopf versprach,
  // alle lokalen Daten zu loeschen.
  //
  // Dieser Test sucht deshalb im Quelltext statt in einer Merkliste: jede
  // Datei, die `indexedDB.open(` aufruft, wird nach `pulse`-Namen abgesucht,
  // und jeder gefundene Name muss in der Loeschliste stehen. Die Heuristik
  // ist bewusst grob — sie darf lieber einmal zu viel anschlagen als eine
  // Datenbank uebersehen.
  const { readdirSync, readFileSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');

  const dateien: string[] = [];
  const sammle = (ordner: string): void => {
    for (const eintrag of readdirSync(ordner)) {
      const pfad = join(ordner, eintrag);
      if (statSync(pfad).isDirectory()) sammle(pfad);
      else if (/\.(ts|svelte)$/.test(eintrag)) dateien.push(pfad);
    }
  };
  sammle('src');

  // Genau zwei Formen zaehlen, damit der Test nicht an Kommentaren und
  // localStorage-Schluesseln haengenbleibt: der Name direkt im Aufruf, und
  // die Konstante, die ueblicherweise davorsteht.
  const DIREKT = /indexedDB\.open\(\s*'([^']+)'/g;
  const KONSTANTE = /\b(?:DB_NAME|DATENBANK|DB)\s*=\s*'([^']+)'/g;

  const gefunden = new Set<string>();
  for (const pfad of dateien) {
    const text = readFileSync(pfad, 'utf8');
    if (!text.includes('indexedDB.open(')) continue;
    for (const treffer of text.matchAll(DIREKT)) gefunden.add(treffer[1]);
    for (const treffer of text.matchAll(KONSTANTE)) gefunden.add(treffer[1]);
  }

  assert.ok(gefunden.size > 0, 'Testaufbau: es wurde keine einzige Datenbank gefunden');

  const liste: readonly string[] = OEFFENTLICHER_COMPUTER_DATENBANKEN;
  const fehlend = [...gefunden].filter((n) => !liste.includes(n));
  assert.deepEqual(
    fehlend,
    [],
    `Diese Datenbanken werden geoeffnet, aber vom "oeffentlicher Computer"-Knopf nicht geloescht: ${fehlend.join(', ')}. ` +
      'Entweder in die Liste aufnehmen oder hier begruenden, warum sie stehenbleiben darf.'
  );
});

