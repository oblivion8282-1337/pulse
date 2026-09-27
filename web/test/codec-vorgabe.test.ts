/**
 * Codec-Vorgabe nach GPU-Fähigkeit (2026-09-20): das Beste, was die Karte
 * hardwareseitig encodieren kann — AV1 vor HEVC vor H.264 —, jeweils 8 bit.
 *
 * Vorher war die Vorgabe binär (AV1, sonst H.264); HEVC, das der Zwischen-
 * generation überall fehlt, war nie vorgewählt. Nutzerwunsch: HEVC-Karten
 * starten auf „HEVC 8 bit", AV1-Karten auf „AV1 8 bit".
 *
 * 10 bit/HDR bleibt bewusst eine ausdrückliche Wahl im Codec-Feld
 * (`VIDEO_MODES`) — die Vorgabe nennt nur den Codec, keine Bittiefe.
 *
 * Ausgeführt mit Nodes eingebautem Testläufer: `pnpm test:unit`.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { codecVorgabeFuerGpu, codecAnpassungFuerGpu } from '../src/lib/stream/settingsCatalog.ts';

describe('codecVorgabeFuerGpu', () => {
  test('AV1-Karten (RTX 40xx und neuer) bekommen AV1', () => {
    assert.equal(codecVorgabeFuerGpu(true, true), 'av1');
  });

  test('HEVC ohne AV1 (Zwischengeneration, Mac mit VideoToolbox) bekommt HEVC', () => {
    assert.equal(codecVorgabeFuerGpu(false, true), 'hevc');
  });

  test('alte Karten bleiben bei H.264', () => {
    assert.equal(codecVorgabeFuerGpu(false, false), 'h264');
  });
});

describe('codecAnpassungFuerGpu — transiente Probe-Fehlschläge sind keine Fähigkeit', () => {
  // Bughunt 2026-09-20: Hat die Sidecar-Probe noch kein definitives Ergebnis
  // (Sidecar frisch gestartet, GPU-Reset), fehlt `video_codecs` in der Antwort.
  // Früher hat der Renderer die leere Fähigkeitsmenge als Fakt übernommen und
  // die gespeicherte Codec-Wahl still auf H.264 herabgestuft — dauerhaft, sobald
  // irgendeine Einstellung gespeichert wurde.

  test('unbekannte Fähigkeiten: keine Vorgabe, auch nicht für Erstnutzer', () => {
    assert.equal(codecAnpassungFuerGpu(false, false, false, undefined), undefined);
  });

  test('unbekannte Fähigkeiten: gespeicherte Wahl bleibt unangetastet', () => {
    assert.equal(codecAnpassungFuerGpu(false, false, false, 'av1'), undefined);
    assert.equal(codecAnpassungFuerGpu(false, false, false, 'hevc'), undefined);
  });

  test('bekannt: nichts Gespeichertes → GPU-Staffel als Vorgabe', () => {
    assert.equal(codecAnpassungFuerGpu(true, true, true, undefined), 'av1');
    assert.equal(codecAnpassungFuerGpu(true, false, true, undefined), 'hevc');
    assert.equal(codecAnpassungFuerGpu(true, false, false, undefined), 'h264');
  });

  test('bekannt: unmöglicher gespeicherter Codec stuft staffelkonform herab', () => {
    // av1 gewählt, Karte kann nur hevc → hevc (nicht sofort h264)
    assert.equal(codecAnpassungFuerGpu(true, false, true, 'av1'), 'hevc');
    // av1 gewählt, Karte kann nur h264
    assert.equal(codecAnpassungFuerGpu(true, false, false, 'av1'), 'h264');
    // hevc gewählt, nur h264 möglich
    assert.equal(codecAnpassungFuerGpu(true, false, false, 'hevc'), 'h264');
  });

  test('bekannt: erfüllbare und H.264-Wahlen bleiben unangetastet', () => {
    assert.equal(codecAnpassungFuerGpu(true, true, true, 'av1'), undefined);
    assert.equal(codecAnpassungFuerGpu(true, false, true, 'hevc'), undefined);
    assert.equal(codecAnpassungFuerGpu(true, true, true, 'h264'), undefined);
  });
});
