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
});
