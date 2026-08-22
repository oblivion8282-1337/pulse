/**
 * Der Chats-Bereich des Handys: Vorschauzeile in der Liste, Sprechblasen im
 * Gespraech — und die Gegenprobe, dass ein Community-Kanal davon UNBERUEHRT
 * bleibt.
 *
 * Die Gegenprobe ist der eigentliche Wert dieser Datei. „Sprechblasen nur in
 * privaten Gespraechen" ist eine Entscheidung, die man beim naechsten Umbau
 * versehentlich aufhebt, und im Kanal faellt es erst auf, wenn jemand ein
 * Bildschirmfoto schickt.
 */
import { test, expect, type BrowserContext, type Page } from '@playwright/test';

const PW = 'Passwort123!';
const TAG = Date.now().toString(36);
const HANDY = { width: 390, height: 844 };

async function register(page: Page, name: string): Promise<string> {
  await page.goto('/register');
  await page.getByTestId('reg-username').fill(name);
  await page.getByTestId('reg-email').fill(`${name}@dcc-test.example.com`);
  await page.getByTestId('reg-password').fill(PW);
  await page.getByTestId('reg-submit').click();
  await page.waitForURL(/\/app/);
  await page
    .locator('[data-testid=backup-onboarding-skip-btn]')
    .click({ timeout: 2500 })
    .catch(() => undefined);
  return await page.evaluate(async () => {
    const token = localStorage.getItem('dcc.tokens.access');
    const r = await fetch('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } });
    return String((await r.json()).id);
  });
}

async function befreunden(a: Page, uidA: string, b: Page, uidB: string): Promise<void> {
  const send = async (page: Page, ziel: string) => {
    const r = await page.evaluate(async (uid) => {
      const token = localStorage.getItem('dcc.tokens.access');
      const resp = await fetch('/api/chat/friend-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ target_user_id: uid })
      });
      return { status: resp.status, body: await resp.text() };
    }, ziel);
    if (r.status !== 201) throw new Error(`Freundschaftsanfrage ${r.status}: ${r.body}`);
  };
  await send(a, uidB);
  await send(b, uidA); // Gegenrichtung nimmt automatisch an
}

/** Legt eine DM an und schickt eine Nachricht — ueber die API, nicht ueber die
 *  Oberflaeche: geprueft wird hier die Darstellung, nicht der Sendeweg. */
async function dmMitNachricht(page: Page, zielUid: string, text: string): Promise<string> {
  return await page.evaluate(
    async ([uid, inhalt]) => {
      const token = localStorage.getItem('dcc.tokens.access');
      const kopf = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
      const dm = await (
        await fetch('/api/chat/dm-channels', {
          method: 'POST',
          headers: kopf,
          body: JSON.stringify({ target_user_id: uid })
        })
      ).json();
      await fetch(`/api/chat/channels/${dm.id}/messages`, {
        method: 'POST',
        headers: kopf,
        body: JSON.stringify({ content: inhalt })
      });
      return dm.id as string;
    },
    [zielUid, text] as const
  );
}

