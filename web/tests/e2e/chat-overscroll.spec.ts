import { test, expect, type Page } from '@playwright/test';

/**
 * Öffnen einer Nachrichtenliste darf kein Scrollen UNTERHALB der letzten
 * Nachricht erlauben. virtua misst Zeilen erst, wenn sie im Sichtfenster
 * liegen; bis dahin zählt jede ungemessene Zeile mit dem 48px-Schätzwert
 * (`itemSize`) zur Scrollhöhe. Kurze Folgezeilen sind real ~30px — die
 * Scrollhöhe war in diesem Fenster um Hunderte px zu groß (nachgemessen:
 * +373px auf einem 50-Zeilen-Kanal), das Rad konnte in den Leerraum
 * scrollen und die letzte Nachricht hing mittig im Fenster, bis die
 * Messungen den Spacer schrumpfen ließen.
 *
 * Seit der Mess-Sperre in `MessageList.svelte` liegt der Viewport in dieser
 * Phase per overflow-y:hidden still (nur Nutzer-Gesten, nicht der Pin).
 * Gemessen wird per in-page rAF-Recorder jede Frame: Scroll-Lage, echte
 * visuelle Unterkante des letzten gemounteten Items und overflow-y.
 */

const ts = Date.now();
const USER = {
  username: `over_${ts}`,
  email: `over_${ts}@dcc-test.example.com`,
  password: 'sup3r-secret-pass'
};

// Läuft ab Document-Start (addInitScript) und überlebt SPA-Wechsel.
const RECORDER = `
(() => {
  window.__rec = [];
  window.__recStart = performance.now();
  const tick = () => {
    const vp = document.querySelector('[data-testid=message-list] > div');
    const inner = vp && vp.firstElementChild;
    if (vp && inner && inner.children.length) {
      let vb = 0;
      for (const c of inner.children) {
        const b = c.offsetTop + c.getBoundingClientRect().height;
        if (b > vb) vb = b;
      }
      window.__rec.push({
        t: Math.round(performance.now() - window.__recStart),
        top: Math.round(vp.scrollTop),
        sh: Math.round(vp.scrollHeight),
        ch: Math.round(vp.clientHeight),
        vb: Math.round(vb),
        ov: getComputedStyle(vp).overflowY
      });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();
`;

type Frame = { t: number; top: number; sh: number; ch: number; vb: number; ov: string };

async function auswerten(page: Page, label: string) {
  const rec: Frame[] = await page.evaluate(() => (window as any).__rec ?? []);
  console.log(`\n===== ${label} (${rec.length} Frames) =====`);
  let prev = '';
  for (const s of rec) {
    const key = `${s.top}/${s.sh}/${s.vb}/${s.ov}`;
    if (key !== prev) {
      console.log(
        `t=${String(s.t).padStart(6)} top=${String(s.top).padStart(6)} max=${String(s.sh - s.ch).padStart(6)} ` +
          `scrollH=${String(s.sh).padStart(6)} visBottom=${String(s.vb).padStart(6)} ` +
          `blankBelow=${String(s.sh - s.vb).padStart(5)} overflow=${s.ov}`
      );
      prev = key;
    }
  }
  const letzte = rec[rec.length - 1];
  return {
    frames: rec.length,
    sperreGegriffen: rec.some((s) => s.ov === 'hidden'),
    sperreFrei: letzte?.ov !== 'hidden',
    flushAmEnde:
      !!letzte && Math.abs(letzte.sh - letzte.ch - letzte.top) <= 2 && letzte.sh - letzte.vb <= 5
  };
}

async function register(page: Page) {
  await page.goto('/register');
  await page.getByTestId('reg-username').fill(USER.username);
  await page.getByTestId('reg-email').fill(USER.email);
  await page.getByTestId('reg-password').fill(USER.password);
  await page.getByTestId('reg-submit').click();
  await page.waitForURL(/\/app/);
  await page
    .locator('[data-testid=backup-onboarding-skip-btn]')
    .click({ timeout: 2500 })
    .catch(() => undefined);
}

