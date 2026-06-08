/**
 * E2E für den Zero-Knowledge Server-Vault (E2E-Sync der Self-Host-Server-Liste).
 *
 * Hybrid-Ansatz: echte Registrierung (setzt den `pulse_session`-Cookie + lädt
 * die Vite-Module), dann wird der ECHTE Vault per `page.evaluate` gegen das
 * ECHTE Backend (`/api/auth/server-vault`) und die ECHTE Krypto (Argon2id →
 * AES-256-GCM) getrieben — kein Netzwerk-Mock, kein Debounce-Timing.
 *
 * Beweis-Kette:
 *   1. Self-Host-Server lokal anlegen → unlock(pw) leitet Key ab + pusht.
 *   2. Der server-seitige Blob enthält den Hostname NICHT im Klartext (ZK).
 *   3. "Neues Gerät" simulieren: lokale Liste + IDB-Key wegwerfen.
 *   4. unlock(pw) leitet den Key erneut aus dem Passwort ab → Pull → Merge →
 *      der Self-Host-Server ist wieder da.
 *
 * Die Routes selbst sind zusätzlich in services/auth/tests/test_server_vault.py
 * abgedeckt; hier geht es um die Frontend-Integration (push/pull/merge/IDB).
 */

import { test, expect } from '@playwright/test';

const HOST = 'https://selfhost-vault.example.com';
const VAULT_PW = 'a-strong-vault-password-123';

test('server-vault: push → neues Gerät → pull stellt Self-Host-Server wieder her', async ({ page }) => {
  const ts = Date.now();
  const username = `vault_${ts}`;

  // --- Registrierung: gibt pulse_session-Cookie + lädt die App-Module --------
  await page.goto('/register');
  await page.getByTestId('reg-username').fill(username);
  await page.getByTestId('reg-email').fill(`${username}@dcc-test.example.com`);
  await page.getByTestId('reg-password').fill('sup3r-secret-pass');
  await page.getByTestId('reg-submit').click();
  await page.waitForURL(/\/app/);
  // Onboarding-Backup-Dialog wegklicken (blockiert sonst nichts hier, aber sauber).
  await page
    .locator('[data-testid=backup-onboarding-skip-btn]')
    .click({ timeout: 3000 })
    .catch(() => undefined);

  // --- Vault-Round-Trip im echten Page-Kontext -------------------------------
  const result = await page.evaluate(
    async ([host, pw]) => {
      // Runtime-Imports gegen den Vite-Dev-Server (kein TS-Module-Resolving →
      // String-Indirektion + @vite-ignore). serverVault + serversStore aus
      // DEMSELBEN Modul → garantiert dieselbe Store-Instanz wie der Vault intern.
      const importDev = (p: string) => import(/* @vite-ignore */ p);
      const { serverVault, serversStore } = await importDev(
        '/src/lib/identity/server-vault.svelte.ts'
      );
      const vaultApi = await importDev('/src/lib/api/server-vault.ts');

      serversStore.init();
      serversStore.add(host, 'Mein Self-Host', '99999');

      // (1) Sync aktivieren: Key ableiten (kein Tresor → frisches Salt) + pushen.
      await serverVault.unlockForSetup(pw);

      // (2) Zero-Knowledge: der server-seitige Blob darf den Hostname nicht im
      //     Klartext enthalten. Byte-genau prüfen (Ciphertext ist binär):
      //     die UTF-8-Bytes von 'selfhost-vault' dürfen nicht als Teilsequenz
      //     im entschlüsselten... nein: im CHIFFRETEXT vorkommen.
      const stored = await vaultApi.getServerVault();
      const needle = new TextEncoder().encode('selfhost-vault');
      const blobBytes = stored
        ? Uint8Array.from(atob(stored.encrypted_blob), (c) => c.charCodeAt(0))
        : new Uint8Array();
      let blobHasPlaintext = false;
      for (let i = 0; stored && i + needle.length <= blobBytes.length; i++) {
        let hit = true;
        for (let j = 0; j < needle.length; j++) {
          if (blobBytes[i + j] !== needle[j]) {
            hit = false;
            break;
          }
        }
        if (hit) {
          blobHasPlaintext = true;
          break;
        }
      }

      // (3) "Neues Gerät": lokale Liste + IDB-Key wegwerfen.
      for (const s of [...serversStore.servers]) {
        if (!s.isCloud) serversStore.remove(s.id);
      }
      await serverVault.wipe();
      const beforePull = serversStore.servers.some(
        (s: { hostname: string }) => s.hostname === host
      );

      // (4) Neues Gerät leitet den Key aus dem Passwort ab → Pull → Merge.
      await serverVault.unlockForRestore(pw);
      const restored = serversStore.servers.find(
        (s: { hostname: string; instance_id: string | null }) => s.hostname === host
      );

      return {
        hadVault: !!stored,
        blobHasPlaintext,
        beforePull,
        afterPull: !!restored,
        restoredInstanceId: restored?.instance_id ?? null,
      };
    },
    [HOST, VAULT_PW] as const
  );

  expect(result.hadVault).toBe(true); // Tresor wurde server-seitig angelegt
  expect(result.blobHasPlaintext).toBe(false); // Zero-Knowledge: Hostname nicht im Chiffretext
  expect(result.beforePull).toBe(false); // "neues Gerät" startet ohne den Server
  expect(result.afterPull).toBe(true); // Vault hat ihn wiederhergestellt
  expect(result.restoredInstanceId).toBe('99999'); // instance_id reiste mit
});

