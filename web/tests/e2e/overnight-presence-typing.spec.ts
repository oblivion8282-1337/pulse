import { test, expect, type Page, type BrowserContext } from '@playwright/test';

/**
 * Overnight Bughunt T18 — Präsenz und Tippanzeige.
 *
 * Beobachtbar ist Präsenz in dieser Umgebung über die MITGLIEDERLISTE einer
 * gemeinsamen Community: sie gruppiert nach Socket-Präsenz (`presence.
 * isOnline`) und funktioniert serverunabhängig — anders als die Freundes-
 * liste, deren Präsenztopf nur von der Cloud-Verbindung gespeist wird und
 * im Test-Stack (Self-Host) leer bleibt.
 *
 * ponytail: Der Voice-Präsenz-Punkt (Test 1) wird NICHT durch einen echten
 * LiveKit-Join erzeugt — unter der E2E-Suite läuft kein voice-signaling
 * (`_ports.ts`), ein echter Join scheitert zwangsläufig. Stattdessen wird
 * der `voicePresence`-Store von Gerät B mit A's Nutzer-ID gesät (gleiches
 * Muster wie `stream-picker.spec.ts`); geprüft wird die Darstellung des
 * Punkts. Upgrade-Pfad: voice-signaling mit in die Suite aufnehmen und den
 * Seed durch einen echten Join ersetzen.
 */

const ts = Date.now();
const ALICE = {
  username: `alice_t18_${ts}`,
  email: `alice_t18_${ts}@dcc-test.example.com`,
  password: 'sup3r-secret-pass'
};
const BOB = {
  username: `bob_t18_${ts}`,
  email: `bob_t18_${ts}@dcc-test.example.com`,
  password: 'sup3r-secret-pass'
};

async function register(page: Page, u: { username: string; email: string; password: string }) {
  await page.goto('/register');
  await page.getByTestId('reg-username').fill(u.username);
  await page.getByTestId('reg-email').fill(u.email);
  await page.getByTestId('reg-password').fill(u.password);
  await page.getByTestId('reg-submit').click();
  await page.waitForURL(/\/app/);
  await page
    .locator('[data-testid=backup-onboarding-skip-btn]')
    .click({ timeout: 2500 })
    .catch(() => undefined);
}

async function login(page: Page, u: { username: string; password: string }): Promise<void> {
  await page.goto('/login');
  await page.getByTestId('login-identifier').fill(u.username);
  await page.getByTestId('login-password').fill(u.password);
  await page.getByTestId('login-submit').click();
  await page.waitForURL(/\/app/, { timeout: 20_000 });
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
  if (!value) throw new Error('no access token found in localStorage');
  return value;
}

