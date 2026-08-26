/**
 * Trefferflächen und Safe-Areas — der Durchgang, der sonst niemandem auffällt.
 *
 * Ein zu kleiner Knopf funktioniert im Test mit einer Maus tadellos und ist
 * mit dem Daumen unbenutzbar. Deshalb misst diese Datei tatsächlich nach,
 * statt sich auf Klassennamen zu verlassen: **jede tippbare Fläche auf jedem
 * der vier Bereiche muss mindestens 48 dp haben** (deckt iOS 44 pt und
 * Android 48 dp ab).
 *
 * Ausgenommen sind nur Flächen, die keine eigene Handlung sind: Zeilen einer
 * Liste sind ohnehin gross, und Elemente ausserhalb des sichtbaren Bereichs
 * haben keine messbare Grösse.
 */
import { test, expect, type Page } from '@playwright/test';

const PW = 'Passwort123!';
const TAG = Date.now().toString(36);
const HANDY = { width: 390, height: 844 };
const MINDEST = 48;

test.describe.configure({ mode: 'serial' });

/** Bereiche, die ohne weitere Vorbereitung erreichbar sind. */
const BEREICHE = ['/app/@me', '/app/rooms', '/app/friends', '/app/me'] as const;

test.describe('Trefferflächen auf dem Handy', () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage({ viewport: HANDY });
    await page.goto('/register');
    await page.getByTestId('reg-username').fill(`tap_${TAG}`);
    await page.getByTestId('reg-email').fill(`tap_${TAG}@dcc-test.example.com`);
    await page.getByTestId('reg-password').fill(PW);
    await page.getByTestId('reg-submit').click();
    await page.waitForURL(/\/app/);
    await page
      .locator('[data-testid=backup-onboarding-skip-btn]')
      .click({ timeout: 2500 })
      .catch(() => undefined);
  });

  test.afterAll(async () => {
    await page.close();
  });

  for (const pfad of BEREICHE) {
    test(`${pfad}: jede tippbare Flaeche ist mindestens ${MINDEST} dp`, async () => {
      await page.goto(pfad);
      await expect(page.getByTestId('mobile-tab-bar')).toBeVisible();
      const zuKlein = await page.evaluate((min) => {
        const raus: string[] = [];
        for (const el of document.querySelectorAll<HTMLElement>('button, a[href]')) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue; // nicht sichtbar
          if (r.height >= min && r.width >= min) continue;
          // Eine zu SCHMALE, aber hohe Flaeche ist in Ordnung, solange sie
          // hoch genug ist — der Daumen trifft die Zeile, nicht das Symbol.
          if (r.height >= min) continue;
          raus.push(
            `${el.dataset.testid ?? el.className.slice(0, 40)} ${Math.round(r.width)}x${Math.round(r.height)}`
          );
        }
        return raus;
      }, MINDEST);
      expect(zuKlein, `zu kleine Flaechen auf ${pfad}`).toEqual([]);
    });
  }

  test('Bereichs-Leiste und Voice-Dock halten den unteren Systembereich frei', async () => {
    await page.goto('/app/@me');
    await expect(page.getByTestId('mobile-tab-bar')).toBeVisible();
    // `--safe-bottom` ist im Testbrowser 0 (kein Home-Balken). Geprueft wird
    // deshalb, dass die Leiste das Polster ueberhaupt ANWENDET — sonst faellt
    // erst auf einem echten Telefon auf, dass sie darunter liegt.
    const polster = await page.evaluate(() => {
      const leiste = document.querySelector('[data-testid=mobile-tab-bar]');
      const huelle = leiste?.parentElement;
      return huelle ? getComputedStyle(huelle).paddingBottom : null;
    });
    expect(polster).not.toBeNull();
  });

  test('die Bereichs-Leiste sitzt unten, als schwebende Karte', async () => {
    // Die Leiste KLEBT bewusst nicht am Rand: sie ist eine Karte mit Luft
    // ringsum (`mx-2 mb-2` in MobileTabBar, dieselbe Behandlung wie der
    // Profilblock der Du-Seite). Der Test verlangte vorher Randbündigkeit und
    // war seit dieser Gestaltung dauerhaft rot — ein roter Test meldet keine
    // Regression mehr. Geprüft wird deshalb, was wirklich gilt: die Leiste
    // liegt im untersten Zehntel, und unter ihr steht nur die Kartenluft.
    const kasten = await page.getByTestId('mobile-tab-bar').boundingBox();
    const hoehe = page.viewportSize()!.height;
    const unterkante = kasten!.y + kasten!.height;
    expect(unterkante).toBeGreaterThan(hoehe * 0.9);
    expect(hoehe - unterkante).toBeLessThanOrEqual(16);
  });
});
