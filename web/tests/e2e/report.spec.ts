/**
 * Public abuse-report form (`/report`, no login).
 *
 * Two flows:
 *   - client-side validation blocks an empty submission,
 *   - a filled form POSTs to /reports (auth-svc) and shows the confirmation.
 *
 * The happy path needs the auth-svc reachable through the Vite proxy
 * (/api/auth → :8001); the validation case is pure frontend.
 */

import { test, expect } from '@playwright/test';

test.describe('public abuse report form', () => {
  test('blocks submission when the location is empty', async ({ page }) => {
    await page.goto('/report');
    await expect(page.getByTestId('report-form')).toBeVisible();

    // Body filled but no URL → client-side guard shows an error, no success.
    await page
      .getByTestId('report-body-input')
      .fill('Some clearly described abuse is happening here right now.');
    await page.getByTestId('report-submit').click();

    await expect(page.getByTestId('report-error')).toBeVisible();
    await expect(page.getByTestId('report-success')).toHaveCount(0);
  });

  test('submits a report and shows the confirmation', async ({ page }) => {
    await page.goto('/report');
    await page
      .getByTestId('report-url-input')
      .fill(`https://abuse-${Date.now()}.example.com/offending-post`);
    await page
      .getByTestId('report-body-input')
      .fill('This instance is hosting clearly illegal content that must be reviewed.');
    await page.getByTestId('report-submit').click();

    await expect(page.getByTestId('report-success')).toBeVisible({ timeout: 7_000 });
  });
});
