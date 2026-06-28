<script lang="ts">
  /**
   * Recover-Page — Auto-Trigger nach Login auf einem Gerät ohne lokalen
   * Keypair, wenn ein Cloud-Backup existiert.
   *
   * Eintritt: login/register-Page leitet hierher um, wenn runIssueFlow
   * eine RecoveryAvailableError wirft. Query-Params:
   *   - cert_id: das auf dem Server liegende Backup-Cert
   *   - device_label: hübscher Name für die Anzeige
   *
   * Pfade:
   *   1. Wiederherstellen → Master-Passwort → fetch Backup → decrypt →
   *      saveKeypair(originalKeypair) → IDB-Reset des alten (jetzt
   *      auto-generierten) Keypairs → reload runIssueFlow + goto /app.
   *   2. Als neues Gerät weiter → declineRecovery() + reload runIssueFlow
   *      (welches diesmal neuen Keypair generiert) + goto /app.
   *   3. Abmelden → signOut + goto /login.
   */
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { auth } from '$lib/stores/auth.svelte';
  import { getBackup, createBackup, reconstructBlob } from '$lib/api/credentials';
  import {
    keyBackupState,
    BackupDecryptError,
    decryptKeypairWithAk,
    encryptKeypairWithAk
  } from '$lib/identity/key-backup.svelte';
  import { accountKey, AccountKeyDecryptError } from '$lib/identity/account-key.svelte';
  import { saveKeypair, keypairStore } from '$lib/identity/keypair.svelte';
  import {
    runIssueFlow,
    declineRecovery,
    resetRecoveryDecline,
  } from '$lib/identity/issue-flow';
  import { startProfileRefresh } from '$lib/identity/profile-refresh.svelte';
  import { startCertRotation } from '$lib/identity/cert-rotation.svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import { toast } from 'svelte-sonner';
  import { m } from '$lib/paraglide/messages.js';

  let password = $state('');
  let busy = $state(false);
  let errorMsg = $state<string | null>(null);

  const certId = $derived(page.url.searchParams.get('cert_id') ?? '');
  const deviceLabel = $derived(page.url.searchParams.get('device_label') ?? m.recover_default_device_label());

  onMount(() => {
    if (!auth.isAuthenticated) {
      void goto('/login', { replaceState: true });
      return;
    }
    if (!certId) {
      void goto('/app', { replaceState: true });
      return;
    }
  });

  async function restart() {
    void runIssueFlow()
      .then(() => {
        if (auth.isAuthenticated) {
          void startProfileRefresh();
          void startCertRotation();
        }
      })
      .catch((err: unknown) => {
        console.warn('[recover] issue-flow nach restart fehlgeschlagen:', err);
      });
    await goto('/app', { replaceState: true });
  }

  async function handleRecover(e: Event) {
    e.preventDefault();
    if (busy || !certId) return;
    if (password.length < 12) {
      errorMsg = m.recover_error_password_too_short();
      return;
    }
    busy = true;
    errorMsg = null;
    try {
      const resp = await getBackup(certId);
      if (!resp) {
        errorMsg = m.recover_error_backup_unavailable();
        return;
      }
      const blob = reconstructBlob(resp);
      // v3 = Account-Key-verschlüsselt → erst AK mit dem Passwort entsperren;
      // Legacy (v1/v2) → direkt mit dem Passwort entschlüsseln.
      const keypair =
        blob.v === 3
          ? await decryptKeypairWithAk(blob, await accountKey.unlock(password))
          : await keyBackupState.decrypt(blob, password);
      const [privateKey, publicKey] = await Promise.all([
        crypto.subtle.importKey('jwk', keypair.privateKey, { name: 'Ed25519' }, true, ['sign']),
        crypto.subtle.importKey('jwk', keypair.publicKey, { name: 'Ed25519' }, true, ['verify']),
      ]);
      await saveKeypair({ type: 'webcrypto', privateKey, publicKey });
      await keypairStore.load();
      // Legacy-Backup nach erfolgreichem Entsperren aufs Account-Key-Modell
      // migrieren (AK ggf. erzeugen + Blob als v3 re-verschlüsseln). Best-effort.
      if (blob.v !== 3) {
        try {
          let ak: CryptoKey;
          try {
            ak = await accountKey.unlock(password);
          } catch (err) {
            if (err instanceof AccountKeyDecryptError) throw err; // AK existiert mit ANDEREM Passwort → nicht anfassen
            ak = await accountKey.create(password);
          }
          const v3 = await encryptKeypairWithAk(keypair.privateKey, keypair.publicKey, ak);
          await createBackup(certId, v3, deviceLabel.slice(0, 64) || 'Backup');
        } catch {
          /* Migration best-effort — Legacy-Blob bleibt gültig */
        }
      }
      resetRecoveryDecline();
      toast.success(m.recover_toast_success_title(), {
        description: m.recover_toast_success_description(),
      });
      await restart();
    } catch (err) {
      if (err instanceof BackupDecryptError || err instanceof AccountKeyDecryptError) {
        errorMsg = m.recover_error_wrong_password();
      } else {
        errorMsg = err instanceof Error ? err.message : m.recover_error_unknown();
      }
    } finally {
      busy = false;
    }
  }

  async function handleDecline() {
    declineRecovery();
    await restart();
  }

  async function handleSignOut() {
    auth.signOut();
    await goto('/login', { replaceState: true });
  }
</script>

<svelte:head>
  <title>{m.recover_page_title()}</title>
</svelte:head>

<div class="flex min-h-dvh items-center justify-center p-6">
  <section
    class="border-border bg-bg-input/40 w-full max-w-md rounded-2xl border p-6 shadow-lg"
    data-testid="recover-page"
  >
    <h1 class="text-text-bright text-xl font-semibold">{m.recover_heading()}</h1>
    <p class="text-text-muted mt-2 text-sm">
      {m.recover_description_before_device()}<span class="text-text-bright font-medium">{deviceLabel}</span>{m.recover_description_after_device()}
    </p>

    <form class="mt-5 flex flex-col gap-3" onsubmit={handleRecover}>
      <div class="flex flex-col gap-2">
        <Label for="recover-password">{m.recover_label_master_password()}</Label>
        <Input
          id="recover-password"
          type="password"
          bind:value={password}
          autocomplete="current-password"
          placeholder={m.recover_placeholder_password()}
          disabled={busy}
          data-testid="recover-password-input"
        />
      </div>

      {#if errorMsg}
        <p class="text-destructive text-sm" data-testid="recover-error">{errorMsg}</p>
      {/if}

      <Button type="submit" disabled={busy || password.length < 12} data-testid="recover-submit-btn">
        {busy ? m.recover_btn_recovering() : m.recover_btn_restore()}
      </Button>
    </form>

    <div class="border-border mt-6 border-t pt-4 text-sm">
      <p class="text-text-muted">
        {m.recover_hint_forgot_password()}
      </p>
      <div class="mt-3 flex flex-col gap-2 sm:flex-row">
        <Button
          variant="ghost"
          onclick={handleDecline}
          disabled={busy}
          data-testid="recover-decline-btn"
        >
          {m.recover_btn_continue_as_new_device()}
        </Button>
        <Button
          variant="ghost"
          onclick={handleSignOut}
          disabled={busy}
          data-testid="recover-signout-btn"
        >
          {m.recover_btn_sign_out()}
        </Button>
      </div>
    </div>
  </section>
</div>
