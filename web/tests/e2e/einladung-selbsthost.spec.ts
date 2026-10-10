/**
 * Einladungen auf einen Self-Host (`?host=`). Kernzusage der Spec
 * (2026-10-10, Sicherheit 2): einen unbekannten Self-Host fragt Pulse vor der
 * Erstkontakt-Zustimmung NICHT — weder für die Vorschau noch beim Klick auf
 * „Beitreten“. Er sähe sonst die IP-Adresse, bevor der Nutzer zugestimmt hat.
 *
 * Der Host liegt unter `.invalid` (RFC 2606, löst nie auf); geprüft wird,
 * dass Pulse es gar nicht erst versucht. Dass der Mitschnitt auch eine
 * Anfrage sieht, deren Namensauflösung scheitert, belegt die Gegenprobe im
 * ersten Test.
 */
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

const HOST = 'pulse-heim.invalid';
const ts = Date.now();
const NUTZER = {
  username: `sh_eva_${ts}`,
  email: `sh_eva_${ts}@dcc-test.example.com`,
  password: 'sh-secret-pass'
};

const karte = (page: Page, zustand: string) =>
  page.locator(`[data-testid=einladung-karte][data-zustand=${zustand}]`);

/** Schreibt jede Anfrage der Seite mit. Ein Service Worker könnte Anfragen an
 *  `page.on('request')` vorbei stellen — der Kontext blockt ihn deshalb. */
function mitschreiben(page: Page): string[] {
  const urls: string[] = [];
  page.on('request', (r) => urls.push(r.url()));
  return urls;
}

/** Der Mitschnitt muss überhaupt etwas gesehen haben (die Seite lädt ihre
 *  eigenen Dateien) — sonst wäre „keine Anfrage an den Host“ wertlos. */
async function keinKontakt(page: Page, urls: string[]) {
  // Anfragen werden asynchron gemeldet — kurz warten, dann lesen.
  await page.waitForTimeout(500);
  expect(urls.length).toBeGreaterThan(0);
  expect(urls.filter((u) => new URL(u).hostname === HOST)).toEqual([]);
}

async function frischerKontext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({ serviceWorkers: 'block' });
}

test.describe('Einladung auf einen Self-Host', () => {
  test('Abgemeldet: die Einladung zeigt den Server, ohne ihn zu fragen', async ({ browser }) => {
    const ctx = await frischerKontext(browser);
    try {
      const p = await ctx.newPage();
      const urls = mitschreiben(p);
      await p.goto(`/invite/abc12345?host=${HOST}`);
      await expect(karte(p, 'abgemeldet')).toBeVisible({ timeout: 15_000 });
      await expect(p.getByTestId('einladung-name')).toHaveText('Community auf eigenem Server');
      await expect(p.getByTestId('einladung-host')).toContainText(HOST);
      await keinKontakt(p, urls);

      // Gegenprobe: ein Abruf, der an der Namensauflösung scheitert, landet im Mitschnitt.
      await p.evaluate((h) => fetch(`https://${h}/`).catch(() => undefined), HOST);
      await expect.poll(() => urls.some((u) => new URL(u).hostname === HOST)).toBe(true);
    } finally {
      await ctx.close();
    }
  });

  test('Abgemeldet: die öffentliche Adresse ebenso', async ({ browser }) => {
    const ctx = await frischerKontext(browser);
    try {
      const p = await ctx.newPage();
      const urls = mitschreiben(p);
      await p.goto(`/c/mein-club?host=${HOST}`);
      await expect(karte(p, 'abgemeldet')).toBeVisible({ timeout: 15_000 });
      await expect(p.getByTestId('einladung-host')).toContainText(HOST);
      await keinKontakt(p, urls);
    } finally {
      await ctx.close();
    }
  });

  test('Angemeldet: Beitreten fragt erst nach, der Server bleibt unberührt', async ({ browser }) => {
    const ctx = await frischerKontext(browser);
    try {
      const p = await ctx.newPage();
      await p.goto('/register');
      await p.getByTestId('reg-username').fill(NUTZER.username);
      await p.getByTestId('reg-email').fill(NUTZER.email);
      await p.getByTestId('reg-password').fill(NUTZER.password);
      await p.getByTestId('reg-submit').click();
      await p.waitForURL(/\/app/);

      const urls = mitschreiben(p);
      await p.goto(`/invite/abc12345?host=${HOST}`);
      await expect(karte(p, 'einladung')).toBeVisible({ timeout: 15_000 });
      await expect(p.getByTestId('einladung-host')).toContainText(HOST);

      await p.getByTestId('einladung-beitreten').click();
      const rueckfrage = p.getByTestId('self-host-contact-confirm-dialog');
      await expect(rueckfrage).toBeVisible();
      await expect(p.getByTestId('self-host-contact-confirm-host')).toHaveText(HOST);
      await p.keyboard.press('Escape');
      await expect(rueckfrage).toBeHidden();
      await expect(karte(p, 'einladung')).toBeVisible();
      await keinKontakt(p, urls);
    } finally {
      await ctx.close();
    }
  });

  test('Ungültige Server-Adresse: die Karte sagt es, statt „abgelaufen“', async ({ browser }) => {
    const ctx = await frischerKontext(browser);
    try {
      const p = await ctx.newPage();
      for (const pfad of ['/invite/abc12345?host=192.168.1.10', '/c/mein-club?host=chat.firma.de:8443']) {
        await p.goto(pfad);
        await expect(karte(p, 'ungueltig')).toBeVisible({ timeout: 15_000 });
        await expect(p.getByTestId('einladung-hinweis')).toHaveText(
          'Die Server-Adresse in diesem Link ist ungültig.'
        );
      }
    } finally {
      await ctx.close();
    }
  });
});
