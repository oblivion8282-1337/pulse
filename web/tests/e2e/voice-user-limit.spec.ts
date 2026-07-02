/**
 * E2E fürs Voice-Benutzerlimit (RenameChannelDialog + ChannelList-Badge):
 * Owner setzt auf einem Voice-Channel ein Limit; die "n/Limit"-Anzeige
 * erscheint. Deckt die Frontend-Verdrahtung ab (PATCH round-trip + Render);
 * die Durchsetzung selbst ist in den voice-signaling-Unit-Tests abgedeckt
 * (ein echter Limit-Hit bräuchte zwei gleichzeitige LiveKit-Joins).
 */

import { test, expect, type Page } from '@playwright/test';

const ts = Date.now();
const OWNER = {
  username: `vlimit_${ts}`,
  email: `vlimit_${ts}@dcc-test.example.com`,
  password: 'vlimit-secret-pass'
};

async function api<T>(page: Page, path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  return page.evaluate(
    async ({ path, init }) => {
      const token = localStorage.getItem('dcc.tokens.access');
      const r = await fetch(`/api/chat${path}`, {
        method: init?.method ?? 'GET',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: init?.body === undefined ? undefined : JSON.stringify(init.body)
      });
      if (!r.ok) throw new Error(`${path} failed: ${r.status}`);
      return (await r.json()) as never;
    },
    { path, init }
  );
}

test('Voice-Channel-Benutzerlimit: setzen und Anzeige', async ({ page }) => {
  await page.goto('/register');
  await page.getByTestId('reg-username').fill(OWNER.username);
  await page.getByTestId('reg-email').fill(OWNER.email);
  await page.getByTestId('reg-password').fill(OWNER.password);
  await page.getByTestId('reg-submit').click();
  await page.waitForURL(/\/app/);
  await page
    .locator('[data-testid=backup-onboarding-skip-btn]')
    .click({ timeout: 2500 })
    .catch(() => undefined);

  // Guild + Voice-Channel per API (schneller + robuster als Klick-Flow).
  const guild = await api<{ id: string }>(page, '/guilds', {
    method: 'POST',
    body: { name: 'Voice Limit Guild' }
  });
  const channel = await api<{ id: string; user_limit: number }>(
    page,
    `/guilds/${guild.id}/channels`,
    { method: 'POST', body: { name: 'lobby', type: 1, position: 0 } }
  );
  expect(channel.user_limit).toBe(0);

  // Store frisch hydratisieren (die Guild wurde per API nach dem ersten Boot
  // angelegt) und die Guild im Rail auswählen.
  await page.reload();
  await page.getByTestId(`guild-${guild.id}`).click({ timeout: 10_000 });
  const row = page.getByTestId(`channel-${channel.id}`);
  await expect(row).toBeVisible({ timeout: 10_000 });
  // Ohne Limit keine Anzeige.
  await expect(page.getByTestId(`channel-user-limit-${channel.id}`)).toHaveCount(0);

  // Kontextmenü → Einstellungen öffnet den Channel-Dialog.
  await row.click({ button: 'right' });
  await page.getByTestId('channel-context-settings').click();
  await expect(page.getByTestId('rename-channel-dialog')).toBeVisible();

  // Limit setzen + speichern.
  const limitInput = page.getByTestId('rename-channel-user-limit');
  await expect(limitInput).toBeVisible();
  await limitInput.fill('5');
  await page.getByTestId('rename-channel-submit').click();

  // Badge zeigt "0/5" (niemand drin).
  const badge = page.getByTestId(`channel-user-limit-${channel.id}`);
  await expect(badge).toBeVisible({ timeout: 5_000 });
  await expect(badge).toHaveText('0/5');

  // Persistenz: PATCH ist durch (Backend liefert user_limit=5 zurück).
  const fetched = await api<{ user_limit: number }>(page, `/channels/${channel.id}`);
  expect(fetched.user_limit).toBe(5);
});
