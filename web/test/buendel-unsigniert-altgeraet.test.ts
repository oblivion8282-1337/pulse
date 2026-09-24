/**
 * Vorzeichenlose Alt-Bündel dürfen Zustellungen nicht blockieren
 * (Vorfall 2026-09-24).
 *
 * Nutzer „dev" trug drei September-Registrierungen ohne Signatur (vor der
 * Signatur-Ära angemeldet), während sein lebendes Gerät frisch signiert
 * hatte — und JEDE Nachricht an ihn scheiterte an `BuendelUnsigniertFehler`,
 * weil die Sendeschleifen beim ERSTEN vorzeichenlosen Bündel die ganze
 * Sendung abbrachen. Nachricht erreichte null statt alle lebenden Geräte.
 *
 * Regel seit dem Fix: vorzeichenlose Bündel werden je Gerät übersprungen
 * (sichtbar über `melde` im Käfer-Ring); ungültige Signaturen und
 * Pinnungs-Abweichungen werfen weiterhin hart; bleibt kein signiertes
 * Gerät übrig, wirft der Weg denselben Fehler — kein stiller Abstieg in
 * den Klartext-Pfad.
 *
 * Quelltext-Prüfung nach Haus-Stil: die Sendeschleifen ziehen WASM/IDB und
 * sind in Nodes Testlaeufer nicht erreichbar (CLAUDE.md „Die Falle").
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HIER = dirname(fileURLToPath(import.meta.url));
const sendenQuelle = readFileSync(join(HIER, '../src/lib/krypto/senden.ts'), 'utf8');
const gruppenQuelle = readFileSync(
  join(HIER, '../src/lib/krypto/gruppe/gruppenEinliefern.ts'),
  'utf8'
);

describe('vorzeichenlose Alt-Bündel: überspringen, nicht blockieren', () => {
  for (const [name, quelle] of [
    ['DM-Weg (senden.ts)', sendenQuelle],
    ['Gruppen-Verteilweg (gruppenEinliefern.ts)', gruppenQuelle]
  ] as const) {
    it(`${name}: fängt BuendelUnsigniertFehler und überspringt das Gerät`, () => {
      assert.match(quelle, /try \{\s*\n\s*await geraetebuendelAuthentifizieren\(geraet\);/);
      assert.match(quelle, /if \(!\(err instanceof BuendelUnsigniertFehler\)\) throw err;/);
      assert.match(quelle, /unsignierteAltgeraete\.push\(geraet\.device_pubkey\);/);
      assert.match(quelle, /continue;/);
    });

    it(`${name}: Sprung ist nicht still — melde für den Käfer-Ring`, () => {
      assert.match(quelle, /buendel_unsigniert_uebersprungen/);
      assert.match(quelle, /import \{ melde \} from '/);
    });

    it(`${name}: alles übersprungen → derselbe Fehler, kein Klartext-Abstieg`, () => {
      assert.match(quelle, /throw new BuendelUnsigniertFehler\(unsignierteAltgeraete\[0\]\);/);
    });
  }

  it('DM-Weg: der Abstieg „unverschluesselt" bleibt NUR ohne Altgerät-Sprünge erreichbar', () => {
    const leerstelle = sendenQuelle.indexOf("return 'unverschluesselt';");
    assert.ok(leerstelle > 0, 'Klartext-Rückgabe existiert noch');
    const davor = sendenQuelle.slice(0, leerstelle);
    const wurf = davor.lastIndexOf('throw new BuendelUnsigniertFehler');
    assert.ok(
      wurf > 0 && davor.lastIndexOf('if (unsignierteAltgeraete.length > 0)') < wurf,
      'der Wurf sitzt zwischen Altgeräte-Prüfung und Klartext-Rückgabe'
    );
  });
});
