/**
 * Der Renderer speichert nur, was die Allowlist im Main-Prozess kennt.
 *
 * `store:set`/`store:setAll` verwerfen unbekannte Schlüssel **still** — eine
 * Zeile `console.warn` im Main-Log, sonst nichts. Der Renderer bekommt kein
 * Scheitern zurück, behält seinen Stand im Speicher und wirkt bis zum nächsten
 * Neuladen völlig richtig. Am 2026-08-16 hat das die Standplatz-Geräte gekostet:
 * `remote.geraete` stand nicht in der Liste, das eingetragene Gerät war nach
 * jedem Reload wieder „offline" und musste neu eingetragen werden — und die
 * Dauerfreigabe, das Protokoll und das Übertragungs-Profil desselben Geräts
 * teilten das Schicksal, ohne dass es jemandem auffiel.
 *
 * Deshalb dieser Test: er liest **Text**, keine Module. `main.ts` lässt sich
 * nicht importieren (es fährt beim Laden die Electron-App hoch), und der
 * Renderer-Code ist Svelte-TypeScript. Verglichen werden also die
 * Schlüssel-Literale beider Seiten — grob, aber es fällt genau dann um, wenn
 * jemand eine neue persistierte Einstellung einführt und die Allowlist vergisst.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const WURZEL = join(import.meta.dirname, '..', '..');

/** Die Allowlist aus `main.ts` — als Text gelesen, siehe oben. */
function erlaubteSchluessel(): Set<string> {
  const quelle = readFileSync(join(WURZEL, 'desktop', 'electron', 'main.ts'), 'utf8');
  const block = quelle.match(/const ALLOWED_STORE_KEYS = new Set\(\[([\s\S]*?)\n\]\);/);
  assert.ok(block, 'ALLOWED_STORE_KEYS in main.ts nicht gefunden — Test anpassen');
  return new Set([...block[1].matchAll(/^\s*'([^']+)',/gm)].map((m) => m[1]));
}

/**
 * Die Schlüssel, die der Renderer über `saveAll` schreibt.
 *
 * Zwei Quellen, weil es zwei Muster gibt: die Standplatz-Module halten je einen
 * `SPEICHER_SCHLUESSEL`, die Stream-Einstellungen eine `PERSIST_KEYS`-Liste.
 */
function geschriebeneSchluessel(): string[] {
  const lib = join(WURZEL, 'web', 'src', 'lib');
  const dateien: string[] = [];
  const sammeln = (verzeichnis: string): void => {
    for (const eintrag of readdirSync(verzeichnis, { withFileTypes: true })) {
      const pfad = join(verzeichnis, eintrag.name);
      if (eintrag.isDirectory()) sammeln(pfad);
      else if (eintrag.name.endsWith('.ts')) dateien.push(pfad);
    }
  };
  sammeln(lib);
  const gefunden = new Set<string>();
  for (const datei of dateien) {
    const text = readFileSync(datei, 'utf8');
    for (const treffer of text.matchAll(/SPEICHER_SCHLUESSEL = '([^']+)'/g)) {
      gefunden.add(treffer[1]);
    }
  }
  return [...gefunden];
}

test('jeder persistierte Renderer-Schlüssel steht in der Main-Allowlist', () => {
  const erlaubt = erlaubteSchluessel();
  const fehlend = geschriebeneSchluessel().filter((k) => !erlaubt.has(k));
  assert.deepEqual(
    fehlend,
    [],
    `Diese Schlüssel schreibt der Renderer, aber der Main-Prozess verwirft sie: ${fehlend.join(', ')}`,
  );
});

test('die Standplatz-Schlüssel sind namentlich dabei', () => {
  // Namentlich und nicht nur über den Sammellauf oben: verschwindet einer der
  // Speicher (umbenannt, zusammengelegt), soll dieser Test darauf zeigen und
  // nicht stillschweigend grün bleiben, weil er nichts mehr zu vergleichen hat.
  const erlaubt = erlaubteSchluessel();
  for (const k of [
    'remote.geraete',
    'remote.standplatz',
    'remote.protokoll',
    'remote.standplatzProfil',
  ]) {
    assert.ok(erlaubt.has(k), `${k} fehlt in ALLOWED_STORE_KEYS`);
  }
});
