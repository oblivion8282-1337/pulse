/**
 * Stream-Picker E2E (Logic-Ebene).
 *
 * Die LIVE-Badge-UI (VoiceParticipantTile) rendert erst nach LiveKit-Voice-Join,
 * den das E2E-Harness nicht hochfährt (gleicher Grund wie watch-party.spec.ts).
 * Statt dessen treiben wir die reale Frontend-Logik deterministisch an:
 * `streamPresence` seeden → `chooseHqForUser(cid, uid)` rufen → prüfen, dass bei
 * mehreren Streams der Picker die richtigen Labels/Slots anbietet und ein
 * Einzeleintrag nur genau dessen Tile öffnet, und bei einem Stream direkt öffnet
 * (kein Picker). Deckt `lib/stream/hqTile.ts::chooseHqForUser` +
 * `lib/stream/streamPicker.svelte.ts` + `openedTiles` ab.
 */

import { test, expect, type Page } from '@playwright/test';

const ts = Date.now();
const USER = {
  username: `sp_${ts}`,
  email: `sp_${ts}@dcc-test.example.com`,
  password: 'sup3r-secret-pass'
};

async function register(page: Page, u: { username: string; email: string; password: string }) {
  await page.goto('/register');
  await page.getByTestId('reg-username').fill(u.username);
  await page.getByTestId('reg-email').fill(u.email);
  await page.getByTestId('reg-password').fill(u.password);
  await page.getByTestId('reg-submit').click();
  await page.waitForURL(/\/app/);
  // BackupSetupStep kann aufpoppen und würde evaluate nicht blockieren, aber wir
  // dismissen es sicherheitshalber (wie watch-party.spec.ts).
  await page
    .locator('[data-testid=backup-onboarding-skip-btn]')
    .click({ timeout: 2500 })
    .catch(() => undefined);
}

test.describe.serial('Stream picker', () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await (await browser.newContext()).newPage();
    await register(page, USER);
  });

  test.afterAll(async () => {
    await page.context().close();
  });

  test('one stream opens directly; several pop the picker with labels + per-slot open', async () => {
    const out = await page.evaluate(async () => {
      // @ts-expect-error - Vite-served path resolved at browser runtime
      const presence = await import('/src/lib/stores/streamPresence.svelte.ts');
      // @ts-expect-error - Vite-served path resolved at browser runtime
      const hq = await import('/src/lib/stream/hqTile.ts');
      // @ts-expect-error - Vite-served path resolved at browser runtime
      const picker = await import('/src/lib/stream/streamPicker.svelte.ts');
      // @ts-expect-error - Vite-served path resolved at browser runtime
      const tiles = await import('/src/lib/stream/openedTiles.svelte.ts');

      const cid = '1234567890';
      const uid = '4242';
      const id0 = hq.hqTileId(uid, 0);
      const id1 = hq.hqTileId(uid, 1);

      // --- Case A: two slots with labels → picker shown -------------------
      presence.streamPresence.seed([
        {
          channel_id: cid,
          user_ids: [uid],
          streams: [
            { user_id: uid, slot: 0, label: 'Monitor 1' },
            { user_id: uid, slot: 1, label: 'Chrome' }
          ]
        }
      ]);
      picker.streamPicker.close(); // clean slate
      tiles.openedTiles.close('hq', cid, id0);
      tiles.openedTiles.close('hq', cid, id1);
      hq.chooseHqForUser(cid, uid);
      const twoEntries = picker.streamPicker.entries; // non-null → dialog would show
      const twoLabels = twoEntries?.map((e: { label: string }) => e.label);
      const twoSlots = twoEntries?.map((e: { slot: number }) => e.slot);
      // Opening one entry opens JUST that slot's tile.
      twoEntries?.[1]?.open();
      const slot1Opened = tiles.openedTiles.isOpen('hq', cid, id1);
      const slot0Opened = tiles.openedTiles.isOpen('hq', cid, id0);
      picker.streamPicker.close();

      // --- Case B: one stream → opens directly (no picker) ---------------
      presence.streamPresence.seed([
        {
          channel_id: cid,
          user_ids: [uid],
          streams: [{ user_id: uid, slot: 0, label: 'Monitor 1' }]
        }
      ]);
      tiles.openedTiles.close('hq', cid, id0);
      hq.chooseHqForUser(cid, uid);
      const onePickerEntries = picker.streamPicker.entries; // null → direct open
      const oneOpened = tiles.openedTiles.isOpen('hq', cid, id0);

      return { twoLabels, twoSlots, slot1Opened, slot0Opened, onePickerEntries, oneOpened };
    });

    expect(out.twoLabels).toEqual(['Monitor 1', 'Chrome']);
    expect(out.twoSlots).toEqual([0, 1]);
    expect(out.slot1Opened, 'entry.open() opened only its own slot').toBe(true);
    expect(out.slot0Opened, 'other slot left closed').toBe(false);
    expect(out.onePickerEntries, 'single stream skips the picker').toBeNull();
    expect(out.oneOpened, 'single stream opened directly').toBe(true);
  });
});