test.describe.serial('Chats-Bereich auf dem Handy', () => {
  let ctxA: BrowserContext, ctxB: BrowserContext;
  let a: Page, b: Page;
  let uidA: string, uidB: string;
  let dmId: string;

  test.beforeAll(async ({ browser }) => {
    ctxA = await browser.newContext({ viewport: HANDY });
    ctxB = await browser.newContext({ viewport: HANDY });
    a = await ctxA.newPage();
    b = await ctxB.newPage();
    uidA = await register(a, `chatsa_${TAG}`);
    uidB = await register(b, `chatsb_${TAG}`);
    await befreunden(a, uidA, b, uidB);
    dmId = await dmMitNachricht(b, uidA, 'Bis spaeter dann');
    await dmMitNachricht(a, uidB, 'Alles klar');
  });

  test.afterAll(async () => {
    await ctxA.close();
    await ctxB.close();
  });

  test('die Liste zeigt Name und Vorschautext der letzten Nachricht', async () => {
    await a.goto('/app/@me');
    const zeile = a.getByTestId(`chat-row-${dmId}`);
    await expect(zeile).toBeVisible();
    await expect(zeile).toContainText(`chatsb_${TAG}`);
    // Zuletzt hat A geschrieben — die Vorschau traegt deshalb das eigene
    // Praefix.
    await expect(zeile).toContainText('Alles klar');
  });

  test('der Knopf fuer ein neues Gespraech ist da und gross genug', async () => {
    const fab = a.getByTestId('chats-compose');
    await expect(fab).toBeVisible();
    const kasten = await fab.boundingBox();
    expect(kasten!.width).toBeGreaterThanOrEqual(48);
    expect(kasten!.height).toBeGreaterThanOrEqual(48);
  });

  test('im Gespraech stehen Sprechblasen, eigene rechts', async () => {
    await a.goto(`/app/@me/${dmId}`);
    const blasen = a.getByTestId('dm-bubble');
    await expect(blasen.first()).toBeVisible();
    // Die eigene Nachricht ist als solche ausgezeichnet — daran haengt Seite
    // und Farbe.
    const eigene = a.locator('[data-testid=message-item][data-eigen=true]');
    await expect(eigene).toHaveCount(1);
    const fremde = a.locator('[data-testid=message-item][data-eigen=false]');
    await expect(fremde).toHaveCount(1);
  });

  test('eigene Blase steht weiter rechts als die fremde', async () => {
    await a.goto(`/app/@me/${dmId}`);
    await expect(a.getByTestId('dm-bubble').first()).toBeVisible();
    const eigen = await a
      .locator('[data-testid=message-item][data-eigen=true] [data-testid=dm-bubble]')
      .boundingBox();
    const fremd = await a
      .locator('[data-testid=message-item][data-eigen=false] [data-testid=dm-bubble]')
      .boundingBox();
    expect(eigen!.x).toBeGreaterThan(fremd!.x);
    if (process.env.BILD_DIR) {
      await a.screenshot({ path: `${process.env.BILD_DIR}/6-dm-blasen.png` });
      await a.goto('/app/@me');
      await a.getByTestId('mobile-chats-list').waitFor({ state: 'visible', timeout: 20000 });
      await a.getByTestId('mobile-tab-bar').waitFor({ state: 'visible', timeout: 20000 });
      await a.waitForTimeout(500);
      await a.screenshot({ path: `${process.env.BILD_DIR}/7-chats-liste.png` });
    }
  });

  test('Gegenprobe: ein Community-Kanal hat KEINE Sprechblasen', async () => {
    // Eine Community anlegen und hineinschreiben — dort muss die alte
    // Zeilen-Darstellung stehen bleiben.
    const kanalId = await a.evaluate(async () => {
      const token = localStorage.getItem('dcc.tokens.access');
      const kopf = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
      const g = await (
        await fetch('/api/chat/guilds', {
          method: 'POST',
          headers: kopf,
          body: JSON.stringify({ name: 'Blasenprobe' })
        })
      ).json();
      // Eine frische Community bringt keinen Textkanal mit — einen anlegen.
      const k = await (
        await fetch(`/api/chat/guilds/${g.id}/channels`, {
          method: 'POST',
          headers: kopf,
          body: JSON.stringify({ name: 'allgemein', type: 0 })
        })
      ).json();
      await fetch(`/api/chat/channels/${k.id}/messages`, {
        method: 'POST',
        headers: kopf,
        body: JSON.stringify({ content: 'im Kanal' })
      });
      return `${g.id}/channels/${k.id}`;
    });
    await a.goto(`/app/guilds/${kanalId}`);
    await expect(a.getByTestId('message-content').first()).toBeVisible();
    await expect(a.getByTestId('dm-bubble')).toHaveCount(0);
    // Der Autorname steht im Kanal weiter da — genau dafuer bleibt es dort
    // bei der Zeilen-Darstellung.
    await expect(a.getByTestId('message-author').first()).toBeVisible();
  });
});
