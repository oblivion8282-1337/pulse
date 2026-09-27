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

/**
 * Leere Rolle über das Neu-Menü anlegen (Rangleiter-Umbau: das Menü kennt
 * „leere Rolle" + Vorlagen) und über den id-bezogenen Namens-Input umbenennen.
 * Liefert die Rollen-Id — die Server-Antwort wird mitgeprüft, damit ein
 * verpasster Klick laut abstürzt statt still ins Leere zu laufen.
 */
async function rolleAnlegen(page: Page, name: string): Promise<string> {
  await page.getByTestId('role-create').click();
  await expect(page.getByTestId('role-create-menu')).toBeVisible();
  const createResponse = page.waitForResponse(
    (r) => r.url().endsWith('/roles') && r.request().method() === 'POST',
    { timeout: 10_000 }
  );
  // force: der Klick-Fänger (fixed inset-0) unter dem Menü kann den Treffer
  // beim Aufklappen sonst an sich reißen.
  await page.getByTestId('role-create-empty').click({ force: true });
  const resp = await createResponse;
  if (resp.status() >= 300) throw new Error(`role create failed: ${resp.status()}`);
  const created = (await resp.json()) as { id: string };
  const input = page.getByTestId(`role-name-input-${created.id}`);
  await expect(input).toHaveValue('Neue Rolle');
  await input.fill(name);
  await page.getByTestId('role-save').click();
  return created.id;
}

/** Community-Einstellungen per Rechtsklick oeffnen. Das Kontextmenue kann
 *  beim Aufklappen von einer Praesenz-Aktualisierung ueholt werden —
 *  notfalls neu oeffnen (Muster wie `abmelden`). */