/** REST-Call mit dem Token der Seite (Muster wie `voice-user-limit.spec.ts`). */
async function api<T>(
  page: Page,
  path: string,
  init?: { method?: string; body?: unknown }
): Promise<T> {
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

/** Die "Offline"-Gruppe der Mitgliederliste — sie existiert nur, wenn
 *  wirklich jemand offline ist (`MemberList.svelte`). */
function offlineGruppe(page: Page) {
  return page.getByTestId('member-list').getByText('Offline', { exact: true });
}

async function statusMenueOeffnen(page: Page): Promise<void> {
  await page.getByTestId('status-picker-trigger').click();
  await expect(page.getByTestId('status-option-online')).toBeVisible();
}

test.describe.serial('Overnight T18 — Präsenz und Tippanzeige', () => {
  let aliceCtx: BrowserContext;
  let alicePage: Page;
  let bobCtx: BrowserContext;
  let bobPage: Page;
  let guildId = '';
  let textChannelId = '';
  let voiceChannelId = '';

  test.beforeAll(async ({ browser }) => {
    aliceCtx = await browser.newContext();
    bobCtx = await browser.newContext();
    for (const ctx of [aliceCtx, bobCtx]) {
      await ctx.route('**/changelog.json', (route) => route.fulfill({ json: { entries: [] } }));
    }
    alicePage = await aliceCtx.newPage();
    bobPage = await bobCtx.newPage();
  });

  test.afterAll(async () => {
    await aliceCtx?.close();
    await bobCtx?.close();
  });

  test('Beide online: keine Offline-Gruppe; Voice-Präsenz-Punkt von A sichtbar', async () => {
    // Erster Test des Laufs: Vite kompiliert die App hier kalt.
    test.setTimeout(120_000);
    await register(alicePage, ALICE);
    await register(bobPage, BOB);
    const aliceUserId = await currentUserId(alicePage);
    const bobUserId = await currentUserId(bobPage);

    // Community (Text + Sprache) per API, Bob per Einladung hinein.
    const guild = await api<{ id: string }>(alicePage, '/guilds', {
      method: 'POST',
      body: { name: `T18 Lounge ${ts}` }
    });
    guildId = guild.id;
    const textKanal = await api<{ id: string }>(alicePage, `/guilds/${guildId}/channels`, {
      method: 'POST',
      body: { name: 'general', type: 0, position: 0 }
    });
    textChannelId = textKanal.id;
    const voiceKanal = await api<{ id: string }>(alicePage, `/guilds/${guildId}/channels`, {
      method: 'POST',
      body: { name: 'lounge', type: 1, position: 1 }
    });
    voiceChannelId = voiceKanal.id;
    const invite = await api<{ code: string }>(alicePage, `/guilds/${guildId}/invites`, {
      method: 'POST',
      body: {}
    });
    await api(bobPage, `/invites/${invite.code}/accept`, { method: 'POST', body: {} });

    // Bob sitzt im Textkanal und sieht beide Mitglieder.
    await bobPage.goto(`/app/guilds/${guildId}/channels/${textChannelId}`);
    await expect(bobPage.getByTestId('member-list')).toBeVisible({ timeout: 15_000 });
    await expect(
      bobPage.getByTestId('member-list').getByText(ALICE.username)
    ).toBeVisible({ timeout: 15_000 });
    // Keiner offline → keine Offline-Gruppe.
    await expect(offlineGruppe(bobPage)).toHaveCount(0);

    // ponytail: Seed statt echtem Voice-Join — Begruendung im Modulkopf.
    await bobPage.evaluate(({ kanalId, uid }) => {
      return import('/src/lib/stores/voicePresence.svelte.ts').then((m) =>
        m.voicePresence.seed([{ channel_id: kanalId, user_ids: [uid] }])
      );
    }, { kanalId: voiceChannelId, uid: aliceUserId });
    await expect(
      bobPage.locator(`[data-testid="voice-presence-list"][data-channel-id="${voiceChannelId}"]`)
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      bobPage.locator(`[data-testid="voice-presence-list"][data-channel-id="${voiceChannelId}"] [data-testid="voice-presence-member"]`)
    ).toHaveCount(1);
  });

  test('Status „Nicht stören": A Badge wechselt, B sieht A weiterhin online', async () => {
    await statusMenueOeffnen(alicePage);
    await alicePage.getByTestId('status-option-dnd').click();
    await expect(alicePage.getByTestId('status-picker-trigger')).toContainText('Nicht stören', {
      timeout: 7_000
    });
    // DND lässt die Socket-Präsenz unberührt — die Offline-Gruppe bleibt leer.
    await expect(offlineGruppe(bobPage)).toHaveCount(0, { timeout: 7_000 });
  });

  test('Status „Unsichtbar": A eigener Punkt grau, B sieht A offline', async () => {
    await statusMenueOeffnen(alicePage);
    await alicePage.getByTestId('status-option-invisible').click();
    // A's eigener Dot: unsichtbar (grau) — aria-label trägt den echten Status.
    await expect(
      alicePage.getByTestId('status-picker-trigger').locator('span[aria-label="invisible"]')
    ).toBeVisible({ timeout: 7_000 });
    // Der Server maskiert unsichtbar → offline; B's Liste schiebt A nach unten.
    await expect(offlineGruppe(bobPage)).toBeVisible({ timeout: 10_000 });
  });

  test('Zurück online + Tippanzeige: B sieht "schreibt …" und danach die Nachricht', async () => {
    await statusMenueOeffnen(alicePage);
    await alicePage.getByTestId('status-option-online').click();
    await expect(offlineGruppe(bobPage)).toHaveCount(0, { timeout: 10_000 });

    // A gesellt sich in den Kanal und tippt — B sieht die Tippanzeige.
    await alicePage.goto(`/app/guilds/${guildId}/channels/${textChannelId}`);
    await expect(alicePage.getByTestId('message-input')).toBeVisible({ timeout: 15_000 });
    await alicePage.getByTestId('message-input').pressSequentially('hallo bob', { delay: 120 });

    const indicator = bobPage.getByTestId('typing-indicator');
    await expect(indicator).toBeVisible({ timeout: 10_000 });
    await expect(indicator).toContainText('schreibt');

    // Senden löscht die Anzeige sofort (`typing.clear` beim Nachrichten-
    // eingang, nicht erst nach der TTL).
    await alicePage.getByTestId('message-input').press('Enter');
    await expect(
      bobPage.locator('[data-testid="message-content"]', { hasText: 'hallo bob' })
    ).toBeVisible({ timeout: 10_000 });
    await expect(indicator).toBeHidden({ timeout: 10_000 });
  });

  test('A meldet sich ab → B sieht sie offline', async () => {
    await alicePage.getByTestId('user-footer-trigger').click();
    await alicePage.getByTestId('sign-out').click();
    await alicePage.waitForURL(/\/login/);
    await expect(offlineGruppe(bobPage)).toBeVisible({ timeout: 10_000 });
    await expect(
      bobPage.getByTestId('member-list').getByText(ALICE.username)
    ).toBeVisible();
  });

  test('Wiederanmeldung → B sieht A wieder online', async () => {
    await login(alicePage, ALICE);
    await expect(offlineGruppe(bobPage)).toHaveCount(0, { timeout: 15_000 });
    await expect(
      bobPage.getByTestId('member-list').getByText(ALICE.username)
    ).toBeVisible();
  });
});
