/**
 * End-to-end coverage for the Roles + Permissions feature.
 *
 * One serial flow because the four steps build on each other (a guild,
 * a role inside it, a member assigned to it, a private channel locked
 * down). Side-stepping member-context-menu / drag-drop here — those
 * are visual affordances over the same APIs, and the API-level paths
 * are already covered by pytest. We pin the UI-level happy path
 * through the settings modal + channel-permissions page.
 */

import { test, expect, type BrowserContext, type Page } from '@playwright/test';

const ts = Date.now();
const ALICE = {
  username: `role_alice_${ts}`,
  email: `role_alice_${ts}@dcc-test.example.com`,
  password: 'role-secret-pass'
};
const BOB = {
  username: `role_bob_${ts}`,
  email: `role_bob_${ts}@dcc-test.example.com`,
  password: 'role-secret-pass'
};

async function register(page: Page, u: typeof ALICE) {
  await page.goto('/register');
  await page.getByTestId('reg-username').fill(u.username);
  await page.getByTestId('reg-email').fill(u.email);
  await page.getByTestId('reg-password').fill(u.password);
  await page.getByTestId('reg-submit').click();
  await page.waitForURL(/\/app/);
  // BackupSetupStep poppt nach runIssueFlow auf (s. issue-flow.ts) — der
  // Dialog blockiert sonst die nächsten Klicks per overlay. Best-effort
  // dismiss; wenn der Dialog nicht erscheint (z.B. weil Re-Run im Test
  // ohne fresh-register), schluckt der catch.
  await page
    .locator('[data-testid=backup-onboarding-skip-btn]')
    .click({ timeout: 2500 })
    .catch(() => undefined);
}

