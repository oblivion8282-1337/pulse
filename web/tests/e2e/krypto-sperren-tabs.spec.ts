import { test, expect, type Page, type BrowserContext } from '@playwright/test';

/**
 * Der Browser-Nachweis zum Bughunt vom 2026-08-29: der Krypto-Zustand liegt
 * in IndexedDB und gehoert damit dem BROWSERPROFIL, die Absicherung lag aber
 * in einer Modul-`Map` und gehoerte damit dem TAB. Die Sperre liegt seither
 * auf `navigator.locks` (`$lib/krypto/sperren.ts`).
 *
 * Zwei Behauptungen, und die zweite ist die eigentliche:
 *
 *  1. **Web Locks gibt es hier, und sie gelten ueber Tabs hinweg.** Der
 *     ganze Fix steht darauf. `sperren.ts` wirft ausdruecklich, wenn
 *     `navigator.locks` fehlt (kein stiller Rueckfall) — dieser Test sagt,
 *     ob dieser Wurf im Auslieferzustand je vorkommt.
 *  2. **Der Abholzyklus des Postfachs laeuft in zwei Tabs nacheinander.**
 *     Er ist die Stelle, die ein Nutzer taeglich ausloest, ohne etwas dafuer
 *     zu tun: `ready` startet ihn bei JEDEM Verbindungsaufbau
 *     (`ws/handlers/ready.ts`), also in jedem geoeffneten Tab. Er laedt EIN
 *     Konto-Objekt und mutiert es ueber alle Zustellungen hinweg (jeder
 *     eingehende Sitzungsaufbau verbraucht einen Einmalschluessel auf dem
 *     Konto) — zwei gleichzeitige Zyklen ueberschreiben einander den
 *     Kontostand. Deshalb laeuft der ganze Zyklus unter der Konto-Sperre.
 *
 * **Wie der Test die Ueberlappung ueberhaupt sichtbar macht:** ohne Zutun
 * waere ein Zyklus in Millisekunden vorbei und zwei Tabs traefen sich
 * vielleicht nie. Tab A bekommt deshalb seine `POST /postfach/abholen`-
 * Antwort kuenstlich verzoegert; Tab B startet in dieses Fenster hinein. Ohne
 * Sperre schickt B seine eigene Abholung sofort los, mit Sperre erst, nachdem
 * A fertig ist. Gemessen werden die Zeitpunkte der Anfragen, nicht ein
 * Endergebnis — die Ueberlappung IST der Fehler.
 *
 * Der Schalter `E2E_DMS_ENABLED` ist Vorgabe AUS; er wird wie in
 * `e2e-dm.spec.ts` an der Dev-Server-Antwort umgelegt, ohne den Quelltext zu
 * aendern (ohne ihn holt niemand das Postfach ab, s. `ws/handlers/chat.ts`).
 */

const ts = Date.now();
const ALICE = {
  username: `alice_sperren_${ts}`,
  email: `alice_sperren_${ts}@dcc-test.example.com`,
  password: 'sup3r-secret-pass'
};

/** Wie lange Tab A seine Abholung haelt. Grosszuegig: Tab B muss in diesem
 *  Fenster starten, verbinden und seinen `ready`-Rahmen verarbeiten. */
const HALTEDAUER_MS = 9000;

async function schalterEinschalten(ctx: BrowserContext): Promise<void> {
  await ctx.route('**/krypto/schalter.ts*', async (route) => {
    const antwort = await route.fetch();
    const text = await antwort.text();
    const gepatcht = text.replace('E2E_DMS_ENABLED = false', 'E2E_DMS_ENABLED = true');
    if (gepatcht === text && !text.includes('E2E_DMS_ENABLED = true')) {
      throw new Error(`Weder "E2E_DMS_ENABLED = false" noch "= true" in schalter.ts gefunden`);
    }
    await route.fulfill({ response: antwort, body: gepatcht });
  });
}

async function register(page: Page, u: typeof ALICE): Promise<void> {
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

test('Web Locks gelten in dieser Umgebung ueber Tabs hinweg', async ({ context }) => {
  const a = await context.newPage();
  const b = await context.newPage();
  await a.goto('/login');
  await b.goto('/login');

  expect(await a.evaluate(() => typeof navigator.locks?.request)).toBe('function');

  // Beide Tabs nehmen DENSELBEN Namen, den die App benutzt. Tab A haelt ihn
  // 1,5 s; Tab B misst, wie lange es warten musste. Waere die Sperre
  // tab-lokal, kaeme B sofort dran.
  const gehalten = a.evaluate(
    () =>
      new Promise<void>((fertig) => {
        void navigator.locks.request(
          'pulse.krypto.konto',
          { mode: 'exclusive' },
          () =>
            new Promise<void>((freigeben) => {
              fertig();
              setTimeout(freigeben, 1500);
            })
        );
      })
  );
  await gehalten;

  const wartezeitMs = await b.evaluate(async () => {
    const start = performance.now();
    await navigator.locks.request('pulse.krypto.konto', { mode: 'exclusive' }, async () => {});
    return performance.now() - start;
  });

  // Grosszuegige Untergrenze — gemessen wird "hat gewartet", nicht "wie
  // genau". Ohne tab-uebergreifende Sperre laege der Wert bei ~0.
  expect(wartezeitMs).toBeGreaterThan(700);
});

test('zwei Tabs holen das Postfach nicht gleichzeitig ab', async ({ context }) => {
  await schalterEinschalten(context);
  await context.route('**/changelog.json', (route) => route.fulfill({ json: { entries: [] } }));

  const a = await context.newPage();
  // Tab A haelt seine Abholung — und damit die Konto-Sperre — offen.
  let aStart = 0;
  let aEnde = 0;
  await a.route('**/postfach/abholen', async (route) => {
    if (aStart === 0) {
      aStart = Date.now();
      await new Promise((r) => setTimeout(r, HALTEDAUER_MS));
      await route.continue();
      aEnde = Date.now();
      return;
    }
    await route.continue();
  });

  await register(a, ALICE);
  // Warten, bis A wirklich in der gehaltenen Abholung steht — sonst startet
  // B womoeglich vor A, und der Test misst nichts.
  await expect.poll(() => aStart, { timeout: 20_000 }).toBeGreaterThan(0);

  const b = await context.newPage();
  let bStart = 0;
  await b.route('**/postfach/abholen', async (route) => {
    if (bStart === 0) bStart = Date.now();
    await route.continue();
  });
  await b.goto('/app/@me');

  await expect.poll(() => bStart, { timeout: 30_000 }).toBeGreaterThan(0);
  await expect.poll(() => aEnde, { timeout: 30_000 }).toBeGreaterThan(0);

  // Die Gegenprobe im selben Test: hat A wirklich lange gehalten? Ohne diese
  // Zeile koennte die Behauptung darunter auch dann gruen sein, wenn gar
  // keine Ueberlappung moeglich war.
  expect(aEnde - aStart).toBeGreaterThan(HALTEDAUER_MS - 500);
  // Der eigentliche Punkt: B faengt erst an, nachdem A fertig ist.
  expect(bStart).toBeGreaterThanOrEqual(aEnde - 200);
});
