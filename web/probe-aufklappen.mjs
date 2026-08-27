import { chromium } from '@playwright/test';
const ORT = '/tmp/claude-1000/-home-michael-Dokumente-Pulse/90e80062-86e5-4334-9ab7-eef68ee44727/scratchpad';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const fehler = [];
page.on('pageerror', (e) => fehler.push(String(e)));

await page.goto('http://127.0.0.1:5173/login');
await page.getByTestId('login-email').fill('zzprobe@dcc-test.example.com');
await page.getByTestId('login-password').fill('Passwort123!');
await page.getByTestId('login-submit').click();
await page.waitForURL(/\/app/);
await page.locator('[data-testid=backup-onboarding-skip-btn]').click({ timeout: 3000 }).catch(() => {});

await page.goto('http://127.0.0.1:5173/app/server');
await page.getByTestId('self-host-panel').waitFor();
await page.waitForTimeout(800);
await page.screenshot({ path: `${ORT}/6-zugeklappt.png` });

const knopf = page.locator('[data-testid^="instance-setup-btn-"]').first();
console.log('Einrichten-Knopf da:', await knopf.count());
console.log('aria-expanded vorher:', await knopf.getAttribute('aria-expanded'));
await knopf.click();
await page.getByTestId('instance-setup-panel').waitFor();
await page.waitForTimeout(1200);
console.log('aria-expanded nachher:', await knopf.getAttribute('aria-expanded'));
console.log('Dialog-Overlay vorhanden:', await page.locator('[data-dialog-overlay]').count());
await page.screenshot({ path: `${ORT}/7-aufgeklappt.png`, fullPage: true });

await knopf.click();
await page.waitForTimeout(400);
console.log('nach zweitem Klick noch offen:', await page.getByTestId('instance-setup-panel').count());
console.log('JS-Fehler:', fehler.length ? fehler.slice(0, 3) : 'keine');
await browser.close();