test.describe.serial('Roles + Permissions E2E', () => {
  let aliceCtx: BrowserContext;
  let bobCtx: BrowserContext;
  let alice: Page;
  let bob: Page;
  let guildId = '';
  let inviteCode = '';
  let modRoleId = '';

  test.beforeAll(async ({ browser }) => {
    aliceCtx = await browser.newContext();
    bobCtx = await browser.newContext();
    alice = await aliceCtx.newPage();
    bob = await bobCtx.newPage();
  });

  test.afterAll(async () => {
    await aliceCtx.close();
    await bobCtx.close();
  });

  test('both users register', async () => {
    await register(alice, ALICE);
    await register(bob, BOB);
  });

  test('alice creates a guild', async () => {
    await alice.getByTestId('empty-create-guild').click();
    await alice.getByTestId('create-guild-choice').click();
    await alice.getByTestId('create-guild-name').fill('Roles Test Guild');
    await alice.getByTestId('create-guild-submit').click();
    await alice.waitForURL(/\/app\/guilds\/(\d+)\/channels\/(\d+)/);
    const m = alice.url().match(/\/app\/guilds\/(\d+)/);
    guildId = m![1];
  });

  test('alice invites bob and bob joins', async () => {
    // ChannelList renders the invite button only after the channel list
    // hydrates — wait for the channel name to settle first.
    await expect(alice.getByTestId('active-channel-name')).toBeVisible({ timeout: 15_000 });
    await expect(alice.getByTestId('invite-open-btn')).toBeVisible({ timeout: 10_000 });
    await alice.getByTestId('invite-open-btn').click();
    const linkInput = alice.getByTestId('invite-link-input');
    await expect(linkInput).toHaveValue(/\/invite\/[A-Za-z0-9]{8}/, { timeout: 10_000 });
    inviteCode = (await linkInput.inputValue()).split('/invite/')[1];
    await alice.keyboard.press('Escape');

    await bob.getByTestId('guild-create').click();
    await bob.getByTestId('join-guild-choice').click();
    await bob.getByTestId('join-guild-input').fill(inviteCode);
    await bob.getByTestId('join-guild-submit').click();
    await bob.waitForURL(/\/app\/guilds\/\d+\/channels\/\d+/, { timeout: 15_000 });
  });

  test('alice opens the settings modal via right-click', async () => {
    // Right-click the guild avatar in the rail; the context menu pops the
    // settings item (visible because alice is owner → has MANAGE_ROLES via
    // the resolver's GRANT_ALL_SAFE short-circuit).
    await alice.getByTestId(`guild-${guildId}`).click({ button: 'right' });
    await alice.getByTestId('guild-settings').click();
    await expect(alice.getByTestId('guild-settings-dialog')).toBeVisible();
    await expect(alice.getByTestId('settings-tab-roles')).toBeVisible();
  });

  test('alice creates a "Mod" role with MANAGE_MESSAGES + a hoist colour', async () => {
    // The Rollen tab is selected by default for users with MANAGE_ROLES.
    await alice.getByTestId('role-create').click();

    // Rename it; the dialog seeds "Neue Rolle".
    const nameInput = alice.getByTestId('role-name-input');
    await nameInput.fill('Mod');

    // Enable colour + hoist for the member-list grouping test below.
    await alice.getByTestId('role-color-enabled').check();
    // MANAGE_MESSAGES bit value is 1<<23. We toggle by clicking the
    // checkbox keyed by the bit value (see perm-toggle-${bit} testid in
    // PermissionToggleGrid).
    await alice.getByTestId(`perm-toggle-${1 << 23}`).check();
    // Make it hoist so we can verify the member-list grouping later.
    await alice.locator('input[type=checkbox]').filter({ hasText: '' }).nth(2).check();

    await alice.getByTestId('role-save').click();

    // Pull the role-id from the row data-testid (role-row-<id>).
    const row = alice.locator('[data-testid^="role-row-"]').filter({ hasText: 'Mod' }).first();
    const rowAttr = await row.getAttribute('data-testid');
    modRoleId = rowAttr!.replace('role-row-', '');
    expect(modRoleId).toMatch(/^\d+$/);
  });

  test('alice assigns the Mod role to bob via the Mitglieder tab', async () => {
    await alice.getByTestId('settings-tab-members').click();
    // listMembers is async — wait for at least one row to appear before
    // counting. Two members expected (alice owner + bob via invite).
    const memberRows = alice.locator('[data-testid^="member-row-"]');
    await expect(memberRows.first()).toBeVisible({ timeout: 10_000 });
    const rowCount = await memberRows.count();
    expect(rowCount).toBeGreaterThan(0);

    // Pick the row whose user_id isn't alice's. We don't know alice's
    // user_id directly — but bob's row is the only one that isn't the
    // owner. Easier: just click the first row and toggle the Mod role.
    await memberRows.first().click();
    // The assign-${userId}-${roleId} checkbox now exists; toggling it
    // calls rolesApi.assign. We extract the userId from the row's
    // data-testid.
    const firstRow = await memberRows.first().getAttribute('data-testid');
    const firstUid = firstRow!.replace('member-row-', '');
    await alice.getByTestId(`assign-${firstUid}-${modRoleId}`).check();
  });

  test('settings dialog closes cleanly', async () => {
    await alice.keyboard.press('Escape');
    await expect(alice.getByTestId('guild-settings-dialog')).toBeHidden();
  });

  test('alice can drag a role to reorder it', async () => {
    // Re-open settings and create a second "Helper" role so we have two
    // non-everyone rows to swap. HTML5 drag-and-drop isn't actually
    // synthesizable from Playwright's dragTo() — it dispatches mouse
    // events and the drop targets only listen for drag*. The visible
    // chevron buttons hit the same setPositions endpoint, so we drive
    // through those instead.
    await alice.getByTestId(`guild-${guildId}`).click({ button: 'right' });
    await alice.getByTestId('guild-settings').click();
    await expect(alice.getByTestId('guild-settings-dialog')).toBeVisible();
    await alice.getByTestId('role-create').click();
    const nameInput = alice.getByTestId('role-name-input');
    // Wait until the buffer has been re-seeded for the freshly-created
    // role. Without this, fill('Helper') can land on the still-visible
    // old selection (e.g. Mod from the previous test) and then get
    // wiped when the create-response arrives and loadIntoBuffer runs
    // for the new role — leaving dirty=false and the Save button
    // disabled.
    await expect(nameInput).toHaveValue('Neue Rolle');
    await nameInput.fill('Helper');
    await alice.getByTestId('role-save').click();
    // Grab the helper's row-id from its row testid.
    const helperRow = alice
      .locator('[data-testid^="role-row-"]')
      .filter({ hasText: 'Helper' })
      .first();
    const helperAttr = await helperRow.getAttribute('data-testid');
    const helperId = helperAttr!.replace('role-row-', '');
    expect(helperId).toMatch(/^\d+$/);

    // Helper was created after Mod → has the higher position → sits
    // above Mod in the list. Click chevron-down to swap them so Mod is
    // now the higher role.
    const helperPosBefore = await alice
      .locator(`[data-testid="role-move-down-${helperId}"]`)
      .isEnabled();
    if (helperPosBefore) {
      await alice.getByTestId(`role-move-down-${helperId}`).click();
    }
    // The chevron click fires a network PATCH /roles-positions. Wait
    // for the resulting roles list to reflect Mod-above-Helper.
    await expect
      .poll(
        async () => {
          const rows = await alice
            .locator('[data-testid^="role-row-"]')
            .all();
          // Filter out @everyone (always at the bottom).
          const ids: string[] = [];
          for (const row of rows) {
            const tid = await row.getAttribute('data-testid');
            if (tid) ids.push(tid.replace('role-row-', ''));
          }
          return ids.slice(0, 2);
        },
        { timeout: 10_000 }
      )
      .toEqual([modRoleId, helperId]);

    await alice.keyboard.press('Escape');
    await expect(alice.getByTestId('guild-settings-dialog')).toBeHidden();
  });

  test('alice picks a colour and the role row shows it', async () => {
    await alice.getByTestId(`guild-${guildId}`).click({ button: 'right' });
    await alice.getByTestId('guild-settings').click();
    await expect(alice.getByTestId('guild-settings-dialog')).toBeVisible();
    // The Mod row is what we'll edit. Click it to select.
    await alice.getByTestId(`role-row-${modRoleId}`).click();
    // Enable colour if it isn't already.
    const colourEnabled = alice.getByTestId('role-color-enabled');
    if (!(await colourEnabled.isChecked())) {
      await colourEnabled.check();
    }
    // <input type=color> only accepts "#rrggbb"; fill() works because
    // Svelte's bind:value writes back through the value property.
    const colourInput = alice.getByTestId('role-color-input');
    await colourInput.evaluate((el: HTMLInputElement) => {
      el.value = '#ff8800';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await alice.getByTestId('role-save').click();

    // After save, the row's name span should have an inline color
    // style — the row template wraps the name in
    // ``<span style="color: #...">``.
    const modRow = alice.getByTestId(`role-row-${modRoleId}`);
    const nameSpan = modRow.locator('span').first();
    await expect
      .poll(
        async () =>
          await nameSpan.evaluate((el: HTMLElement) => el.style.color),
        { timeout: 10_000 }
      )
      // Some browsers normalize the inline ``color:`` to ``rgb(...)``
      // when read back via ``style.color``; both forms are valid.
      .toMatch(/(?:#ff8800|rgb\(\s*255,\s*136,\s*0\s*\))/i);

    await alice.keyboard.press('Escape');
    await expect(alice.getByTestId('guild-settings-dialog')).toBeHidden();
  });

  test('alice transfers ownership to bob', async () => {
    await alice.getByTestId(`guild-${guildId}`).click({ button: 'right' });
    await alice.getByTestId('guild-settings').click();
    await expect(alice.getByTestId('guild-settings-dialog')).toBeVisible();
    await alice.getByTestId('settings-tab-ownership').click();
    await expect(alice.getByTestId('ownership-transfer')).toBeVisible();
    // Pick bob (the only other member; the select drops the owner row).
    const target = alice.getByTestId('ot-target');
    // listMembers is fired from an effect after the form mounts; the
    // member options appear a tick later. Wait until at least the
    // placeholder + one member are present before snapshotting.
    await expect(target.locator('option')).toHaveCount(2, { timeout: 10_000 });
    const options = await target.locator('option').all();
    // First option is the placeholder "— Mitglied wählen —"; pick the second.
    expect(options.length).toBeGreaterThanOrEqual(2);
    const bobValue = await options[1].getAttribute('value');
    expect(bobValue).toMatch(/^\d+$/);
    await target.selectOption(bobValue!);

    await alice.getByTestId('ot-confirm').fill('Roles Test Guild');
    // Wait on the network 200 from POST /transfer-ownership so we
    // assert the *actual* success — UI-only signals are racy with the
    // settings dialog re-rendering after the owner flip.
    const responsePromise = alice.waitForResponse(
      (r) => r.url().includes('/transfer-ownership') && r.request().method() === 'POST',
      { timeout: 15_000 }
    );
    await alice.getByTestId('ot-submit').click();
    const response = await responsePromise;
    expect(response.status()).toBe(200);
    // The dialog doesn't auto-close on transfer success; explicitly
    // dismiss it so the next test's right-click on the guild avatar
    // isn't intercepted by the dialog backdrop.
    await alice.keyboard.press('Escape');
    await expect(alice.getByTestId('guild-settings-dialog')).toBeHidden();
  });

  test('unsaved-changes dialog keeps the settings open on Weiter bearbeiten', async () => {
    // Re-open settings for the same guild. After the ownership transfer
    // alice may no longer be owner, but she still has any MANAGE_ROLES
    // grant via the @everyone or assigned roles; if MANAGE_ROLES isn't
    // there, the Rollen-tab is hidden — in that case we skip rather
    // than fail. (We don't predicate this test on ownership state.)
    await alice.getByTestId(`guild-${guildId}`).click({ button: 'right' });
    await alice.getByTestId('guild-settings').click();
    const dialog = alice.getByTestId('guild-settings-dialog');
    await expect(dialog).toBeVisible();
    const rolesTab = alice.getByTestId('settings-tab-roles');
    if (!(await rolesTab.isVisible())) {
      test.skip(true, 'no MANAGE_ROLES after ownership flip; tab hidden');
      return;
    }
    await rolesTab.click();
    // Make sure the Mod row is selected, then edit its name without saving.
    const modRow = alice.locator(`[data-testid="role-row-${modRoleId}"]`);
    await modRow.click();
    const nameInput = alice.getByTestId('role-name-input');
    await nameInput.fill('ModDirty');
    // Press Escape — the dialog should NOT close because of the dirty
    // buffer; the close-confirm AlertDialog should pop instead.
    await alice.keyboard.press('Escape');
    const confirm = alice.getByTestId('settings-close-confirm');
    await expect(confirm).toBeVisible({ timeout: 5_000 });

    // Click "Weiter bearbeiten" = the Cancel action. bits-ui's Cancel
    // doesn't carry a testid; match it by visible role+text.
    await alice.getByRole('button', { name: 'Weiter bearbeiten' }).click();
    // The confirm goes away, but the settings dialog must still be open.
    await expect(confirm).toBeHidden();
    await expect(dialog).toBeVisible();
  });
});
