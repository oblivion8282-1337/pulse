/**
 * Die Stufen- und Last-Logik des FPS-Dropdowns (`settingsCatalog.ts`).
 *
 * Die Last-Grenze ist keine theoretische Rechnung: Jede Zeile hier entspringt
 * dem Vorfall vom 2026-08-20 (2560×1440@144 in AV1 10 bit brachte die
 * Videoeinheit eines Linux/AMD-Zuschauers zum Hängen, dieselbe Kombination in
 * 8 bit lief durch) — wer eine Grenze hier ändert, ändert eine Aussage über
 * echte Zuschauer-Hardware, keine Stilfrage.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FPS_VALUES,
  FPS_STANDARD,
  HQ_TEN_BIT_MAX_PIXELS_PER_SEC,
  fpsAllowed,
  allowedFpsSteps,
  snapFps,
} from '../src/lib/stream/settingsCatalog.ts';

const OHNE_LAST = null;

test('die Stufenliste enthält PAL-25 und endet bei 144', () => {
  assert.deepEqual(FPS_VALUES, [25, 30, 60, 90, 120, 144]);
});

test('ohne 10 bit gibt es keine Last-Begrenzung', () => {
  // 1440p@144 = 531 Mpix/s — in 8 bit genau die Kombination, die beim
  // Vorfall DURCHGELAUFEN ist. Sie muss erlaubt bleiben.
  const gross = { width: 2560, height: 1440 };
  assert.ok(fpsAllowed(144, false, gross, 1, 144));
  assert.deepEqual(allowedFpsSteps(false, gross, 1, 144), FPS_VALUES);
});

test('10 bit: 1080p trägt bis 144', () => {
  // 1920×1080×144 = 298,6 Mpix/s — knapp unter der Grenze.
  const hd = { width: 1920, height: 1080 };
  assert.deepEqual(allowedFpsSteps(true, hd, 1, 144), FPS_VALUES);
});

test('10 bit: 1440p wird auf 60 gedeckelt — der Vorfallsfall', () => {
  // 2560×1440×90 = 331 Mpix/s (drüber), ×60 = 221 Mpix/s (ok).
  const qhd = { width: 2560, height: 1440 };
  assert.deepEqual(allowedFpsSteps(true, qhd, 1, 144), [25, 30, 60]);
});

test('10 bit: 4K bleibt nur 25/30', () => {
  const uhd = { width: 3840, height: 2160 };
  assert.deepEqual(allowedFpsSteps(true, uhd, 1, 144), [25, 30]);
  // Und die Vorgabe („Standard" = 60) fällt damit weg — sie wird wie eine
  // Stufe geprüft, nicht durchgewinkt.
  assert.ok(!fpsAllowed(FPS_STANDARD, true, uhd, 1, 144));
});

test('10 bit: unbekannte Quelle (Linux-Portal) begrenzt nicht', () => {
  assert.deepEqual(allowedFpsSteps(true, OHNE_LAST, 1, 144), FPS_VALUES);
});

test('die Liste ist nie leer, auch nicht bei einer Riesenquelle', () => {
  // 5120×2880: selbst 25 Bilder/s liegen mit 369 Mpix/s über der Grenze.
  const riesig = { width: 5120, height: 2880 };
  assert.ok(!fpsAllowed(25, true, riesig, 1, 144));
  assert.deepEqual(allowedFpsSteps(true, riesig, 1, 144), [25]);
});

test('Admin-Grenzen gelten unabhängig von der Bittiefe', () => {
  assert.deepEqual(allowedFpsSteps(false, { width: 1920, height: 1080 }, 1, 60), [25, 30, 60]);
  // Alles weggefiltert (min über der höchsten Stufe) → kleinste Stufe bleibt.
  assert.deepEqual(allowedFpsSteps(false, null, 200, 360), [25]);
});

test('snapFps biegt auf die größte Stufe UNTER dem alten Wert', () => {
  const gedeckelt = [25, 30, 60];
  assert.equal(snapFps(144, gedeckelt), 60);
  assert.equal(snapFps(90, gedeckelt), 60);
  // PAL bleibt PAL — auch beim Wechsel auf 10 bit.
  assert.equal(snapFps(25, gedeckelt), 25);
  assert.equal(snapFps(60, gedeckelt), 60);
  // Ein Wert UNTER der Liste wird auf die kleinste Stufe angehoben.
  assert.equal(snapFps(20, gedeckelt), 25);
});

test('die Last-Grenze ist die vereinbarte 300-Mpix/s-Schwelle', () => {
  assert.equal(HQ_TEN_BIT_MAX_PIXELS_PER_SEC, 300_000_000);
  // Dieselbe Grenze steht im Sidecar als Spiegel
  // (`linux-hq-sidecar/src/lastgrenze.rs`) und greift dort beim Start, wo
  // die echte Quellgröße bekannt ist — synchron halten.
});
