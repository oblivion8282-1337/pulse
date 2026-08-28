/**
 * Gegenprobe zu `$lib/attachments/eingefuegteDateien.ts` — die Rechnung, die
 * beim Teilen von `MessageInput.svelte` (Etappe E) aus der Komponente
 * herauskam. Sie lag dort in einem Ereignis-Handler und war damit von keinem
 * Test erreichbar, obwohl sie zwei ueberraschende Regeln traegt: die 0-Byte-
 * Datei-Referenz im abgeschotteten Electron-Renderer und die Entdopplung
 * zwischen `items` und `files`.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  dateienAusEinfuegen,
  type EinfuegeEintrag
} from '../src/lib/attachments/eingefuegteDateien.ts';

function datei(name: string, size: number): File {
  return { name, size } as File;
}

function eintrag(kind: string, type: string, ergebnis: File | null): EinfuegeEintrag {
  return { kind, type, getAsFile: () => ergebnis };
}

describe('dateienAusEinfuegen', () => {
  test('nimmt ein eingefuegtes Bild aus den Zwischenablage-Eintraegen', () => {
    const bild = datei('bildschirmfoto.png', 4096);
    assert.deepEqual(dateienAusEinfuegen([eintrag('file', 'image/png', bild)], []), [bild]);
  });

  test('ignoriert Text-Eintraege — sonst faenge man jedes Einfuegen ab', () => {
    assert.deepEqual(dateienAusEinfuegen([eintrag('string', 'text/plain', null)], []), []);
  });

  test('verwirft eine 0-Byte-Datei (die Referenz im abgeschotteten Renderer)', () => {
    assert.deepEqual(dateienAusEinfuegen([], [datei('leer.png', 0)]), []);
    assert.deepEqual(
      dateienAusEinfuegen([eintrag('file', 'image/png', datei('leer.png', 0))], []),
      []
    );
  });

  test('entdoppelt dieselbe Datei aus beiden Quellen', () => {
    const aus_items = datei('gleich.png', 100);
    const aus_files = datei('gleich.png', 100);
    const ergebnis = dateienAusEinfuegen([eintrag('file', 'image/png', aus_items)], [aus_files]);
    assert.equal(ergebnis.length, 1);
    assert.equal(ergebnis[0], aus_items);
  });

  test('nimmt eine Nicht-Bild-Datei aus `files` mit', () => {
    const pdf = datei('bericht.pdf', 2048);
    assert.deepEqual(dateienAusEinfuegen([], [pdf]), [pdf]);
  });
});
