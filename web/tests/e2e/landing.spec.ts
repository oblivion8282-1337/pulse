/**
 * Statische Landingpage (`web/static/landing.html`).
 *
 * Geprueft wird gegen `/landing.html`, NICHT gegen `/`. Im Betrieb faengt
 * nginx die Wurzel ab und liefert die Datei dort aus (`location = /` in
 * `infra/prod/web-nginx.conf`) — im E2E-Aufbau gibt es kein nginx, sondern nur
 * den Vite-Dev-Server, und der liefert `web/static/` unter seinem Dateinamen
 * aus. `/` waere hier die SvelteKit-Route und damit ein anderer Test.
 *
 * Der Schwerpunkt liegt auf dem, was an einer Marketing-Seite still kaputt
 * geht: ein Knopf ohne Ziel, ein Anker auf einen Abschnitt, den es nicht mehr
 * gibt, eine Download-URL, die von `appDownloads.ts` weggelaufen ist, und ein
 * Umbruch, der auf dem Telefon quer scrollt.
 */
import { test, expect, type Page } from '@playwright/test';

const SEITE = '/landing.html';
const HANDY = { width: 390, height: 844 };

/** Interne Ziele, die es in der App (oder als statische Datei) wirklich gibt. */
const INTERNE_ROUTEN = ['/', '/login', '/impressum', '/datenschutz'];

/** Kopie aus `web/static/landing.js` bzw. `web/src/lib/downloads/appDownloads.ts`. */
const DOWNLOADS = [
  'https://howispulse.com/updates/win/Pulse-Setup-latest.exe',
  'https://howispulse.com/downloads/Pulse-latest.dmg',
  'https://howispulse.com/downloads/pulse-latest.apk',
  'https://howispulse.com/flatpak/com.howispulse.Pulse.flatpakref'
];

test.describe('Landingpage', () => {
  test('zeigt Wortmarke und Anspruch', async ({ page }) => {
    await page.goto(SEITE);
    await expect(page.locator('.lp-wortmarke')).toHaveText('Pulse');
    await expect(page.getByText('Du verdienst was Besseres.')).toBeVisible();
  });

  test('jeder Navigations-Anker trifft einen vorhandenen Abschnitt', async ({ page }) => {
    await page.goto(SEITE);
    const anker = await page.locator('.lp-nav-links a').evaluateAll((as) =>
      as.map((a) => (a as HTMLAnchorElement).getAttribute('href') || '')
    );
    expect(anker.length).toBeGreaterThan(0);
    for (const h of anker) {
      expect(h.startsWith('#'), `Nav-Link ohne Anker: ${h}`).toBe(true);
      await expect(page.locator(h)).toHaveCount(1);
    }
  });

  test('kein Link ohne echtes Ziel', async ({ page }) => {
    await page.goto(SEITE);
    const links = await page.locator('a[href]').evaluateAll((as) =>
      as.map((a) => ({
        href: (a as HTMLAnchorElement).getAttribute('href') || '',
        text: (a.textContent || '').trim().slice(0, 40)
      }))
    );
    const ids = await page.locator('[id]').evaluateAll((els) => els.map((e) => e.id));

    expect(links.length).toBeGreaterThan(10);
    for (const { href, text } of links) {
      const wo = `„${text}" → ${href}`;
      expect(href, `leeres Ziel bei ${wo}`).not.toBe('');
      expect(href, `Platzhalter-Ziel bei ${wo}`).not.toBe('#');
      if (href.startsWith('#')) {
        expect(ids, `Anker ins Leere bei ${wo}`).toContain(href.slice(1));
      } else if (href.startsWith('http')) {
        expect(DOWNLOADS, `unbekannte externe URL bei ${wo}`).toContain(href);
      } else {
        expect(INTERNE_ROUTEN, `unbekannte interne Route bei ${wo}`).toContain(href);
      }
    }
  });

  test('„Im Browser öffnen" führt zur Anmeldung', async ({ page }) => {
    await page.goto(SEITE);
    await page.locator('.lp-hero-knoepfe a', { hasText: 'Im Browser öffnen' }).click();
    await page.waitForURL(/\/login/);
  });

  test('der Umschalter wechselt nach Englisch und merkt sich das', async ({ page }) => {
    await page.goto(SEITE);
    await expect(page.locator('html')).toHaveAttribute('lang', 'de');

    await page.locator('[data-lp-sprache="en"]').click();
    await expect(page.getByText('You deserve better.')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('[data-lp-sprache="en"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-lp-sprache="de"]')).toHaveAttribute('aria-pressed', 'false');

    await page.reload();
    await expect(page.getByText('You deserve better.')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  });

  test('wer angemeldet ist, sieht die Werbeseite gar nicht', async ({ page }) => {
    // Ziel-URL pruefen, nicht den App-Inhalt: `/app` haengt an Backend und
    // Sitzung, hier geht es nur um die Weiterleitung. Deshalb wird `/app`
    // abgefangen — sonst raeumte die App das gefaelschte Token sofort weg und
    // schickte den Browser weiter zur Anmeldung.
    await page.route('**/app', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>app</body></html>' })
    );
    await page.addInitScript(() => {
      window.localStorage.setItem('dcc.tokens.refresh', 'x');
    });
    await page.goto(SEITE);
    await page.waitForURL(/\/app$/);
  });

  test('kein Querscrollen auf dem Telefon', async ({ page }) => {
    await page.setViewportSize(HANDY);
    await page.goto(SEITE);
    await erwarteKeinQuerscrollen(page);
  });
});

async function erwarteKeinQuerscrollen(page: Page) {
  const [scrollWidth, innerWidth] = await page.evaluate(() => [
    document.documentElement.scrollWidth,
    window.innerWidth
  ]);
  expect(scrollWidth, `Seite ist ${scrollWidth}px breit bei ${innerWidth}px Fenster`).toBeLessThanOrEqual(
    innerWidth
  );
}
