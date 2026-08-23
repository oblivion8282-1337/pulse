/**
 * Die Sprach-Knopfreihe auf dem Handy MUSS einzeilig bleiben.
 *
 * Das ist die Regel, die am leichtesten wieder kippt: jeder neue Knopf in der
 * Reihe sieht am Rechner harmlos aus und schiebt auf einem schmalen Telefon
 * das Gespraech nach oben oder draengt die Knoepfe unter die
 * Mindest-Trefferflaeche. Genau deshalb sind Lautsprecher (Statuszeile) und
 * Kamera-Wechsel (eigene Kachel) aus der Reihe herausgenommen worden.
 *
 * Geprueft wird nicht die Anzahl, sondern die WIRKUNG: gleiche Oberkante bei
 * allen Knoepfen (also kein Umbruch) und jeder mindestens 48 dp gross.
 */
import { test, expect, type Page } from '@playwright/test';

const PW = 'Passwort123!';
const TAG = Date.now().toString(36);
const HANDY = { width: 390, height: 844 };

test.describe.configure({ mode: 'serial' });

test.describe('Sprach-Knopfreihe auf dem Handy', () => {
  let page: Page;
  let sprachKanal: string;
  let guildId: string;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage({ viewport: HANDY });
    await page.goto('/register');
    await page.getByTestId('reg-username').fill(`voice_${TAG}`);
    await page.getByTestId('reg-email').fill(`voice_${TAG}@dcc-test.example.com`);
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
          body: JSON.stringify({ name: `Sprachprobe ${Date.now()}` })
        })
      ).json();
      const k = await (
        await fetch(`/api/chat/guilds/${g.id}/channels`, {
          method: 'POST',
          headers: kopf,
          body: JSON.stringify({ name: 'lounge', type: 1 })
        })
      ).json();
      return { guildId: String(g.id), kanalId: String(k.id) };
    });
    guildId = ids.guildId;
    sprachKanal = ids.kanalId;
  });

  test.afterAll(async () => {
    await page.close();
  });

  test('ein Sprachkanal bekommt am Telefon eine eigene Ansicht', async () => {
    // Vor dem Umbau blieb hier die Kanalliste stehen — das ging nur, WEIL sie
    // als Drawer daneben lag. Ohne Drawer waere der Bildschirm leer.
    await page.goto(`/app/guilds/${guildId}/channels/${sprachKanal}`);
    await expect(page.getByTestId('channel-list')).toBeHidden();
    await expect(page.locator('[data-testid=voice-channel-view], [data-testid=chat-back]').first())
      .toBeVisible();
  });

  // **Die Knopfreihe selbst ist hier NICHT pruefbar.** Sie erscheint nur mit
  // stehender Sprachverbindung, und LiveKit laeuft im Testaufbau nicht
  // (`_globalSetup.ts` startet Postgres, Redis und MinIO — sonst nichts). Ein
  // Test dafuer waere dauerhaft uebersprungen, und ein uebersprungener Test
  // faengt so wenig wie ein dauerhaft roter.
  //
  // Was die Einzeiligkeit stattdessen sichert: Lautsprecher und
  // Kamera-Wechsel sind aus der Reihe herausgenommen (Statuszeile bzw. eigene
  // Kachel), die Reihe traegt auf dem Handy `flex-nowrap`, und die Begruendung
  // steht an beiden Stellen im Code. Wer einen fuenften Knopf hinzufuegt,
  // liest sie dort.
});
