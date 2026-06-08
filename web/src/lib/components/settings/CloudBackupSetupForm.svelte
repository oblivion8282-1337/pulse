<script lang="ts">
  /**
   * CloudBackupSetupForm — Master-Passwort für das E2E-Backup festlegen.
   *
   * Zwei Modi:
   *  - `generate` (Default, empfohlen): ein starker Wiederherstellungs-Schlüssel
   *    wird erzeugt; der Submit ist erst frei, wenn der User ihn nachweislich
   *    kopiert/gespeichert hat (siehe CloudBackupGeneratedKey).
   *  - `own`: selbstgewähltes Passwort, 2× eingeben, min. 12 Zeichen.
   *
   * Nach außen bleibt die Schnittstelle gleich: `onSubmit(secret)` bekommt in
   * beiden Fällen einen String, der als Master-Passwort abgeleitet wird.
   */
  import EyeIcon from '@lucide/svelte/icons/eye';
  import EyeOffIcon from '@lucide/svelte/icons/eye-off';
  import LoaderIcon from '@lucide/svelte/icons/loader-circle';
  import { keyBackupState } from '$lib/identity/key-backup.svelte';
  import { m } from '$lib/paraglide/messages.js';
  import CloudBackupGeneratedKey from './CloudBackupGeneratedKey.svelte';

  interface Props {
    onSubmit: (password: string) => Promise<void>;
    onCancel: () => void;
    busy: boolean;
    error?: string | null;
  }

  const { onSubmit, onCancel, busy, error = null }: Props = $props();

  let mode = $state<'generate' | 'own'>('generate');
  let password = $state('');
  let passwordConfirm = $state('');
  let generatedKey = $state('');
  let keySaved = $state(false);
  let showPassword = $state(false);
  let showConfirm = $state(false);

  const passwordStrong = $derived(password.length >= 12);
  const passwordsMatch = $derived(password === passwordConfirm);
  const ownReady = $derived(passwordStrong && passwordsMatch);
  const generateReady = $derived(generatedKey.length > 0 && keySaved);
  const canSubmit = $derived((mode === 'own' ? ownReady : generateReady) && !busy);

  async function handleSubmit() {
    if (!canSubmit) return;
    const secret = mode === 'generate' ? generatedKey : password;
    await onSubmit(secret);
    password = '';
    passwordConfirm = '';
  }

  function handleCancel() {
    password = '';
    passwordConfirm = '';
    onCancel();
  }
</script>

<div class="flex flex-col gap-3">
  <!-- Modus-Umschalter -->
  <div class="border-border bg-bg-input/60 flex gap-1 rounded-lg border p-1 text-xs font-medium">
    <button
      type="button"
      onclick={() => (mode = 'generate')}
      class="flex-1 rounded-md px-2 py-1.5 transition-colors {mode === 'generate'
        ? 'bg-bg-hover text-text-bright'
        : 'text-text-muted hover:text-text-base'}"
      data-testid="backup-mode-generate"
    >
      {m.cloud_backup_setup_form_mode_generate()}
    </button>
    <button
      type="button"
      onclick={() => (mode = 'own')}
      class="flex-1 rounded-md px-2 py-1.5 transition-colors {mode === 'own'
        ? 'bg-bg-hover text-text-bright'
        : 'text-text-muted hover:text-text-base'}"
      data-testid="backup-mode-own"
    >
      {m.cloud_backup_setup_form_mode_own()}
    </button>
  </div>

  {#if mode === 'generate'}
    <CloudBackupGeneratedKey bind:value={generatedKey} bind:saved={keySaved} />
  {:else}
    <div class="flex flex-col gap-1">
      <label for="backup-pw" class="text-text-muted text-xs font-medium"
        >{m.cloud_backup_setup_form_master_password_label()}</label
      >
      <div class="relative">
        <input
          id="backup-pw"
          type={showPassword ? 'text' : 'password'}
          bind:value={password}
          placeholder={m.cloud_backup_setup_form_password_placeholder()}
          class="border-border bg-bg-input text-text-base placeholder:text-text-muted w-full rounded-lg border px-3 py-2 pr-10 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50"
          data-testid="backup-password-input"
        />
        <button
          type="button"
          onclick={() => (showPassword = !showPassword)}
          class="text-text-muted hover:text-text-base absolute right-3 top-1/2 -translate-y-1/2"
          aria-label={showPassword
            ? m.cloud_backup_setup_form_hide_password()
            : m.cloud_backup_setup_form_show_password()}
        >
          {#if showPassword}
            <EyeOffIcon class="size-4" />
          {:else}
            <EyeIcon class="size-4" />
          {/if}
        </button>
      </div>
      {#if password.length > 0}
        <span class="text-xs {passwordStrong ? 'text-emerald-500' : 'text-amber-500'}">
          {passwordStrong
            ? m.cloud_backup_setup_form_password_strong()
            : m.cloud_backup_setup_form_password_chars_needed({ count: 12 - password.length })}
        </span>
      {/if}
    </div>

    <div class="flex flex-col gap-1">
      <label for="backup-pw-confirm" class="text-text-muted text-xs font-medium">
        {m.cloud_backup_setup_form_confirm_password_label()}
      </label>
      <div class="relative">
        <input
          id="backup-pw-confirm"
          type={showConfirm ? 'text' : 'password'}
          bind:value={passwordConfirm}
          placeholder={m.cloud_backup_setup_form_confirm_placeholder()}
          class="border-border bg-bg-input text-text-base placeholder:text-text-muted w-full rounded-lg border px-3 py-2 pr-10 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50"
          data-testid="backup-password-confirm-input"
        />
        <button
          type="button"
          onclick={() => (showConfirm = !showConfirm)}
          class="text-text-muted hover:text-text-base absolute right-3 top-1/2 -translate-y-1/2"
          aria-label={showConfirm
            ? m.cloud_backup_setup_form_hide_password()
            : m.cloud_backup_setup_form_show_password()}
        >
          {#if showConfirm}
            <EyeOffIcon class="size-4" />
          {:else}
            <EyeIcon class="size-4" />
          {/if}
        </button>
      </div>
      {#if passwordConfirm.length > 0}
        <span class="text-xs {passwordsMatch ? 'text-emerald-500' : 'text-destructive'}">
          {passwordsMatch
            ? m.cloud_backup_setup_form_passwords_match()
            : m.cloud_backup_setup_form_passwords_mismatch()}
        </span>
      {/if}
    </div>
  {/if}

  {#if error}
    <p class="text-destructive text-xs" role="alert" data-testid="backup-error">{error}</p>
  {/if}

  <div class="flex gap-2">
    <button
      type="button"
      onclick={handleSubmit}
      disabled={!canSubmit}
      aria-busy={busy || keyBackupState.encrypting}
      class="accent-gradient rounded-md px-3 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50 md:py-1.5"
      data-testid="backup-confirm-btn"
    >
      {#if busy || keyBackupState.encrypting}
        <LoaderIcon class="mr-1 inline size-4 animate-spin" />{m.cloud_backup_setup_form_encrypting()}
      {:else}
        {m.cloud_backup_setup_form_save_backup()}
      {/if}
    </button>
    <button
      type="button"
      onclick={handleCancel}
      disabled={busy}
      class="bg-bg-input text-text-base hover:bg-bg-hover rounded-md px-3 py-2 text-sm font-medium transition-colors disabled:opacity-50 md:py-1.5"
    >
      {m.cloud_backup_setup_form_cancel()}
    </button>
  </div>
</div>