async function sende(page: Page, channelId: string, texte: string[], abstandMs = 115) {
  const fehl = await page.evaluate(
    async ([cid, texte, abstand]) => {
      const token = localStorage.getItem('dcc.tokens.access');
      let fehl = 0;
      for (const content of texte) {
        const r = await fetch(`/api/chat/channels/${cid}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ content, nonce: null, reply_to_id: null, attachment_ids: [] })
        });
        if (r.status !== 201 && r.status !== 200) fehl++;
        await new Promise((r) => setTimeout(r, abstand));
      }
      return fehl;
    },
    [channelId, texte, abstandMs] as const
  );
  expect(fehl).toBe(0);
}

test.describe.serial('Nachrichtenliste: kein Scrollen unter die letzte Nachricht', () => {
  let page: Page;
  let guildId = '';
  let hochId = '';
  let kurzId = '';

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.route('**/changelog.json', (r) => r.fulfill({ json: { entries: [] } }));
    await ctx.addInitScript(RECORDER);
    page = await ctx.newPage();
  });

  test('Vorbereitung: hoher + kurzer Kanal', async () => {
    test.setTimeout(120_000);
    await register(page);
    await page.locator('[data-testid^="guild-create-menu-"]').first().click();
    await page.getByTestId('guild-create').click();
    await page.getByTestId('create-guild-name').fill('Over');
    await page.getByTestId('create-guild-submit').click();
    await page.waitForURL(/\/app\/guilds\/\d+\/channels\/\d+/);
    const teile = new URL(page.url()).pathname.split('/');
    guildId = teile[3];
    hochId = teile[5];
    // Kurze Folgezeilen (real ~30px) maximieren den Schätzfehler der 48px.
    await sende(page, hochId, ['Erste Nachricht', ...Array.from({ length: 49 }, (_, i) => `ok ${i}`)]);
    await page.getByTestId('channel-create').click();
    await page.getByTestId('create-channel-type-text').click();
    await page.getByTestId('create-channel-name').fill('kurz');
    await page.getByTestId('create-channel-submit').click();
    await page.locator('[data-testid=channel-list] button', { hasText: 'kurz' }).first().click();
    await page.waitForURL((u) => !u.pathname.endsWith(hochId), { timeout: 10_000 });
    kurzId = new URL(page.url()).pathname.split('/')[5];
    expect(kurzId).not.toBe(hochId);
    await sende(page, kurzId, ['Erste Nachricht im kurzen Kanal', ...Array.from({ length: 49 }, (_, i) => `ok ${i}`)]);
  });

  test('Frisches Öffnen (Reload): Sperre greift und gibt frei, Ende flush', async () => {
    test.setTimeout(60_000);
    await page.evaluate(() => { (window as any).__rec = []; });
    await page.goto(`/app/guilds/${guildId}/channels/${kurzId}`);
    await page.getByTestId('active-channel-name').waitFor();
    await page.waitForTimeout(800);
    const erg = await auswerten(page, 'Reload → kurzer Kanal');
    expect(erg.frames).toBeGreaterThan(0);
    expect(erg.sperreGegriffen).toBe(true);
    expect(erg.sperreFrei).toBe(true);
    expect(erg.flushAmEnde).toBe(true);
  });

  test('SPA-Wechsel: Sperre greift und gibt frei, Ende flush', async () => {
    test.setTimeout(60_000);
    await page.goto(`/app/guilds/${guildId}/channels/${hochId}`);
    await page.getByTestId('active-channel-name').waitFor();
    await page.waitForTimeout(800);
    await page.evaluate(() => { (window as any).__rec = []; });
    await page.getByTestId(`channel-${kurzId}`).click();
    await page.getByTestId('active-channel-name').filter({ hasText: 'kurz' }).waitFor();
    await page.waitForTimeout(800);
    const erg = await auswerten(page, 'SPA-Wechsel hoch → kurz');
    expect(erg.frames).toBeGreaterThan(0);
    expect(erg.sperreGegriffen).toBe(true);
    expect(erg.sperreFrei).toBe(true);
    expect(erg.flushAmEnde).toBe(true);
  });
});
