import { test } from 'node:test';
import assert from 'node:assert/strict';

import { machtKanalUeberholt } from '../src/lib/krypto/gruppe/kanalWechselErkennung.ts';

const GUILD = 'guild-1';
const KANAL = 'kanal-1';

test('Mitglieder-Ereignisse derselben Guild machen den Kanal ueberholt', () => {
  assert.equal(machtKanalUeberholt({ op: 'guild_member_added', guild_id: GUILD }, GUILD, KANAL), true);
  assert.equal(
    machtKanalUeberholt({ op: 'guild_member_removed', guild_id: GUILD }, GUILD, KANAL),
    true
  );
  assert.equal(
    machtKanalUeberholt({ op: 'member_roles_updated', guild_id: GUILD }, GUILD, KANAL),
    true
  );
  assert.equal(machtKanalUeberholt({ op: 'role_updated', guild_id: GUILD }, GUILD, KANAL), true);
  assert.equal(machtKanalUeberholt({ op: 'role_deleted', guild_id: GUILD }, GUILD, KANAL), true);
});

test('ein Ereignis einer FREMDEN Guild betrifft den Kanal nicht', () => {
  assert.equal(
    machtKanalUeberholt({ op: 'guild_member_added', guild_id: 'andere-guild' }, GUILD, KANAL),
    false
  );
});

test('channel_permissions_updated betrifft nur den GENAU gemeinten Kanal', () => {
  assert.equal(
    machtKanalUeberholt(
      { op: 'channel_permissions_updated', guild_id: GUILD, channel_id: KANAL },
      GUILD,
      KANAL
    ),
    true
  );
  assert.equal(
    machtKanalUeberholt(
      { op: 'channel_permissions_updated', guild_id: GUILD, channel_id: 'anderer-kanal' },
      GUILD,
      KANAL
    ),
    false
  );
});

test('channel_permissions_updated fuer die falsche Guild betrifft den Kanal nicht, auch bei gleicher Kanal-ID', () => {
  // Kanal-IDs sind Snowflakes und guild-uebergreifend eindeutig — dieser
  // Fall ist praktisch unmoeglich, die Guild-Pruefung greift trotzdem zuerst.
  assert.equal(
    machtKanalUeberholt(
      { op: 'channel_permissions_updated', guild_id: 'andere-guild', channel_id: KANAL },
      GUILD,
      KANAL
    ),
    false
  );
});
