/**
 * Vorgabe von Quelle und Ton beim Öffnen des Stream-Dialogs (2026-09-20).
 *
 * Anlass: die gemerkte Ton-Wahl überlebte ihre App. Wer zuletzt
 * „App: Firefox" gewählt hatte und später ohne Firefox streamte, startete
 * stumm (Linux) bzw. ohne Ton (Windows) — die Auswahl stand noch, ihre App
 * war weg. Entscheidung: Quelle und Ton werden GAR NICHT mehr persistiert;
 * jeder Dialog-Öffnen beginnt bei der Vorgabe.
 *
 * Zwei Teile sind prüfbar:
 * 1. `tonVorgabeFuerPlatz` (rein, Node-ladbar): erster Platz trägt
 *    „Desktop", jeder weitere „Aus" — zwei gleichzeitige Streams mit demselben
 *    Ton kämen beim Zuschauer doppelt und versetzt an.
 * 2. Die Persistenzliste: `settingsState.svelte.ts` ist im Node-Läufer nicht
 *    ladbar (`$lib`-Import), deshalb per Quelltext — die vier Schlüssel
 *    dürfen nicht mehr drinstehen, `excluded_apps` (dauerhafte Präferenz,
 *    z. B. „Spotify immer raus") weiterhin.
 *
 * Ausgeführt mit Nodes eingebautem Testläufer: `pnpm test:unit`.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { tonVorgabeFuerPlatz } from '../src/lib/stream/settingsCatalog.ts';

describe('tonVorgabeFuerPlatz', () => {
  test('erster Platz trägt den Systemton', () => {
    assert.equal(tonVorgabeFuerPlatz(0), 'Desktop');
  });

  test('jeder weitere Platz startet stumm', () => {
    assert.equal(tonVorgabeFuerPlatz(1), 'Aus');
    assert.equal(tonVorgabeFuerPlatz(2), 'Aus');
  });
});

describe('Persistenz: Quelle und Ton überleben den Dialog nicht', () => {
  const quelltext = readFileSync(
    fileURLToPath(new URL('../src/lib/stream/settingsState.svelte.ts', import.meta.url)),
    'utf8',
  );
  const persistBlock =
    quelltext.match(/const PERSIST_KEYS = \[([\s\S]*?)\] as const;/)?.[1] ?? '';

  test('die vier Schlüssel stehen nicht mehr in PERSIST_KEYS', () => {
    assert.ok(persistBlock.length > 0, 'PERSIST_KEYS-Block gefunden');
    for (const verboten of ['audio_mode', 'audio_app', 'capture_source', 'capture_sources']) {
      assert.ok(
        !persistBlock.includes(`'${verboten}'`),
        `${verboten} darf nicht mehr persistiert werden`,
      );
    }
  });

  test('die Exclude-Liste bleibt gespeichert', () => {
    assert.ok(persistBlock.includes("'excluded_apps'"));
  });
});

describe('Ton-Kopplung: nur das App-Fenster koppelt (Michaels Entscheidung 2026-10-03)', () => {
  // Bis dahin stellte JEDER Quellen-Klick den Ton neu (Monitor → Desktop,
  // weiterer Platz → Aus) und warf damit handgewählte Ton-Quellen fort —
  // Firefox-Ton war nach einem Monitor-Wechsel weg. Jetzt koppelt nur das
  // App-Fenster (→ dessen App), die Vorgabe kommt allein aus dem Öffnen.
  // `captureSource.ts` ist im Node-Läufer nicht ladbar, deshalb per Quelltext.
  const quelltext = readFileSync(
    fileURLToPath(new URL('../src/lib/stream/captureSource.ts', import.meta.url)),
    'utf8',
  );
  const kopplung =
    quelltext.match(/export function applyAudioForCaptureSource[\s\S]*?\n}/)?.[0] ?? '';

  test('Kopplungsfunktion gefunden', () => {
    assert.ok(kopplung.length > 0, 'applyAudioForCaptureSource gefunden');
  });

  test('Monitor-Klicks stellen den Ton nicht mehr um', () => {
    assert.ok(!kopplung.includes("'Desktop'"), 'kein Monitor → Desktop mehr');
    assert.ok(!kopplung.includes("'Aus'"), 'kein weiterer Platz → Aus mehr');
    assert.ok(!kopplung.includes('slot'), 'die Funktion braucht keinen Platz-Parameter mehr');
  });

  test('das App-Fenster koppelt weiterhin seinen Ton', () => {
    assert.match(kopplung, /WINDOW_CAPTURE_PREFIX/);
    assert.match(kopplung, /audio_mode = APP_AUDIO_PREFIX \+ app/);
  });
});

describe('Laufende Streams werden vom Dialog-Reset nicht angetastet', () => {
  // Bughunt 2026-09-20: Der Status-Chip öffnet den Dialog FÜR laufende Slots,
  // und der Auto-Neustart (autoRestart.ts) liest Quelle und Ton live — ohne
  // diese Guards hätte ein Dialog-Öffnen den Neustart still auf Hauptmonitor
  // und Desktop-Ton umgeschaltet. `captureSource.ts` ist im Node-Läufer nicht
  // ladbar (`$lib`-Import), deshalb per Quelltext.
  const quelltext = readFileSync(
    fileURLToPath(new URL('../src/lib/stream/captureSource.ts', import.meta.url)),
    'utf8',
  );

  test('platzZuruecksetzen kehrt bei laufendem Slot sofort zurück', () => {
    assert.match(quelltext, /if \(streamForSlot\(slot\)\.running\) return;/);
  });

  test('der geteilte Ton bleibt weg, solange irgendein Slot streamt', () => {
    assert.match(quelltext, /if \(runningStreamSlots\(\)\.length > 0\) return;/);
  });
});
