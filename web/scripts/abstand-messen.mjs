import { chromium } from '@playwright/test';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto('http://127.0.0.1:5173/login');
await page.getByTestId('login-identifier').fill('dev3');
await page.getByTestId('login-password').fill('test1234');
await page.waitForURL(/\/app/, { timeout: 60_000 });
await page.waitForTimeout(2000);
await page.locator('[data-testid^="dm-"]').first().click({ timeout: 15_000 });
await page.getByTestId('message-input').waitFor({ timeout: 20_000 });
const mess = await page.evaluate(() => {
  const fuss = document.querySelector('[data-testid=user-footer]')?.getBoundingClientRect();
  const f = document.querySelector('[data-testid=message-input]');
  const rahmen = f?.closest('.border')?.getBoundingClientRect();
  return {
    fenster: innerHeight,
    fuss: fuss && { oben: Math.round(fuss.top), untenLuecke: Math.round(innerHeight - fuss.bottom), h: Math.round(fuss.height) },
    composer: rahmen && { oben: Math.round(rahmen.top), untenLuecke: Math.round(innerHeight - rahmen.bottom), h: Math.round(rahmen.height) }
  };
});
console.log(JSON.stringify(mess, null, 1));
await browser.close();
