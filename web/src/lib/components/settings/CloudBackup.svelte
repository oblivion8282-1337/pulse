<script lang="ts">
  /**
   * Cloud-Backup — verschlüsselt das lokale Ed25519-Keypair mit einem
   * Master-Passwort und speichert den Blob server-seitig (Block 2.C).
   *
   * States: idle → setup/recover → (async) → idle
   * Master-Passwort wird NIEMALS persistiert oder geloggt.
   */
  import { onMount } from 'svelte';
  import { toast } from 'svelte-sonner';
  import LoaderIcon from '@lucide/svelte/icons/loader-circle';
  import CloudIcon from '@lucide/svelte/icons/cloud';
  import { certStore } from '$lib/identity/cert.svelte';
  import { loadKeypair, saveKeypair, keypairStore } from '$lib/identity/keypair.svelte';
  import { keyBackupState, BackupDecryptError } from '$lib/identity/key-backup.svelte';
  import { createBackup, getBackup, deleteBackup, reconstructBlob } from '$lib/api/credentials';
  import type { BackupFetchResponse } from '$lib/api/credentials';
  import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import CloudBackupSetupForm from './CloudBackupSetupForm.svelte';
  import CloudBackupRecoverForm from './CloudBackupRecoverForm.svelte';
  import { m } from '$lib/paraglide/messages.js';

  type ViewState = 'idle' | 'setup' | 'recover';

  let viewState = $state<ViewState>('idle');
  let existingBackup = $state<BackupFetchResponse | null>(null);
  let loadingStatus = $state(true);
  let errorMsg = $state<string | null>(null);
  let busy = $state(false);
  let deleteDialogOpen = $state(false);

  const certId = $derived(certStore.cert?.claims.cert_id ?? null);
  const hasBackup = $derived(existingBackup !== null);
  const hasLocalKeypair = $derived(keypairStore.keypair !== null);
  const backupDateLabel = $derived.by(() => {
    if (!existingBackup) return '';
    try { return new Intl.DateTimeFormat('de-DE', { dateStyle: 'long' }).format(new Date(existingBackup.created_at)); }
    catch { return existingBackup.created_at; }
  });

  onMount(async () => {
    if (!certId) { loadingStatus = false; return; }
    try { existingBackup = await getBackup(certId); }
    catch { existingBackup = null; }
    finally { loadingStatus = false; }
  });

  function setView(v: ViewState) { errorMsg = null; viewState = v; }
  const openSetup = () => setView('setup');
  const openRecover = () => setView('recover');
  const cancelFlow = () => setView('idle');

  async function handleSetup(password: string) {
    if (!certId) return;
    errorMsg = null;
    busy = true;
    try {
      const keypair = await loadKeypair();
      if (!keypair) {
        errorMsg = m.cloud_backup_error_no_keypair();
        return;
      }
      if (!keypair.privateKey.extractable) {
        errorMsg = m.cloud_backup_error_keypair_not_extractable();
        return;
      }

      const [privateKeyJwk, publicKeyJwk] = await Promise.all([
        crypto.subtle.exportKey('jwk', keypair.privateKey),
        crypto.subtle.exportKey('jwk', keypair.publicKey)
      ]);

      const blob = await keyBackupState.encrypt(privateKeyJwk, publicKeyJwk, password);
      const deviceLabel = certStore.cert?.claims.device_label ?? 'Unbekanntes Gerät';
      await createBackup(certId, blob, deviceLabel.slice(0, 64) || 'Backup');
      existingBackup = await getBackup(certId);

      toast.success(m.cloud_backup_toast_saved(), {
        description: m.cloud_backup_toast_saved_desc()
      });
      cancelFlow();
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : m.cloud_backup_error_unknown_backup();
    } finally {
      busy = false;
    }
  }

  async function handleRecover(password: string) {
    if (!certId || !existingBackup) return;
    errorMsg = null;
    busy = true;
    try {
      const blob = reconstructBlob(existingBackup);
      const keypair = await keyBackupState.decrypt(blob, password);

      const [privateKey, publicKey] = await Promise.all([
        crypto.subtle.importKey('jwk', keypair.privateKey, { name: 'Ed25519' }, true, ['sign']),
        crypto.subtle.importKey('jwk', keypair.publicKey, { name: 'Ed25519' }, true, ['verify'])
      ]);
      await saveKeypair({ type: 'webcrypto', privateKey, publicKey });
      await keypairStore.load();

      toast.success(m.cloud_backup_toast_recovered(), {
        description: m.cloud_backup_toast_recovered_desc()
      });
      cancelFlow();
    } catch (err) {
      if (err instanceof BackupDecryptError) {
        errorMsg = m.cloud_backup_error_wrong_password();
      } else {
        errorMsg = err instanceof Error ? err.message : m.cloud_backup_error_unknown_recover();
      }
    } finally {
      busy = false;
    }
  }

  async function handleDelete() {
    if (!certId) return;
    deleteDialogOpen = false;
    busy = true;
    try {
      await deleteBackup(certId);
      existingBackup = null;
      toast.success(m.cloud_backup_toast_deleted());
    } catch (err) {
      toast.error(m.cloud_backup_toast_delete_failed(), { description: (err as Error).message });
    } finally {
      busy = false;
    }
  }
