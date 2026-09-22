/**
 * T15 — Wiederherstellungs-Code + Passkeys + Login-Groß/Kleinschreibung.
 *
 * Wiederherstellung (echter Weg über die Oberfläche):
 *   Besitzer registriert → Community + Ablage-Kanal → Laufwerk verbinden
 *   (erzeugt die GERADE-lokale Ablage-Verbindung, die es zurückzubringen
 *   gilt) → Einstellungen → Speicher: Wiederherstellungs-Block → Erzeugen
 *   fragt inline das Konto-Passwort ab (zweiter Klick führt aus) → Code
 *   EINMALIG sichtbar (Bestätigung durch Abtippen der dritten Gruppe) →
 *   Stand zeigt „Zuletzt erneuert am …" → frischer Context (neues Gerät,
 *   keine lokalen Verbindungen): Code einlösen → Toast meldet die
 *   zurückgekehrten Verbindungen, die Zeile erscheint → ohne Passwort-
 *   Beweis nimmt der Server das Päckchen nicht an (401) → Löschen mit
 *   Passwort → Stand ist wieder weg.
 *
 * Passkeys: die Browser-Zeremonie lässt sich in CI nicht stellen — genau
 * wie in `passkeys.spec.ts` wird der Netzweg (/webauthn/*) gemockt und
 * `navigator.credentials.create` gefälscht; Hinzufügen → Zeile erscheint,
 * Löschen (mit Passwortfeld) → Zeile weg.
 *
 * Login: Konten sind case-insensitive — „MixedCase" registriert, „mixedcase"
 * meldet sich an.
 */

import { test, expect, type Page } from '@playwright/test';

const ts = Date.now();
const PASSWORD = 'Recover!2026pass';
const OWNER = {
  username: `ovn_recover_owner_${ts}`,
  email: `ovn_recover_owner_${ts}@dcc-test.example.com`,
  password: PASSWORD
};
const PASSKEY_USER = `ovn_pk_${ts}`;
const CASE_USER = `MixedCase_${ts}`;

// Basis64url-Helfer für die gemockten WebAuthn-Options (im Browser laufen
// die decode-Helper, hier reicht Node-Base64 ohne „+/=").
function b64url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

async function register(page: Page, username: string, password: string = PASSWORD) {
  await page.goto('/register');
  await page.getByTestId('reg-username').fill(username);
  await page.getByTestId('reg-email').fill(`${username.toLowerCase()}@dcc-test.example.com`);
  await page.getByTestId('reg-password').fill(password);
  await page.getByTestId('reg-submit').click();
  await page.waitForURL(/\/app/);
  await page
    .locator('[data-testid=backup-onboarding-skip-btn]')
    .click({ timeout: 2500 })
    .catch(() => undefined);
}

async function login(page: Page, identifier: string, password: string = PASSWORD) {
  await page.goto('/login');
  await page.getByTestId('login-identifier').fill(identifier);
  await page.getByTestId('login-password').fill(password);
  await page.getByTestId('login-submit').click();
  await page.waitForURL(/\/app/);
  await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 15_000 });
}

/**
 * Einstellungen → Speicher-Reiter öffnen (Wiederherstellungs-Block lebt
 * dort). Gibt false zurück, wenn der Reiter in diesem Build versteckt ist —
 * `settingsTabs.ts` hat „storage" auskommentiert („bleibt versteckt, bis sie
 * freigegeben wird"); der Block samt UI-Flüssen ist dann unerreichbar und
 * die zugehörigen Tests skippen mit Verweis auf diese Stelle.
 */
async function oeffneSpeicherEinstellungen(page: Page): Promise<boolean> {
  await page.getByTestId('user-footer-trigger').click();
  await page.getByTestId('open-settings').click();
  await expect(page.getByTestId('settings-dialog')).toBeVisible();
  const tab = page.getByTestId('settings-tab-storage');
  if ((await tab.count()) === 0) {
    await page.keyboard.press('Escape');
    return false;
  }
  await tab.click();
  await expect(page.getByTestId('wiederherstellung-block')).toBeVisible();
  return true;
}

/** Einstellungen → Sicherheit-Reiter (Passkey-Sektion). */
async function oeffneSicherheitseinstellungen(page: Page) {
  await page.getByTestId('user-footer-trigger').click();
  await page.getByTestId('open-settings').click();
  await expect(page.getByTestId('settings-dialog')).toBeVisible();
  await page.getByTestId('settings-tab-security').click();
  await expect(page.getByTestId('passkeys-section')).toBeVisible();
}