test('server-vault: Master-Passwort-Wechsel re-keyt den Tresor (kein Sync-Tod)', async ({ page }) => {
  const ts = Date.now();
  const username = `vault_rk_${ts}`;
  const HOST_RK = 'https://rekey-host.example.com';
  const PW_OLD = 'old-master-password-111';
  const PW_NEW = 'new-master-password-222';

  await page.goto('/register');
  await page.getByTestId('reg-username').fill(username);
  await page.getByTestId('reg-email').fill(`${username}@dcc-test.example.com`);
  await page.getByTestId('reg-password').fill('sup3r-secret-pass');
  await page.getByTestId('reg-submit').click();
  await page.waitForURL(/\/app/);
  await page
    .locator('[data-testid=backup-onboarding-skip-btn]')
    .click({ timeout: 3000 })
    .catch(() => undefined);

  const r = await page.evaluate(
    async ([host, pwOld, pwNew]) => {
      const importDev = (p: string) => import(/* @vite-ignore */ p);
      const { serverVault, serversStore } = await importDev(
        '/src/lib/identity/server-vault.svelte.ts'
      );

      serversStore.init();
      serversStore.add(host, 'Re-Key Host', '12321');

      // Setup mit ALTEM Passwort → Vault unter PW_OLD.
      await serverVault.unlockForSetup(pwOld);

      // Master-Passwort-UPDATE → unlockForSetup(PW_NEW) re-keyt (lokale Liste ist Wahrheit).
      await serverVault.unlockForSetup(pwNew);

      // "Neues Gerät": lokale Liste + IDB-Key weg.
      for (const s of [...serversStore.servers]) {
        if (!s.isCloud) serversStore.remove(s.id);
      }
      await serverVault.wipe();

      // ALTES Passwort darf NICHT mehr entschlüsseln (Re-Key hat den Key gewechselt).
      let oldPwRejected = false;
      try {
        await serverVault.unlockForRestore(pwOld);
      } catch {
        oldPwRejected = true;
      }
      const afterOldPw = serversStore.servers.some(
        (s: { hostname: string }) => s.hostname === host
      );

      // NEUES Passwort stellt wieder her.
      await serverVault.wipe();
      await serverVault.unlockForRestore(pwNew);
      const afterNewPw = serversStore.servers.some(
        (s: { hostname: string }) => s.hostname === host
      );

      return { oldPwRejected, afterOldPw, afterNewPw };
    },
    [HOST_RK, PW_OLD, PW_NEW] as const
  );

  expect(r.oldPwRejected).toBe(true); // alter Schlüssel ist nach Re-Key ungültig
  expect(r.afterOldPw).toBe(false); // mit altem Passwort kommt der Server nicht zurück
  expect(r.afterNewPw).toBe(true); // mit neuem Passwort schon → Re-Key hat funktioniert
});

test('backup-setup UI: non-extractable Keypair wird upgegradet → Backup + Vault entstehen', async ({
  page,
}) => {
  const ts = Date.now();
  const username = `vault_ui_${ts}`;
  const PW = 'master-pass-secure-123';

  await page.goto('/register');
  await page.getByTestId('reg-username').fill(username);
  await page.getByTestId('reg-email').fill(`${username}@dcc-test.example.com`);
  await page.getByTestId('reg-password').fill('sup3r-secret-pass');
  await page.getByTestId('reg-submit').click();
  await page.waitForURL(/\/app/);

  // Onboarding-Backup-Dialog → echtes UI durchklicken (treibt ensureBackupCapableKeypair).
  await expect(page.getByTestId('backup-onboarding-setup-btn')).toBeVisible({ timeout: 12000 });
  await page.getByTestId('backup-onboarding-setup-btn').click();
  // Setup-Form startet im Generator-Modus; für den eigenen-Passwort-Pfad
  // erst auf "Eigenes Passwort" umschalten, dann die Felder ausfüllen.
  await page.getByTestId('backup-mode-own').click();
  await page.getByTestId('backup-password-input').fill(PW);
  await page.getByTestId('backup-password-confirm-input').fill(PW);
  await page.getByTestId('backup-confirm-btn').click();

  // Kein "nicht exportierbar"-Fehler mehr; Dialog schließt bei Erfolg.
  await expect(page.getByTestId('backup-error')).toHaveCount(0);
  await expect(page.getByTestId('backup-onboarding-dialog')).toBeHidden({ timeout: 20000 });

  const r = await page.evaluate(async () => {
    const importDev = (p: string) => import(/* @vite-ignore */ p);
    const kp = await importDev('/src/lib/identity/keypair.svelte.ts');
    const cred = await importDev('/src/lib/api/credentials.ts');
    const vaultApi = await importDev('/src/lib/api/server-vault.ts');
    const keypair = await kp.loadKeypair();
    const list = await cred.listCerts();
    const vault = await vaultApi.getServerVault();
    return {
      extractable: !!keypair?.privateKey?.extractable,
      hasBackup: list.devices.some((d: { has_backup: boolean }) => d.has_backup),
      hasVault: !!vault,
    };
  });

  expect(r.extractable).toBe(true); // Keypair ist jetzt backup-fähig (Fix wirkt)
  expect(r.hasBackup).toBe(true); // Cloud-Key-Backup wurde angelegt
  expect(r.hasVault).toBe(true); // Server-Vault wurde mit-angelegt (unlockForSetup)
});
