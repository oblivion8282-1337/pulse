/**
 * Belegt den Bughunt-Befund: eine Nachricht eines geblockten Absenders wird
 * heute unveraendert angezeigt, weil keine Anzeige-Komponente `blocks.has()`
 * fuer Nachrichten abfragt (nur `directMessages.svelte.ts::can_send` und das
 * Freunde-Etikett tun das). Der Server stellt private Gruppennachrichten
 * geblockter Mitglieder bewusst zu (`_postfach_deps.py`) — die Kompensation
 * sollte in der Anzeige sitzen, tut es aber nicht.
 *
 * `nachrichtVonBlockiertem` ist die reine Rechnung dahinter (importfrei,
 * s. CLAUDE.md-Falle zu `pnpm test:unit`): ob eine Nachricht von jemandem
 * stammt, den der Betrachter blockiert hat.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { nachrichtVonBlockiertem } from '../src/lib/nachrichten/blockierteAnzeige.ts';

describe('nachrichtVonBlockiertem', () => {
  test('erkennt eine Nachricht eines blockierten Absenders', () => {
    assert.equal(nachrichtVonBlockiertem('boese-user-id', new Set(['boese-user-id'])), true);
  });

  test('laesst eine Nachricht eines nicht blockierten Absenders unangetastet', () => {
    assert.equal(nachrichtVonBlockiertem('brave-user-id', new Set(['boese-user-id'])), false);
  });

  test('leere Blockliste blockiert niemanden', () => {
    assert.equal(nachrichtVonBlockiertem('irgendwer', new Set()), false);
  });
});
