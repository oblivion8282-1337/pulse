import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Eine endgültig tote Cloud-Session muss den User abmelden — sonst bleibt
 * `auth.user` als Zombie-Cache stehen und die 60-s-Admin-Polls (Anträge,
 * Beschwerden) feuern endlos 401 in eine Session, die der Server längst
 * abgelehnt hat (Befund aus Prod-Console-Log, 2026-09-03).
 *
 * **Warum dieser Test die Quelle liest statt die Funktion aufzurufen.**
 * `cookie-client.ts` zieht `./client` nach sich, und das importiert
 * `$lib`-Aliase (paraglide, Stores) — Nodes Testläufer löst die nicht auf
 * (s. `pnpm test:unit`-Falle in CLAUDE.md). Gesichert wird genau die
 * Verdrahtung, deren Fehlen den Zombie-Zustand erzeugt:
 *
 * - `renewSession` behandelt 401 vom `/session/renew` wie `doRefresh` den
 *   abgelehnten `/refresh`: Tokens löschen + `session_expired`-Marker
 *   (der schlägt auf der Login-Seite als Toast durch).
 * - `cookieFetch` meldet ab, wenn der Renew scheiterte UND die Tokens weg
 *   sind — und nur dann; mit Tokens ist der Fehler transient (offline),
 *   und die bewusste Gnadenfrist von `doRefresh` bleibt unangetastet.
 */

const quelle = readFileSync(new URL('../src/lib/api/cookie-client.ts', import.meta.url), 'utf8');

test('renewSession räumt bei abgelehntem Bearer die Session weg (wie doRefresh)', () => {
  assert.match(quelle, /if \(resp\.status === 401\) \{[\s\S]*?clearTokens\(\);[\s\S]*?pulse\.session_expired/);
});

test('cookieFetch meldet ab, wenn Renew scheiterte und die Tokens weg sind', () => {
  // Der Renew-Retry-Pfad muss die Abmeldung hinter dem loadTokens-Check haben:
  // 401 + Renew fehlgeschlagen + keine Tokens → signOut (mit auth.user-Guard,
  // damit im ausgeloggten Zustand nichts floodet).
  assert.match(
    quelle,
    /await renewSession\(\)\) return cookieFetch<T>\(path, opts, true\);[\s\S]*?!loadTokens\(\)[\s\S]*?auth\.signOut\(\)/
  );
  assert.match(quelle, /if \(m\.auth\.user\) m\.auth\.signOut\(\)/);
});

test('mit vorhandenen Tokens bleibt der 401 transient — keine Abmeldung', () => {
  // Die Gnadenfrist (offline/Deploy-Blip → Tokens behalten, nächster Tick)
  // darf der Abmelde-Pfad nicht aushebeln: signOut liegt HINTER dem
  // loadTokens()-Check, nicht daneben.
  const abmeldeBlock = quelle.match(/if \(typeof window[\s\S]*?signOut\(\)[\s\S]*?\n    \}/);
  assert.ok(abmeldeBlock, 'Abmelde-Block nicht gefunden');
  assert.match(abmeldeBlock[0], /!loadTokens\(\)/);
});
