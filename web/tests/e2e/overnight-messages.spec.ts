/**
 * Overnight T6 — Nachrichten-Klickpfade im Guild-Channel:
 * Senden, Bearbeiten („(bearbeitet)“), Löschen, Reaktionen (an/aus),
 * Anpinnen/Lösen, @Erwähnung, Entwurf über Kanalwechsel, Emoji-Picker,
 * Anhang. Zwei Nutzer in einer Community, alles über die UI gefahren.
 *
 * **Nachrichtensuche hat keinen Test:** es gibt kein Such-UI für Nachrichten
 * (Suchfelder existieren nur für Freunde, Ablage, Discover, Rollen — kein
 * `data-testid` im Chat durchsucht Nachrichten). Nichts zu klicken, nichts
 * zu behaupten.
 */

import { test, expect, type Page, type BrowserContext } from '@playwright/test';

const ts = Date.now();
const ALICE = {
  username: `msg_alice_${ts}`,
  email: `msg_alice_${ts}@dcc-test.example.com`,
  password: 'sup3r-secret-pass'
};
const BOB = {
  username: `msg_bob_${ts}`,
  email: `msg_bob_${ts}@dcc-test.example.com`,
  password: 'sup3r-secret-pass'
};

/** 1x1 transparentes PNG (Muster aus attachments.spec.ts). */
const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4' +
    '890000000a49444154789c63000100000500010d0a2db40000000049454e44ae' +
    '426082',
  'hex'
);

async function register(page: Page, u: { username: string; email: string; password: string }) {
  await page.goto('/register');
  await page.getByTestId('reg-username').fill(u.username);
  await page.getByTestId('reg-email').fill(u.email);
  await page.getByTestId('reg-password').fill(u.password);
  await page.getByTestId('reg-submit').click();
  await page.waitForURL(/\/app/);
  // Backup-Setup-Dialog best-effort schließen (Muster aus chat.spec.ts).
  await page
    .locator('[data-testid=backup-onboarding-skip-btn]')
    .click({ timeout: 2500 })
    .catch(() => undefined);
}

async function currentUserId(page: Page): Promise<string> {
  const value = await page.evaluate(() => {
    const raw = localStorage.getItem('dcc.tokens.access');
    if (!raw) return null;
    const parts = raw.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload.sub as string;
  });
  if (!value) throw new Error('kein Access-Token im localStorage');
  return value;
}

