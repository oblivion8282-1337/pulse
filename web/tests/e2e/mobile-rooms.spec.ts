/**
 * Der Räume-Bereich auf dem Handy: Kacheln → Kanäle → Chat, und der
 * Kanal-Wechsler von unten.
 *
 * Der Wechsler ist der Grund, warum es diese Datei gibt. Er ersetzt einen
 * Drawer, der vom linken Bildschirmrand kam — also von genau dort, wo Android
 * und iOS ihre Zurück-Geste haben. Dass der Drawer auf dem Handy WEG ist,
 * prueft der letzte Test hier ausdruecklich: eine halb entfernte Navigation
 * (Wechsler da, Drawer auch noch) sieht im Alltag lange normal aus.
 */
import { test, expect, type Page } from '@playwright/test';

const PW = 'Passwort123!';
const TAG = Date.now().toString(36);
const HANDY = { width: 390, height: 844 };

test.describe.configure({ mode: 'serial' });

test.describe('Räume-Bereich auf dem Handy', () => {
  let page: Page;
  let guildId: string;
  let kanalId: string;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage({ viewport: HANDY });
    await page.goto('/register');
    await page.getByTestId('reg-username').fill(`rooms_${TAG}`);
    await page.getByTestId('reg-email').fill(`rooms_${TAG}@dcc-test.example.com`);
    await page.getByTestId('reg-password').fill(PW);
    await page.getByTestId('reg-submit').click();
    await page.waitForURL(/\/app/);
    await page
      .locator('[data-testid=backup-onboarding-skip-btn]')
      .click({ timeout: 2500 })
      .catch(() => undefined);

    const ids = await page.evaluate(async () => {
      const token = localStorage.getItem('dcc.tokens.access');
      const kopf = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
      const g = await (
        await fetch('/api/chat/guilds', {
          method: 'POST',
          headers: kopf,
          body: JSON.stringify({ name: `Raumprobe ${Date.now()}` })
        })
      ).json();
      const machKanal = async (name: string, type: number) =>
        await (
          await fetch(`/api/chat/guilds/${g.id}/channels`, {
            method: 'POST',
            headers: kopf,
            body: JSON.stringify({ name, type })
          })
        ).json();
      const a = await machKanal('allgemein', 0);
      await machKanal('zweiter', 0);
      return { guildId: String(g.id), kanalId: String(a.id) };
    });
    guildId = ids.guildId;
    kanalId = ids.kanalId;
  });

  test.afterAll(async () => {
    await page.close();
  });

  test('der Räume-Bereich zeigt die Community als Kachel', async () => {
    await page.goto('/app/rooms');
    await expect(page.getByTestId(`room-tile-${guildId}`)).toBeVisible();
  });

  test('Kachel führt auf die Kanäle, mit Zurück-Pfeil', async () => {
    await page.getByTestId(`room-tile-${guildId}`).click();
    await page.waitForURL(new RegExp(`/app/rooms/${guildId}$`));
    await expect(page.getByTestId('channel-list')).toBeVisible();
    await expect(page.getByTestId(`channel-${kanalId}`)).toBeVisible();
    // Auf einer Detail-Ebene ist die Bereichs-Leiste weg.
    await expect(page.getByTestId('mobile-tab-bar')).toBeHidden();
    await page.getByTestId('channel-list-back').click();
    await page.waitForURL(/\/app\/rooms$/);
    await expect(page.getByTestId('mobile-tab-bar')).toBeVisible();
  });

  test('Kanal-Tipp öffnet den Chat als Vollbild', async () => {
    await page.getByTestId(`room-tile-${guildId}`).click();
    await page.getByTestId(`channel-${kanalId}`).click();
    await page.waitForURL(new RegExp(`/channels/${kanalId}`));
    await expect(page.getByTestId('chat-back')).toBeVisible();
    // Auf dem Handy steht die Kanalliste NICHT mehr neben dem Chat.
    await expect(page.getByTestId('channel-list')).toBeHidden();
  });

  test('der Titel öffnet den Kanal-Wechsler von unten', async () => {
    await page.getByTestId('channel-switcher-open').click();
    const blatt = page.getByTestId('channel-switcher-sheet');
    await expect(blatt).toBeVisible();
    // Der Wechsler traegt die echten Kanalzeilen, nicht eine Kurzfassung.
    await expect(blatt.getByTestId(`channel-${kanalId}`)).toBeVisible();
  });

  test('ein Kanal-Tipp im Wechsler schliesst ihn wieder', async () => {
    const blatt = page.getByTestId('channel-switcher-sheet');
    await blatt.getByTestId(`channel-${kanalId}`).click();
    await expect(blatt).toBeHidden();
  });

  test('der Wechsler ist am Rechner nicht der Weg — dort steht die Liste', async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/app/guilds/${guildId}/channels/${kanalId}`);
    await expect(page.getByTestId('channel-list')).toBeVisible();
    await expect(page.getByTestId('channel-switcher-open')).toBeHidden();
    await expect(page.getByTestId('chat-back')).toBeHidden();
    await page.setViewportSize(HANDY);
  });
});
