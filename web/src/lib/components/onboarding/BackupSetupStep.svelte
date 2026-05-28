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

  type Step = 'prompt' | 'setup';

  let step = $state<Step>('prompt');
  let busy = $state(false);
  let errorMsg = $state<string | null>(null);

  const open = $derived(onboardingState.showBackupStep);

  async function skip() {
    await onboardingState.markDecided('skipped');
    if (onboardingState.syncFailed) {
      toast.warning('Entscheidung nur lokal gespeichert', {
        description: 'Backup-Einstellung konnte nicht synchronisiert werden — wirkt nur auf diesem Gerät.'
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
    if (!certId) { errorMsg = 'Kein aktives Cert — bitte neu anmelden.'; return; }
    errorMsg = null;
    busy = true;
    try {
      const keypair = await loadKeypair();
      if (!keypair) { errorMsg = 'Kein lokales Keypair gefunden.'; return; }
      if (!keypair.privateKey.extractable) {
        errorMsg = 'Keypair nicht exportierbar — bitte neu anmelden.';
        return;
      }
      const [privJwk, pubJwk] = await Promise.all([
        crypto.subtle.exportKey('jwk', keypair.privateKey),
        crypto.subtle.exportKey('jwk', keypair.publicKey),
      ]);
      const blob = await keyBackupState.encrypt(privJwk, pubJwk, password);
      const label = certStore.cert?.claims.device_label ?? 'Onboarding';
      await createBackup(certId, blob, label.slice(0, 64) || 'Backup');
      toast.success('Backup gespeichert', {
        description: 'Dein Keypair ist nun verschlüsselt in der Cloud gesichert.'
      });
      await onboardingState.markDecided('configured');
      if (onboardingState.syncFailed) {
        toast.warning('Entscheidung nur lokal gespeichert', {
          description: 'Backup-Einstellung konnte nicht synchronisiert werden — wirkt nur auf diesem Gerät.'
        });
      }
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : 'Unbekannter Fehler.';
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
          {step === 'prompt' ? 'Backup für deine Geräte-Schlüssel?' : 'Backup einrichten'}
        </Dialog.Title>
      </div>
      {#if step === 'prompt'}
        <Dialog.Description>
          Wenn du dein Gerät verlierst, verlierst du den Zugang zu deinem Konto. Ein
          Cloud-Backup schützt davor — verschlüsselt mit einem Master-Passwort, das
          nur du kennst.
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
          Backup einrichten
        </button>
        <button
          type="button"
          onclick={skip}
          class="bg-bg-input text-text-base hover:bg-bg-hover flex-1 rounded-md px-4 py-2 text-sm font-medium transition-colors"
          data-testid="backup-onboarding-skip-btn"
        >
          Später, jetzt skippen
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
