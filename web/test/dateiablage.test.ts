import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  packeDateiContainer,
  öffneDateiContainer,
  leeresVerzeichnis,
  verschlüsseleVerzeichnis,
  öffneVerzeichnis,
  DateiablageFehler,
  VerzeichnisFehler,
} from '../src/lib/ablage/dateiablage.ts';
import { DateiSpeicher } from '../src/lib/ablage/dateispeicher.ts';
import { speicherAdapter } from '../src/lib/ablage/adapter.ts';

// 32 zufällige Bytes — derselbe Schlüssel für alle Tests in dieser Datei.
const SCHLÜSSEL = globalThis.crypto.getRandomValues(new Uint8Array(32));

const pngBytes = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test('packeDateiContainer + öffneDateiContainer — Roundtrip ohne Verlust', async () => {
  const inhalt = pngBytes();
  const kopf = {
    fassung: 1,
    name: 'foto.png',
    mime: 'image/png',
    groesse: inhalt.length,
    hochgeladenAm: '2026-08-31T10:00:00Z',
    hochgeladenVon: 'dev',
  };
  const container = await packeDateiContainer(SCHLÜSSEL, kopf, inhalt);

  // Der Container trägt den Klartext-Dateinamen NICHT im Klartext.
  const text = new TextDecoder().decode(container);
  assert.ok(!text.includes('foto.png'), 'Dateiname im Klartext gefunden');
  assert.ok(!text.includes('image/png'), 'MIME-Typ im Klartext gefunden');

  const ergebnis = await öffneDateiContainer(SCHLÜSSEL, container);
  assert.equal(ergebnis.kopf.name, 'foto.png');
  assert.equal(ergebnis.kopf.mime, 'image/png');
  assert.deepEqual(ergebnis.inhalt, inhalt);
});

test('falscher Schlüssel — Entschlüsselung schlägt fehl', async () => {
  const inhalt = new TextEncoder().encode('geheim');
  const container = await packeDateiContainer(SCHLÜSSEL, kopf('geheim.txt', 'text/plain', inhalt.length), inhalt);
  const FALSCHER = new TextEncoder().encode('falscher-schluessel-32-bytes--ok!');
  await assert.rejects(() => öffneDateiContainer(FALSCHER, container));
});

test('manipulierter Container — Entschlüsselung schlägt fehl', async () => {
  const inhalt = new TextEncoder().encode('manipuliert-werden-soll-nicht');
  const container = await packeDateiContainer(SCHLÜSSEL, kopf('x.txt', 'text/plain', inhalt.length), inhalt);
  const manipuliert = new Uint8Array(container);
  manipuliert[manipuliert.length - 4] ^= 0xff; // ein Byte im Ciphertext flippen
  await assert.rejects(() => öffneDateiContainer(SCHLÜSSEL, manipuliert));
});

function kopf(name: string, mime: string, groesse: number) {
  return {
    fassung: 1,
    name,
    mime,
    groesse,
    hochgeladenAm: '2026-08-31T10:00:00Z',
    hochgeladenVon: 'dev',
  };
}

test('Verzeichnis: Roundtrip', async () => {
  const leer = leeresVerzeichnis();
  leer.einträge.push({
    id: 'abc123',
    datei: 'a-abc123.puls',
    name: 'probe.txt',
    mime: 'text/plain',
    groesse: 42,
    hochgeladenAm: '2026-08-31T10:00:00Z',
    hochgeladenVon: 'dev',
  });
  const dunkel = await verschlüsseleVerzeichnis(SCHLÜSSEL, leer);
  const offen = await öffneVerzeichnis(SCHLÜSSEL, dunkel);
  assert.equal(offen.einträge.length, 1);
  assert.equal(offen.einträge[0].name, 'probe.txt');
  assert.equal(offen.einträge[0].id, 'abc123');
});

test('Verzeichnis mit falschem Schlüssel — Fehler', async () => {
  const leer = leeresVerzeichnis();
  const dunkel = await verschlüsseleVerzeichnis(SCHLÜSSEL, leer);
  const FALSCHER = globalThis.crypto.getRandomValues(new Uint8Array(32));
  await assert.rejects(() => öffneVerzeichnis(FALSCHER, dunkel), VerzeichnisFehler);
});

test('DateiSpeicher: hochladen, auflisten, herunterladen', async () => {
  const ablage = speicherAdapter();
  const speicher = new DateiSpeicher(ablage, 'projekt', SCHLÜSSEL);

  const info = await speicher.hochladen('brief.pdf', 'application/pdf', new TextEncoder().encode('PDF-Inhalt'), 'dev');
  assert.ok(info.id.length > 0);
  assert.equal(info.groesse, 10);

  const liste = await speicher.liste();
  assert.equal(liste.length, 1);
  assert.equal(liste[0].name, 'brief.pdf');

  const heruntergeladen = await speicher.herunterladen(info.id);
  assert.deepEqual(heruntergeladen.inhalt, new TextEncoder().encode('PDF-Inhalt'));
  assert.equal(heruntergeladen.name, 'brief.pdf');
  assert.equal(heruntergeladen.mime, 'application/pdf');
});

test('DateiSpeicher: herunterladen einer fehlenden Datei wirft', async () => {
  const ablage = speicherAdapter();
  const speicher = new DateiSpeicher(ablage, 'projekt', SCHLÜSSEL);
  await assert.rejects(() => speicher.herunterladen('nicht-existiert'), DateiablageFehler);
});

test('DateiSpeicher: löschen entfernt Eintrag und Datei', async () => {
  const ablage = speicherAdapter();
  const speicher = new DateiSpeicher(ablage, 'projekt', SCHLÜSSEL);
  const info = await speicher.hochladen('weg.txt', 'text/plain', new TextEncoder().encode('weg'));

  await speicher.löschen(info.id);

  const liste = await speicher.liste();
  assert.equal(liste.length, 0);
  const container = await ablage.lese(`a-${info.id}.puls`);
  assert.equal(container, null, 'Datei noch auf dem Laufwerk');
});

test('DateiSpeicher: neue Instanz ohne vorherige Dateien — leere Ablage', async () => {
  const ablage = speicherAdapter();
  const speicher = new DateiSpeicher(ablage, 'leer', SCHLÜSSEL);
  const liste = await speicher.liste();
  assert.deepEqual(liste, []);
});
