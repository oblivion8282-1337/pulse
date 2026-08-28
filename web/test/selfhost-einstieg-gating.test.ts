import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Der Einstieg in den eigenen Server darf nicht am AKTIVEN Server hängen.
 *
 * Bis zum 2026-08-28 tat er das: `selfHostEinstiegSichtbar()` gab
 * `activeServer.current?.isCloud` zurück, begründet damit, dass „auf einem
 * fremden Server die auth-API `/me/instances` gar nicht kennt". Das war falsch —
 * der Bereich holt seine Daten über `cookieFetch`, und das geht immer an die
 * Cloud, weil die Web-App von dort ausgeliefert wird.
 *
 * Die Folge war verdreht: Der KONTO-weite Knopf war an den aktiven Server
 * gekoppelt, während der server-bezogene Admin-Knopf daneben überall erschien.
 * Wer auf seinem eigenen Server nach der Verwaltung suchte, fand sie nicht.
 *
 * **Warum dieser Test die Quelle liest statt die Funktion aufzurufen.** Das ist
 * grob, und es ist hier trotzdem die ehrliche Form:
 *
 * - Die Funktion gibt heute schlicht `true` zurück. Sie aufzurufen und `true`
 *   zu erwarten prüft nichts — es schriebe die Antwort ab, statt die
 *   Eigenschaft zu sichern.
 * - Das Modul importiert Svelte-Stores über `$lib`-Aliase; Nodes Testläufer
 *   löst die nicht auf (s. `pnpm test:unit`-Falle in CLAUDE.md).
 * - Ein E2E-Test käme nicht heran: Die Playwright-Suite fährt gegen eine
 *   Cloud-Instanz und kann gar nicht auf einen Self-Host wechseln.
 *
 * Was hier also gesichert wird, ist genau die Regression, die passieren kann:
 * dass jemand die Bedingung wieder einzieht.
 */

const QUELLE = new URL('../src/lib/selfhost/hinweis.svelte.ts', import.meta.url);

test('der Einstieg haengt nicht am aktiven Server', () => {
  const quelle = readFileSync(QUELLE, 'utf8');
  const code = quelle.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  assert.ok(
    !/activeServer/.test(code),
    'hinweis.svelte.ts greift wieder auf activeServer zu — der Einstieg in den ' +
      'eigenen Server gehoert zum KONTO, nicht zum aktiven Server.',
  );
  assert.ok(
    !/isCloud/.test(code),
    'hinweis.svelte.ts gatet wieder auf isCloud — die Begruendung dafuer ' +
      '(„/me/instances gibt es dort nicht") war nachweislich falsch.',
  );
});

test('die Gegenprobe: der Test findet ueberhaupt Code', () => {
  // Ein Test, der nur Kommentare durchsucht, waere immer gruen. Diese Zeile
  // haelt fest, dass nach dem Strippen noch die Funktion selbst dasteht.
  const quelle = readFileSync(QUELLE, 'utf8');
  const code = quelle.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.match(code, /export function selfHostEinstiegSichtbar/);
});
