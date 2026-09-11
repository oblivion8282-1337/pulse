import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * 2026-09-11 — der Baustempel (kurzer Commit-SHA, bei jedem CI-Deploy neu)
 * als Stand-Angabe für Cloud-Betreiber und Self-Hoster. Die Anzeige-Komponenten
 * sind Svelte-Runes-Code (Node-Läufer unerreichbar, s. CLAUDE.md „Die Falle") —
 * Quelltext-Gegenproben nach dem Muster von `krypto-postfach-ready.test.ts`.
 */

const lese = (rel: string) =>
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), rel), 'utf8');

test('der API-Typ kennt den Baustempel, der Abruf liefert ihn ohne Pre-Check-Zwang', () => {
  const api = lese('../src/lib/api/server-info.ts');
  assert.match(api, /build_version\?: string/);
  assert.match(api, /export async function fetchServerInfo\(/);
});

test('die Admin-Übersicht zeigt den Stempel des EIGENEN Servers', () => {
  const uebersicht = lese('../src/lib/components/admin/AdminOverview.svelte');
  assert.match(uebersicht, /data-testid="admin-build-version"/);
  // Muss aus dem well-known des eigenen Hosts kommen, nicht aus einem Build-
  // Konstanten-Stand (das Web-Image ist statisch und kennt keinen Stempel).
  assert.match(uebersicht, /fetchServerInfo\(window\.location\.origin\)/);
});

test('das Server-Info-Kärtchen zeigt den Stempel DES ANGEZEIGTEN Servers', () => {
  const dialog = lese('../src/lib/components/sidebar/ServerInfoDialog.svelte');
  assert.match(dialog, /data-testid="server-info-build-version"/);
  assert.match(dialog, /fetchServerInfo\(basis\)/);
});

test('beide Images bekommen den Stempel beim Bau eingegossen', () => {
  const ci = lese('../../.github/workflows/ci.yml');
  const allinone = lese('../../infra/self-host/Dockerfile');
  const service = lese('../../Dockerfile.service');
  // CI: derselbe kurze SHA für alle Matrix-Einträge …
  assert.match(ci, /PULSE_BUILD_VERSION=\$\{\{ steps\.sha\.outputs\.short \}\}/);
  // … und landet als ENV im Image-Innern (All-in-One UND Einzel-Services),
  // damit der laufende Server ihn ohne Docker-Zugriff melden kann.
  assert.match(allinone, /PULSE_BUILD_VERSION=\$\{PULSE_VERSION\}/);
  assert.match(service, /PULSE_BUILD_VERSION=\$\{PULSE_BUILD_VERSION\}/);
});

test('der Stempel-Abruf erreicht den chat-gateway auf ALLEN Wegen', () => {
  // Produktion Cloud: nginx muss die Adresse routen (vorher fiel sie ins SPA
  // und lieferte HTML — die Baustempel-Anzeige wäre dort nie erreichbar).
  // Entwicklung: der Vite-Proxy reicht sie weiter, sonst bliebe die Anzeige
  // lokal leer — genau der Fall, in dem man sie zuerst ausprobiert.
  const nginx = lese('../../infra/prod/web-nginx.conf');
  const vite = lese('../vite.config.ts');
  assert.match(nginx, /location = \/\.well-known\/pulse-server-info/);
  assert.match(vite, /'\/\.well-known\/pulse-server-info': apiProxy\(CHAT_PORT\)/);
});
