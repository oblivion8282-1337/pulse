import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { badgeAnwenden, type BadgeSchnittstelle } from '../src/lib/platform/badgeAnwenden.ts';

/**
 * Nachbau des Plugins, so wie `BadgePlugin.swift` (8.0.3) sich verhält:
 * `set` und `clear` rufen ZUERST `requestAuthorization(.badge)` — steht die
 * Erlaubnis auf „nicht entschieden", ist das der System-Dialog. Gemessen wird
 * also, ob ein Dialog aufginge, nicht, ob ein Ruf abgesetzt wurde.
 */
function nachbau(status: 'prompt' | 'granted' | 'denied') {
  const lage = { status, dialoge: 0, icon: null as number | null };
  const autorisieren = () => {
    if (lage.status === 'prompt') lage.dialoge += 1;
  };
  const plugin: BadgeSchnittstelle = {
    checkPermissions: async () => ({ display: lage.status }),
    set: async ({ count }) => {
      autorisieren();
      if (lage.status === 'granted') lage.icon = count;
    },
    clear: async () => {
      autorisieren();
      if (lage.status === 'granted') lage.icon = 0;
    }
  };
  return { lage, plugin };
}

test('Erlaubnis offen: kein System-Dialog, weder fuer eine Zahl noch fuer die 0', async () => {
  const { lage, plugin } = nachbau('prompt');
  assert.equal(await badgeAnwenden(plugin, 3), false);
  assert.equal(await badgeAnwenden(plugin, 0), false);
  assert.equal(lage.dialoge, 0);
  assert.equal(lage.icon, null);
});

test('Erlaubnis verweigert: nichts angefasst', async () => {
  const { lage, plugin } = nachbau('denied');
  assert.equal(await badgeAnwenden(plugin, 3), false);
  assert.equal(lage.icon, null);
});

test('Erlaubnis erteilt: die Zahl liegt am Icon, die 0 raeumt ab', async () => {
  const { lage, plugin } = nachbau('granted');
  assert.equal(await badgeAnwenden(plugin, 4), true);
  assert.equal(lage.icon, 4);
  assert.equal(await badgeAnwenden(plugin, 0), true);
  assert.equal(lage.icon, 0);
  assert.equal(lage.dialoge, 0);
});