</script>

<section
  class="border-border bg-bg-input/40 flex flex-col gap-3 rounded-2xl border p-4"
  data-testid="cloud-backup-section"
>
  <div class="flex items-start gap-3">
    <span class="bg-bg-input text-text-muted flex size-9 shrink-0 items-center justify-center rounded-full">
      <CloudIcon class="size-5" />
    </span>
    <div class="flex flex-col gap-0.5">
      <span class="text-text-bright text-sm font-medium">{m.cloud_backup_title()}</span>
      <span class="text-text-muted text-xs">
        {m.cloud_backup_subtitle()}
      </span>
    </div>
  </div>

  {#if !certId}
    <p class="text-text-muted text-xs">{m.cloud_backup_no_cert()}</p>
  {:else if loadingStatus}
    <div class="text-text-muted flex items-center gap-2 text-xs">
      <LoaderIcon class="size-4 animate-spin" />
      <span>{m.cloud_backup_loading()}</span>
    </div>
  {:else if viewState === 'idle'}
    {#if hasBackup}
      <p class="text-text-muted text-xs">
        {m.cloud_backup_existing_info({ date: backupDateLabel, device: existingBackup!.device_label })}
      </p>
      <div class="flex flex-wrap gap-2">
        <button
          type="button"
          onclick={openSetup}
          class="bg-bg-input text-text-base hover:bg-bg-hover rounded-md px-3 py-2 text-xs font-medium transition-colors md:py-1.5"
          data-testid="backup-update-btn"
        >
          {m.cloud_backup_btn_update()}
        </button>
        <button
          type="button"
          onclick={openRecover}
          class="bg-bg-input text-text-base hover:bg-bg-hover rounded-md px-3 py-2 text-xs font-medium transition-colors md:py-1.5"
          data-testid="backup-recover-btn"
        >
          {m.cloud_backup_btn_recover()}
        </button>
        <button
          type="button"
          onclick={() => (deleteDialogOpen = true)}
          disabled={busy}
          aria-busy={busy}
          class="text-destructive bg-destructive/10 hover:bg-destructive/20 rounded-md px-3 py-2 text-xs font-medium transition-colors disabled:opacity-50 md:py-1.5"
          data-testid="backup-delete-btn"
        >
          {m.cloud_backup_btn_delete()}
        </button>
      </div>
    {:else}
      <p class="text-text-muted text-xs">{m.cloud_backup_no_backup()}</p>
      <button
        type="button"
        onclick={openSetup}
        class="accent-gradient self-start rounded-md px-3 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 md:py-1.5"
        data-testid="backup-setup-btn"
      >
        {m.cloud_backup_btn_setup()}
      </button>
    {/if}

  {:else if viewState === 'setup'}
    <CloudBackupSetupForm
      onSubmit={handleSetup}
      onCancel={cancelFlow}
      {busy}
      error={errorMsg}
    />

  {:else if viewState === 'recover'}
    <CloudBackupRecoverForm
      onSubmit={handleRecover}
      onCancel={cancelFlow}
      {busy}
      error={errorMsg}
      warnOverwrite={hasLocalKeypair}
    />
  {/if}
</section>

<!-- Delete-Bestätigungs-Dialog -->
<AlertDialog.Root bind:open={deleteDialogOpen}>
  <AlertDialog.Content data-testid="backup-delete-dialog">
    <AlertDialog.Header>
      <AlertDialog.Title>{m.cloud_backup_dialog_delete_title()}</AlertDialog.Title>
      <AlertDialog.Description>
        {m.cloud_backup_dialog_delete_desc()}
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel>{m.cloud_backup_dialog_cancel()}</AlertDialog.Cancel>
      <Button variant="destructive" onclick={handleDelete} data-testid="backup-delete-confirm">
        {m.cloud_backup_btn_delete()}
      </Button>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
