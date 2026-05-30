<script lang="ts">
  /**
   * BackupSetupStep — Onboarding-Dialog nach erstem Login (Block 2.D).
   *
   * Zeigt sich einmalig wenn: kein Backup vorhanden + User noch nicht
   * entschieden. Zwei Wege: "Backup einrichten" → CloudBackupSetupForm
   * inline, "Skippen" → schreibt Flag + schließt.
   */
  import { toast } from 'svelte-sonner';
  import ShieldIcon from '@lucide/svelte/icons/shield';
  import { onboardingState } from '$lib/stores/onboardingState.svelte';
  import { certStore } from '$lib/identity/cert.svelte';
  import { loadKeypair } from '$lib/identity/keypair.svelte';
  import { keyBackupState } from '$lib/identity/key-backup.svelte';
  import { createBackup } from '$lib/api/credentials';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import CloudBackupSetupForm from '$lib/components/settings/CloudBackupSetupForm.svelte';
  import { m } from '$lib/paraglide/messages.js';

  type Step = 'prompt' | 'setup';

  let step = $state<Step>('prompt');
  let busy = $state(false);
  let errorMsg = $state<string | null>(null);

  const open = $derived(onboardingState.showBackupStep);

  async function skip() {
    await onboardingState.markDecided('skipped');
    if (onboardingState.syncFailed) {
      toast.warning(m.backup_setup_step_decision_local_only(), {
        description: m.backup_setup_step_decision_local_only_desc()
      });
    }
  }

  function startSetup() {
    step = 'setup';
    errorMsg = null;
  }

  function handleOpenChange(v: boolean) {
    if (!v) void skip();
  }

  async function handleSetup(password: string) {
    const certId = certStore.cert?.claims.cert_id;
    if (!certId) { errorMsg = m.backup_setup_step_error_no_cert(); return; }
    errorMsg = null;
    busy = true;
    try {
      const keypair = await loadKeypair();
      if (!keypair) { errorMsg = m.backup_setup_step_error_no_keypair(); return; }
      if (!keypair.privateKey.extractable) {
        errorMsg = m.backup_setup_step_error_keypair_not_exportable();
        return;
      }
      const [privJwk, pubJwk] = await Promise.all([
        crypto.subtle.exportKey('jwk', keypair.privateKey),
        crypto.subtle.exportKey('jwk', keypair.publicKey),
      ]);
      const blob = await keyBackupState.encrypt(privJwk, pubJwk, password);
      const label = certStore.cert?.claims.device_label ?? 'Onboarding';
      await createBackup(certId, blob, label.slice(0, 64) || 'Backup');
      toast.success(m.backup_setup_step_backup_saved(), {
        description: m.backup_setup_step_backup_saved_desc()
      });
      await onboardingState.markDecided('configured');
      if (onboardingState.syncFailed) {
        toast.warning(m.backup_setup_step_decision_local_only(), {
          description: m.backup_setup_step_decision_local_only_desc()
        });
      }
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : m.backup_setup_step_error_unknown();
    } finally {
      busy = false;
    }
  }

  function cancelSetup() {
    step = 'prompt';
    errorMsg = null;
  }
</script>

<Dialog.Root {open} onOpenChange={handleOpenChange}>
  <Dialog.Content showCloseButton={false} data-testid="backup-onboarding-dialog">
    <Dialog.Header>
      <div class="flex items-center gap-2">
        <ShieldIcon class="text-primary size-5 shrink-0" />
        <Dialog.Title>
          {step === 'prompt' ? m.backup_setup_step_title_prompt() : m.backup_setup_step_title_setup()}
        </Dialog.Title>
      </div>
      {#if step === 'prompt'}
        <Dialog.Description>
          {m.backup_setup_step_description()}
        </Dialog.Description>
      {/if}
    </Dialog.Header>

    {#if step === 'prompt'}
      <Dialog.Footer class="flex flex-col gap-2 sm:flex-row">
        <button
          type="button"
          onclick={startSetup}
          class="accent-gradient flex-1 rounded-md px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
          data-testid="backup-onboarding-setup-btn"
        >
          {m.backup_setup_step_btn_setup()}
        </button>
        <button
          type="button"
          onclick={skip}
          class="bg-bg-input text-text-base hover:bg-bg-hover flex-1 rounded-md px-4 py-2 text-sm font-medium transition-colors"
          data-testid="backup-onboarding-skip-btn"
        >
          {m.backup_setup_step_btn_skip()}
        </button>
      </Dialog.Footer>
    {:else}
      <CloudBackupSetupForm
        onSubmit={handleSetup}
        onCancel={cancelSetup}
        {busy}
        error={errorMsg}
      />
    {/if}
  </Dialog.Content>
</Dialog.Root>
