import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * 2026-09-11: „Zu Server einladen" bot Jede Community mit CREATE_INVITES an
 * — auch solche, in denen der Freund längst Mitglied ist. Der Versuch endete
 * serverseitig korrekt in 409 already_member, die Oberfläche zeigte aber nur
 * einen generischen Fehler. Die Liste blendet diese Communitys jetzt aus.
 *
 * Die Komponente selbst ist Svelte-Runes-Code (Node-Läufer unerreichbar, s.
 * CLAUDE.md „Die Falle") — Quelltext-Gegenproben wie in
 * `krypto-postfach-ready.test.ts`.
 */

const quelle = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../src/lib/components/InviteToServerSubmenu.svelte'),
  'utf8'
);

test('die Liste nutzt den Mitglieder-Cache, um Communitys zu erkennen', () => {
  assert.match(quelle, /import \{ memberListCache \} from '\.\/MentionAutocomplete\.svelte'/);
  assert.match(quelle, /memberListCache\s*\n?\s*\.get\(g\.id\)/);
});

test('angezeigt wird nur, wo der Freund NICHT Mitglied ist', () => {
  // Filter muss AUSSCHLIESSEND sein (ausblenden, nicht ausgrauen) und auf
  // der Ausgabe-Liste stehen, das Empty-State-`if` ebenso.
  assert.match(quelle, /anbietbareGuilds = \$derived\(invitableGuilds\.filter\(\(g\) => !friendGuildIds\.has\(g\.id\)\)\)/);
  assert.match(quelle, /anbietbareGuilds\.length === 0/);
  assert.match(quelle, /\{#each anbietbareGuilds as guild/);
});

test('ein Cache-Fehler lässt die Community sichtbar (Server-409 als Rückfall)', () => {
  // allSettled statt all: ein abgelehnter Guild-Fetch darf die anderen und
  // die Sichtbarkeit des Kaputten nicht mitreißen.
  assert.match(quelle, /Promise\.allSettled/);
});