test.describe.serial('T15 — Wiederherstellung', () => {
  test.setTimeout(180_000);

  let page: Page;
  let recoveryCode = '';

  test.beforeAll(async ({ browser }) => {
    page = await (await browser.newContext()).newPage();
  });

  test.afterAll(async () => {
    await page?.context().close();
  });

  test('Setup: Konto + Ablage-Verbindung erzeugen', async () => {
    await register(page, OWNER.username);

    // Community + Ablage-Kanal + Laufwerk verbinden — die lokale Verbindung
    // (Schlüssel liegt auf diesem Gerät) ist der Päckchen-Inhalt.
    const gid = await page.evaluate(async (guildName) => {
      const token = localStorage.getItem('dcc.tokens.access');
      const r = await fetch('/api/chat/guilds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: guildName })
      });
      const body = await r.json();
      if (!r.ok) throw new Error(`guild create failed: ${r.status}`);
      return body.id as string;
    }, `Recover Guild ${ts}`);

    await page.goto(`/app/rooms/${gid}`);
    await page.getByTestId('channel-create').click();
    await expect(page.getByTestId('create-channel-dialog')).toBeVisible();
    await page.waitForTimeout(800);
    await page.getByTestId('create-channel-type-dropbox').click();
    await page.getByTestId('create-channel-name').fill('Ablage');
    await page.getByTestId('create-channel-submit').click();
    await page.waitForURL(/\/app\/guilds\/\d+\/channels\/\d+/);

    await page.getByTestId('community-ablage-verbinden').click();
    await page.getByTestId('anbieter-pulse').click();
    await page.getByTestId('pulse-verbinden').click();
    await expect(page.getByTestId('community-ablage-ansicht')).toBeVisible({ timeout: 10_000 });
  });

  test('Erzeugen fragt Passwort ab und zeigt den Code EINMAL', async () => {
    const sichtbar = await oeffneSpeicherEinstellungen(page);
    test.skip(
      !sichtbar,
      'Reiter „Speicher" ist in diesem Build versteckt (settingsTabs.ts: storage auskommentiert) — der Wiederherstellungs-Block ist damit unerreichbar. API-Deckung läuft in den Nachbar-Tests.'
    );

    const block = page.getByTestId('wiederherstellung-block');
    // Noch kein Päckchen → kein „Stand"
    await expect(block.getByTestId('wiederherstellung-stand')).toHaveCount(0);

    // Erster Tap: nur das Passwortfeld erscheint
    await page.getByTestId('wiederherstellung-erzeugen-knopf').click();
    const pw = page.getByTestId('wiederherstellung-passwort');
    await expect(pw).toBeVisible();
    // Ohne Passwort geht es nicht weiter
    await page.getByTestId('wiederherstellung-erzeugen-knopf').click();
    await expect(page.getByText(mNoetig())).toBeVisible();

    // Mit Passwort: Code-Anzeige-Dialog
    await pw.fill(PASSWORD);
    await page.getByTestId('wiederherstellung-erzeugen-knopf').click();
    const codeWert = page.getByTestId('wiederherstellung-code-wert');
    await expect(codeWert).toBeVisible({ timeout: 10_000 });
    recoveryCode = (await codeWert.textContent())!.trim();

    // Bestätigung: dritte Gruppe (Index 2) abtippen
    const gruppe3 = recoveryCode.split(/[\s-]+/)[2];
    await page.getByTestId('wiederherstellung-bestaetigung-eingabe').fill(gruppe3);
    await page.getByTestId('wiederherstellung-code-fertig').click();

    // Stand zeigt „vorhanden"
    await expect(page.getByTestId('wiederherstellung-stand')).toContainText(
      'Zuletzt erneuert am',
      { timeout: 7_000 }
    );
  });

  test('Päckchen liegt serverseitig (GET 200)', async () => {
    // Wenn der UI-Weg skippte, steht kein Päckchen da — dann eines per API
    // ablegen (der Server sieht nur undurchsichtiges Base64), damit GET,
    // Einlösen-Fehlweg und DELETE weiter real bleiben.
    if (!recoveryCode) {
      const put = await page.evaluate(
        async (passwort) => {
          const token = localStorage.getItem('dcc.tokens.access');
          return (
            await fetch('/api/auth/me/recovery-package', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
              body: JSON.stringify({ ciphertext: 'ZmVpbkVlMnRFMnN0', password: passwort })
            })
          ).status;
        },
        PASSWORD
      );
      expect(put).toBe(200);
    }
    const r = await page.evaluate(async () => {
      const token = localStorage.getItem('dcc.tokens.access');
      const resp = await fetch('/api/auth/me/recovery-package', {
        headers: { Authorization: `Bearer ${token}` }
      });
      return resp.status;
    });
    expect(r).toBe(200);
  });

  test('Ohne Passwort-Beweis → 401', async () => {
    const status = await page.evaluate(async () => {
      const token = localStorage.getItem('dcc.tokens.access');
      const resp = await fetch('/api/auth/me/recovery-package', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ ciphertext: 'Zm9v', password: 'falsches-passwort' })
      });
      return resp.status;
    });
    expect(status).toBe(401);
  });

  test('Einlösen am neuen Gerät bringt die Verbindungen zurück', async ({ browser }) => {
    test.skip(
      !recoveryCode,
      'setzt den Erzeugen-UI-Durchlauf voraus, der ohne sichtbaren Speicher-Reiter skippt'
    );
    const neuCtx = await browser.newContext();
    const neu = await neuCtx.newPage();
    await login(neu, OWNER.username);

    // Frisches Gerät: keine lokale Verbindung
    await oeffneSpeicherEinstellungen(neu);
    await expect(neu.getByTestId('speicher-zeile')).toHaveCount(0);

    await neu.getByTestId('wiederherstellung-einloesen-knopf').click();
    const dialog = neu.getByTestId('wiederherstellung-einloesen-dialog');
    await expect(dialog).toBeVisible();
    await neu.getByTestId('wiederherstellung-einloesen-eingabe').fill(recoveryCode);
    await neu.getByTestId('wiederherstellung-einloesen-submit').click();

    // Erfolgsmeldung + die Ablage-Verbindung ist zurück
    await expect(
      neu.getByText(/1 Verbindung\(en\) wiederhergestellt\./)
    ).toBeVisible({ timeout: 15_000 });
    await expect(neu.getByTestId('speicher-zeile').first()).toBeVisible();

    await neuCtx.close();
  });

  test('Falscher Code → verständliche Fehlermeldung', async ({ browser }) => {
    test.skip(
      !recoveryCode,
      'setzt den Erzeugen-UI-Durchlauf voraus, der ohne sichtbaren Speicher-Reiter skippt'
    );
    const neuCtx = await browser.newContext();
    const neu = await neuCtx.newPage();
    await login(neu, OWNER.username);

    await oeffneSpeicherEinstellungen(neu);
    await neu.getByTestId('wiederherstellung-einloesen-knopf').click();
    await neu.getByTestId('wiederherstellung-einloesen-eingabe').fill('AAAA-BBBB-CCCC-DDDD-EEEE');
    await neu.getByTestId('wiederherstellung-einloesen-submit').click();
    await expect(neu.getByTestId('wiederherstellung-einloesen-fehler')).toBeVisible({
      timeout: 10_000
    });

    await neuCtx.close();
  });

  test('Löschen mit Passwort → Stand zeigt wieder „keins"', async () => {
    // Falsches Passwort: Widerruf abgelehnt
    const falsch = await page.evaluate(async () => {
      const token = localStorage.getItem('dcc.tokens.access');
      return (
        await fetch('/api/auth/me/recovery-package', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ password: 'falsches-passwort' })
        })
      ).status;
    });
    expect(falsch).toBe(401);

    // Richtiges Passwort: Päckchen weg, Stand-Verschwinden nach Neuladen
    const ok = await page.evaluate(async (passwort) => {
      const token = localStorage.getItem('dcc.tokens.access');
      return (
        await fetch('/api/auth/me/recovery-package', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ password: passwort })
        })
      ).status;
    }, PASSWORD);
    expect(ok).toBe(204);

    const status = await page.evaluate(async () => {
      const token = localStorage.getItem('dcc.tokens.access');
      return (
        await fetch('/api/auth/me/recovery-package', {
          headers: { Authorization: `Bearer ${token}` }
        })
      ).status;
    });
    expect(status).toBe(404);

    // Wenn der Speicher-Reiter da ist, ist auch der „Stand" weg
    if (await oeffneSpeicherEinstellungen(page)) {
      await expect(page.getByTestId('wiederherstellung-stand')).toHaveCount(0);
      await page.keyboard.press('Escape');
    }
  });
});