async function addMember(adminPage: Page, guildId: string, userId: string) {
  const r = await adminPage.evaluate(
    async ({ gid, uid }) => {
      const token = localStorage.getItem('dcc.tokens.access');
      const res = await fetch(`/api/chat/guilds/${gid}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ user_id: uid })
      });
      return res.status;
    },
    { gid: guildId, uid: userId }
  );
  expect([200, 201]).toContain(r);
}

/** Nachricht anhand ihres Texts finden; der Wrapper trägt `group` — Hover
 *  macht die Aktionsleiste sichtbar (`hidden group-hover:flex`). */
function zeile(page: Page, text: string) {
  return page.locator('[data-testid="message-item"]', { hasText: text });
}

/** Emoji aus dem Picker wählen: Emoji-Mart steckt im Shadow-DOM (offen),
 *  Playwrights-CSS bohrt hindurch. Suche nutzen, dann auf den Titel klicken —
 *  der Button trägt `title: emoji.name` (previewPosition: 'none'). */
async function emojiWaehlen(page: Page, suche: string, titel: string) {
  const picker = page.getByTestId('emoji-picker');
  await expect(picker).toBeVisible({ timeout: 15_000 });
  const suchfeld = picker.locator('em-emoji-picker input');
  await expect(suchfeld).toBeVisible({ timeout: 15_000 });
  await suchfeld.fill(suche);
  await picker.locator(`em-emoji-picker button[title="${titel}"]`).first().click();
}

test.describe.serial('Overnight T6 — Nachrichten', () => {
  let aliceCtx: BrowserContext;
  let alicePage: Page;
  let bobCtx: BrowserContext;
  let bobPage: Page;
  let guildId = '';
  let channelId = '';

  test.beforeAll(async ({ browser }) => {
    aliceCtx = await browser.newContext();
    bobCtx = await browser.newContext();
    // Changelog-Toast stummschalten — steht unten rechts und frisst Klicks
    // auf Composer/Mitgliederliste (Muster aus dms.spec.ts).
    for (const ctx of [aliceCtx, bobCtx]) {
      await ctx.route('**/changelog.json', (route) => route.fulfill({ json: { entries: [] } }));
    }
    alicePage = await aliceCtx.newPage();
    bobPage = await bobCtx.newPage();
  });

  test.afterAll(async () => {
    await aliceCtx.close();
    await bobCtx.close();
  });

  test('Aufbau: beide registriert, Community + #general bereit', async () => {
    await register(alicePage, ALICE);
    await register(bobPage, BOB);
    const bobUserId = await currentUserId(bobPage);

    await alicePage.locator('[data-testid^="guild-create-menu-"]').first().click();
    await alicePage.getByTestId('guild-create').click();
    await alicePage.getByTestId('create-guild-name').fill('Nachrichten Guild');
    await alicePage.getByTestId('create-guild-submit').click();
    await alicePage.waitForURL(/\/app\/guilds\/(\d+)\/channels\/(\d+)/);
    const url = new URL(alicePage.url()).pathname.split('/');
    guildId = url[3];
    channelId = url[5];
    await expect(alicePage.getByTestId('active-channel-name')).toHaveText('general', {
      timeout: 10_000
    });

    await addMember(alicePage, guildId, bobUserId);
    await bobPage.goto(`/app/guilds/${guildId}/channels/${channelId}`);
    await expect(bobPage.getByTestId('active-channel-name')).toHaveText('general', {
      timeout: 15_000
    });
  });

  test('Nachricht senden → erscheint in der Liste (beide Seiten)', async () => {
    const input = alicePage.getByTestId('message-input');
    await input.fill('hallo von alice');
    await input.press('Enter');

    await expect(
      alicePage.locator('[data-testid="message-content"]', { hasText: 'hallo von alice' })
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      bobPage.locator('[data-testid="message-content"]', { hasText: 'hallo von alice' })
    ).toBeVisible({ timeout: 10_000 });
  });

  test('Nachricht bearbeiten → neuer Text + „(bearbeitet)“', async () => {
    const input = alicePage.getByTestId('message-input');
    await input.fill('erster Wurf');
    await input.press('Enter');
    await expect(zeile(alicePage, 'erster Wurf')).toBeVisible({ timeout: 10_000 });

    await zeile(alicePage, 'erster Wurf').hover();
    await zeile(alicePage, 'erster Wurf').getByTestId('message-action-edit').click();
    const edit = alicePage.getByTestId('message-edit-input');
    await expect(edit).toBeVisible();
    await edit.fill('zweiter Wurf');
    await edit.press('Enter');

    const inhalt = zeile(alicePage, 'zweiter Wurf').getByTestId('message-content');
    await expect(inhalt).toBeVisible({ timeout: 10_000 });
    await expect(inhalt).toContainText('(bearbeitet)');
    // Bob bekommt die Korrektur live.
    await expect(
      bobPage.locator('[data-testid="message-content"]', { hasText: 'zweiter Wurf' })
    ).toBeVisible({ timeout: 10_000 });
  });

  test('Nachricht löschen → aus der Liste weg', async () => {
    const input = alicePage.getByTestId('message-input');
    await input.fill('kurzlebig');
    await input.press('Enter');
    await expect(zeile(alicePage, 'kurzlebig')).toBeVisible({ timeout: 10_000 });

    await zeile(alicePage, 'kurzlebig').hover();
    await zeile(alicePage, 'kurzlebig').getByTestId('message-action-delete').click();
    await alicePage.getByTestId('confirm-dialog-confirm').click();

    await expect(zeile(alicePage, 'kurzlebig')).toHaveCount(0, { timeout: 10_000 });
    await expect(zeile(bobPage, 'kurzlebig')).toHaveCount(0, { timeout: 10_000 });
  });

  test('Reaktion: hinzufügen → Badge da → entfernen → weg', async () => {
    const input = alicePage.getByTestId('message-input');
    await input.fill('reaktion bitte');
    await input.press('Enter');
    await expect(zeile(alicePage, 'reaktion bitte')).toBeVisible({ timeout: 10_000 });

    await zeile(alicePage, 'reaktion bitte').hover();
    await zeile(alicePage, 'reaktion bitte').getByTestId('message-action-react').click();
    await emojiWaehlen(alicePage, 'thumbs', 'Thumbs Up');

    const pill = zeile(alicePage, 'reaktion bitte').locator('[data-testid="reaction-pill"]');
    await expect(pill).toBeVisible({ timeout: 10_000 });
    await expect(pill).toHaveAttribute('data-emoji', '👍');
    await expect(pill).toHaveAttribute('data-mine', 'true');

    // Klick aufs eigene Badge öffnet das Popover — dort „Reaktion entfernen“.
    // Das Popover liegt nicht zwangsläufig inside der Zeile (bits-ui-Layer),
    // deshalb global greifen.
    await pill.click();
    const entfernen = alicePage.getByTestId('reaction-popover-unreact');
    await expect(entfernen).toBeVisible({ timeout: 10_000 });
    await entfernen.click();

    await expect(
      zeile(alicePage, 'reaktion bitte').getByTestId('message-reactions')
    ).toHaveCount(0, { timeout: 10_000 });
  });

  test('Anpinnen → Pin-Badge in der Leiste → Lösen räumt ab', async () => {
    const input = alicePage.getByTestId('message-input');
    await input.fill('merkwürdig wertvoll');
    await input.press('Enter');
    await expect(zeile(alicePage, 'merkwürdig wertvoll')).toBeVisible({ timeout: 10_000 });

    await zeile(alicePage, 'merkwürdig wertvoll').hover();
    await zeile(alicePage, 'merkwürdig wertvoll').getByTestId('message-action-pin').click();

    // Pin-Zähler erscheint im Kanalkopf; die Liste enthält die Nachricht.
    const pins = alicePage.getByTestId('pins-toggle');
    await expect(pins).toBeVisible({ timeout: 10_000 });
    await pins.click();
    await expect(
      alicePage.getByTestId('pins-list').getByTestId('pin-entry').filter({
        hasText: 'merkwürdig wertvoll'
      })
    ).toBeVisible({ timeout: 10_000 });
    await alicePage.keyboard.press('Escape');

    // Wieder lösen: Zähler verschwindet.
    await zeile(alicePage, 'merkwürdig wertvoll').hover();
    await zeile(alicePage, 'merkwürdig wertvoll').getByTestId('message-action-unpin').click();
    await expect(alicePage.getByTestId('pins-toggle')).toHaveCount(0, { timeout: 10_000 });
  });

  test('Erwähnung: @ im Composer → Vorschlag klicken → Pill in der Nachricht', async () => {
    const input = alicePage.getByTestId('message-input');
    await input.pressSequentially(`@${BOB.username.slice(0, 10)}`, { delay: 40 });
    const vorschlag = alicePage
      .getByTestId('mention-item')
      .filter({ hasText: BOB.username })
      .first();
    await expect(vorschlag).toBeVisible({ timeout: 10_000 });
    await vorschlag.click();

    // Rest antippen und abschicken.
    await input.pressSequentially(' schau her', { delay: 20 });
    await input.press('Enter');

    const pill = alicePage.locator('[data-testid="message-content"] .mention').last();
    await expect(pill).toBeVisible({ timeout: 10_000 });
    await expect(pill).toContainText(BOB.username);
  });

  test('Entwurf überlebt den Kanalwechsel', async () => {
    const input = alicePage.getByTestId('message-input');
    await input.fill('halb fertiger Gedanke');

    await alicePage.getByTestId('channel-create').click();
    await alicePage.getByTestId('create-channel-type-text').click();
    await alicePage.getByTestId('create-channel-name').fill('zweiter');
    await alicePage.getByTestId('create-channel-submit').click();
    await expect(alicePage.getByTestId('active-channel-name')).toHaveText('zweiter', {
      timeout: 10_000
    });
    await expect(input).toHaveValue('');

    await input.fill('anderer Entwurf hier');

    await alicePage
      .getByTestId(/^channel-\d+$/)
      .filter({ hasText: 'general' })
      .first()
      .click();
    await expect(alicePage.getByTestId('active-channel-name')).toHaveText('general');
    await expect(input).toHaveValue('halb fertiger Gedanke', { timeout: 10_000 });
  });

  test('Emoji-Picker: Emoji landet im Composer und in der Nachricht', async () => {
    await alicePage.getByTestId('emoji-button').click();
    await emojiWaehlen(alicePage, 'wink', 'Wink');

    const input = alicePage.getByTestId('message-input');
    await expect(input).toHaveValue('😉');
    await input.press('Enter');

    await expect(
      alicePage.locator('[data-testid="message-content"]', { hasText: '😉' }).last()
    ).toBeVisible({ timeout: 10_000 });
  });

  test('Nachricht mit Anhang → Bild hängt an der Nachricht', async () => {
    await alicePage.getByTestId('attachment-file-input').setInputFiles({
      name: 'pixel.png',
      mimeType: 'image/png',
      buffer: TINY_PNG
    });
    await expect(alicePage.getByTestId('attachment-preview')).toBeVisible({ timeout: 10_000 });

    const input = alicePage.getByTestId('message-input');
    await input.fill('schau mal');
    await expect(alicePage.getByTestId('message-send')).toBeEnabled({ timeout: 15_000 });
    await alicePage.getByTestId('message-send').click();

    const nachricht = zeile(alicePage, 'schau mal');
    await expect(nachricht).toBeVisible({ timeout: 10_000 });
    await expect(nachricht.getByTestId('attachment-image')).toBeVisible({ timeout: 15_000 });
  });
});