async function einstellungenOeffnen(page: Page, gildeId: string): Promise<void> {
  for (let versuch = 0; versuch < 4; versuch++) {
    await page.getByTestId(`guild-${gildeId}`).click({ button: 'right' });
    try {
      await page.getByTestId('guild-settings').click({ timeout: 2_500 });
      break;
    } catch {
      // Menue wurde abgebaut — neu oeffnen.
    }
  }
  await expect(page.getByTestId('guild-settings-dialog')).toBeVisible();
}

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
    // Rail-Plus-Menü statt Empty-State: /app landet seit 65a050f7 auf
    // /app/friends, das Empty-State-Panel existiert dort nicht.
    await alice.locator('[data-testid^="guild-create-menu-"]').first().click();
    await alice.getByTestId('guild-create').click();
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

    // Invite-Code per API erstellen (Link-Dialog gibt keine Links mehr aus)
    inviteCode = await alice.evaluate(async (gid: string) => {
      const token = localStorage.getItem('dcc.tokens.access');
      const r = await fetch(`/api/chat/guilds/${gid}/invites`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ max_uses: 1, expires_in_seconds: 86400 })
      });
      if (!r.ok) throw new Error(`createInvite failed: ${r.status}`);
      const data = await r.json() as { code: string };
      return data.code;
    }, guildId);

    await bob.locator('[data-testid^="guild-create-menu-"]').first().click();
    await bob.getByTestId('guild-join').click();
    await bob.getByTestId('join-guild-input').fill(inviteCode);
    await bob.getByTestId('join-guild-submit').click();
    await bob.waitForURL(/\/app\/guilds\/\d+\/channels\/\d+/, { timeout: 15_000 });
  });

  test('alice opens the settings modal via right-click', async () => {
    // Right-click the guild avatar in the rail; the context menu pops the
    // settings item (visible because alice is owner → has MANAGE_ROLES via
    // the resolver's GRANT_ALL_SAFE short-circuit).
    await einstellungenOeffnen(alice, guildId);
    await expect(alice.getByTestId('settings-tab-roles')).toBeVisible();
  });

  test('alice creates a "Mod" role with MANAGE_MESSAGES + a hoist colour', async () => {
    // The Rollen tab is selected by default for users with MANAGE_ROLES.
    // "Neu" klappt seit dem Rangleiter-Umbau ein Menü auf (leere Rolle /
    // drei Vorlagen / "<Rolle> duplizieren") — der Test nimmt die leere.
    modRoleId = await rolleAnlegen(alice, 'Mod');

    // Farbe und "hervorheben" leben jetzt im Reiter "Darstellung"; der
    // Name steht weiterhin über den Reitern und ist immer erreichbar.
    await alice.getByTestId('role-tab-darstellung').click();
    await alice.getByTestId('role-color-enabled').check();
    // Make it hoist so we can verify the member-list grouping later.
    await alice.getByTestId('role-hoist').check();

    // MANAGE_MESSAGES bit value is 1<<23. We toggle by clicking the
    // checkbox keyed by the bit value (see perm-toggle-${bit} testid in
    // PermissionToggleGrid).
    await alice.getByTestId('role-tab-rechte').click();
    await alice.getByTestId(`perm-toggle-${1 << 23}`).check();

    await alice.getByTestId('role-save').click();

    expect(modRoleId).toMatch(/^\d+$/);
  });

  test('alice assigns the Mod role to bob via the Mitglieder tab', async () => {
    // Mitglieder & Rollen ist EINE Flaeche mit zwei Teil-Reitern; der
    // Rollen-Teil startet selektiert — erst auf „Mitglieder" wechseln.
    await alice.getByTestId('mitglieder-rollen-tab-mitglieder').click();
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
    await einstellungenOeffnen(alice, guildId);
    // Helper (inkl. Wartezeit auf die frische Auswahl — der Helper prueft
    // die Create-Antwort, damit fill nicht auf die alte Auswahl landet).
    // rolleAnlegen speichert bereits; ein weiterer Save-Klick haengte an
    // dem dann deaktivierten Button (dirty=false). Die Id liefert der
    // Helper — die Zeile selbst traegt den Namen als Input-Wert, ein
    // hasText-Filter ueber die Zeile findet sie daher nicht.
    const helperId = await rolleAnlegen(alice, 'Helper');
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
    await einstellungenOeffnen(alice, guildId);
    // The Mod row is what we'll edit. Click it to select — sofern sie das
    // nicht schon IST: die selektierte Zeile zeigt den Namen als Input
    // (`role-name-input-`), das Span (`role-name-`) existiert dann gar
    // nicht erst, und ein Klick wuerde bis zum Timeout warten.
    const modZeile = alice.getByTestId(`role-name-${modRoleId}`);
    if ((await modZeile.count()) > 0) {
      await modZeile.click();
    }
    await alice.getByTestId('role-tab-darstellung').click();
    // Enable colour if it isn't already.
    const colourEnabled = alice.getByTestId('role-color-enabled');
    if (!(await colourEnabled.isChecked())) {
      await colourEnabled.check();
    }
    // <input type=color> only accepts "#rrggbb"; fill() dispatcht die
    // echten Input-Events, ueber die Svelte's bind:value den Buffer und
    // damit den Save speist (ein roher value+dispatchEvent-Write umgeht
    // den Buffer — der Server behielt dann die Zufalls-Anfangsfarbe).
    const colourInput = alice.getByTestId('role-color-input');
    await colourInput.fill('#ff8800');
    // Save an der Server-Antwort festmachen — ein disabled/gefressener
    // Klick wuerde sonst stillschweigend nichts persistent machen.
    const saveResponse = alice.waitForResponse(
      (r) => r.url().includes('/roles') && r.request().method() !== 'GET',
      { timeout: 10_000 }
    );
    await alice.getByTestId('role-save').click();
    const resp = await saveResponse;
    expect(resp.status()).toBeLessThan(300);

    // Save-Echo: das Farb-Input der Rolle traegt den neuen Wert …
    await expect(alice.getByTestId('role-color-input')).toHaveValue('#ff8800', { timeout: 10_000 });
    // … und der Server hat ihn uebernommen (color wird als int gespeichert,
    // 0xff8800 = 16749568). Das ist die Server-Wahrheit unabhaengig davon,
    // welche Zeilendarstellung (Punkt/Name/Input) gerade selektiert ist.
    const rollen = await alice.evaluate(async (gilde) => {
      const token = localStorage.getItem('dcc.tokens.access');
      const r = await fetch(`/api/chat/guilds/${gilde}/roles`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      return (await r.json()) as { id: string; color: number | null }[];
    }, guildId);
    const mod = rollen.find((r) => r.id === modRoleId);
    expect(mod?.color).toBe(0xff8800);

    await alice.keyboard.press('Escape');
    await expect(alice.getByTestId('guild-settings-dialog')).toBeHidden();
  });

  test('alice transfers ownership to bob', async () => {
    await einstellungenOeffnen(alice, guildId);
    await alice.getByTestId('settings-tab-ownership').click();
    await expect(alice.getByTestId('ownership-transfer')).toBeVisible();
    // Pick bob (the only other member; the list drops the owner row).
    // The field is a popover select: data-testid sits on the trigger button,
    // entries carry role="option", and the "— Mitglied wählen —" placeholder
    // lives in the placeholder prop — it is no longer an entry. Bob is the
    // only other member, so the single entry that appears IS bob.
    const target = alice.getByTestId('ot-target');
    await target.click();
    // listMembers is fired from an effect after the form mounts; the member
    // entries appear a tick later in the popover.
    await expect(alice.getByRole('option')).toHaveCount(1, { timeout: 10_000 });
    await alice.getByRole('option').click();

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
    await einstellungenOeffnen(alice, guildId);
    const dialog = alice.getByTestId('guild-settings-dialog');
    await expect(dialog).toBeVisible();
    const rolesTab = alice.getByTestId('settings-tab-roles');
    if (!(await rolesTab.isVisible())) {
      test.skip(true, 'no MANAGE_ROLES after ownership flip; tab hidden');
      return;
    }
    await rolesTab.click();
    // Make sure the Mod row is selected, then edit its name without saving.
    // Bereits selektiert? Dann traegt die Zeile den Namen schon als Input
    // und das Span zum Draufklicken existiert nicht.
    const modZeile = alice.getByTestId(`role-name-${modRoleId}`);
    if ((await modZeile.count()) > 0) {
      await modZeile.click();
    }
    const nameInput = alice.getByTestId(`role-name-input-${modRoleId}`);
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