/** Toast-Text für den fehlenden Passwort-Beweis (aus den Paraglide-Messages). */
function mNoetig(): string {
  return 'Bitte Konto-Passwort eingeben — der Server nimmt das Wiederherstellungs-Päckchen nur gegen den Passwort-Beweis ab.';
}

test.describe.serial('T15 — Passkeys (gemockte Zeremonie)', () => {
  test.setTimeout(120_000);

  let page: Page;
  const CRED_ID = 'e2e-passkey-id-1';

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext();
    page = await ctx.newPage();
  });

  test.afterAll(async () => {
    await page?.context().close();
  });

  test('Registrieren + Sicherheits-Reiter öffnen (Zeremonie-Mocks scharf)', async () => {
    // navigator.credentials.create fälschen — die encode-Seite braucht nur
    // id/rawId/clientDataJSON/attestationObject (Route-Mock verifiziert eh
    // nichts). Init-Script + Routen an der PAGE hängen, damit sie garantiert
    // vor der ersten Navigation scharf sind.
    await page.addInitScript(() => {
      const fake = {
        id: 'e2e-passkey-id-1',
        rawId: new TextEncoder().encode('e2e-passkey-id-1').buffer,
        type: 'public-key',
        authenticatorAttachment: 'platform',
        getClientExtensionResults: () => ({}),
        response: {
          clientDataJSON: new TextEncoder().encode('{"type":"webauthn.create"}').buffer,
          attestationObject: new TextEncoder().encode('o2NmbXQ').buffer,
          getTransports: () => ['internal']
        }
      };
      navigator.credentials.create = async () => fake;
      navigator.credentials.get = async () => fake;
    });

    await page.route('**/api/auth/webauthn/register/options', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          options: {
            rp: { name: 'Pulse' },
            user: { id: b64url('e2e-user'), name: 'e2e', displayName: 'e2e' },
            challenge: b64url('e2e-challenge'),
            pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
            timeout: 60_000,
            attestation: 'none'
          },
          challenge_ticket: 'e2e-ticket'
        })
      });
    });
    await page.route('**/api/auth/webauthn/register/verify', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          credential: {
            id: CRED_ID,
            name: 'E2E Touch ID',
            aaguid: null,
            transports: ['internal'],
            created_at: new Date().toISOString(),
            last_used_at: null
          },
          backup_codes: null
        })
      });
    });
    await page.route('**/api/auth/webauthn/credentials', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([])
        });
        return;
      }
      await route.continue();
    });
    await page.route(`**/api/auth/webauthn/credentials/${CRED_ID}`, async (route) => {
      if (route.request().method() === 'DELETE') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ detail: 'ok' })
        });
        return;
      }
      await route.continue();
    });

    await register(page, PASSKEY_USER);
    await oeffneSicherheitseinstellungen(page);
  });

  test.afterAll(async () => {
    await page?.context().close();
  });

  test('Passkey hinzufügen → Zeile erscheint → löschen → Zeile weg', async () => {
    await page.getByTestId('passkeys-add').click();
    const dialog = page.getByTestId('passkey-add-dialog');
    await expect(dialog).toBeVisible();
    await page.getByTestId('passkey-name-input').fill('E2E Touch ID');
    await page.getByTestId('passkey-password-input').fill(PASSWORD);
    await page.getByTestId('passkey-create').click();

    await expect(page.getByTestId('passkey-row')).toHaveCount(1, { timeout: 10_000 });
    await expect(page.getByTestId('passkey-row').first()).toContainText('E2E Touch ID');
    // Der Wizard schließt sich selbst (keine Backup-Codes → kein Codes-Schritt).
    try {
      await expect(dialog).toBeHidden({ timeout: 10_000 });
    } catch (e) {
      const errText = await page
        .getByTestId('passkey-add-error')
        .textContent()
        .catch(() => null);
      throw new Error(`Add-Dialog blieb offen. Fehlermeldung im Dialog: ${errText ?? '(keine)'}`);
    }

    // Löschen: Zwei-Tipp-Freigabe + Passwortpflicht; letzter Passkey ohne
    // TOTP verlangt zusätzlich einen Backup-Code (Runde 34) — der Route-Mock
    // nimmt den Code ohnehin ohne Prüfung.
    const row = page.getByTestId('passkey-row').first();
    await row.getByTestId('passkey-delete').click();
    await row.getByTestId('passkey-delete-password').fill(PASSWORD);
    const backup = row.getByTestId('passkey-delete-backup-code');
    if (await backup.isVisible()) await backup.fill('E2E-BACKUP-CODE');
    await row.getByTestId('passkey-delete-confirm').click();
    await expect(page.getByTestId('passkey-row')).toHaveCount(0, { timeout: 10_000 });
  });
});

test('Login ignoriert Groß-/Kleinschreibung', async ({ browser }) => {
  test.setTimeout(120_000);
  const regCtx = await browser.newContext();
  const reg = await regCtx.newPage();
  await register(reg, CASE_USER);
  await regCtx.close();

  // Frischer Context: echter Login, kein bereits angemeldetes Fenster
  const loginCtx = await browser.newContext();
  const p = await loginCtx.newPage();
  await login(p, CASE_USER.toLowerCase());
  await loginCtx.close();
});
