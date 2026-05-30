<script lang="ts">
  /**
   * CloudBackupSetupForm — Master-Passwort 2× eingeben, Strength-Hint, Show/Hide.
   * Props: onSubmit(password) → Promise<void>, onCancel, busy.
   */
  import EyeIcon from '@lucide/svelte/icons/eye';
  import EyeOffIcon from '@lucide/svelte/icons/eye-off';
  import LoaderIcon from '@lucide/svelte/icons/loader-circle';
  import { keyBackupState } from '$lib/identity/key-backup.svelte';
  import { m } from '$lib/paraglide/messages.js';

  interface Props {
    onSubmit: (password: string) => Promise<void>;
    onCancel: () => void;
    busy: boolean;
    error?: string | null;
  }

  const { onSubmit, onCancel, busy, error = null }: Props = $props();

  let password = $state('');
  let passwordConfirm = $state('');
  let showPassword = $state(false);
  let showConfirm = $state(false);

  const passwordStrong = $derived(password.length >= 12);
  const passwordsMatch = $derived(password === passwordConfirm);
  const canSubmit = $derived(passwordStrong && passwordsMatch && !busy);

  async function handleSubmit() {
    if (!canSubmit) return;
    await onSubmit(password);
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
  <div class="flex flex-col gap-1">
    <label for="backup-pw" class="text-text-muted text-xs font-medium">{m.cloud_backup_setup_form_master_password_label()}</label>
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
        aria-label={showPassword ? m.cloud_backup_setup_form_hide_password() : m.cloud_backup_setup_form_show_password()}
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
        {passwordStrong ? m.cloud_backup_setup_form_password_strong() : m.cloud_backup_setup_form_password_chars_needed({ count: 12 - password.length })}
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
        aria-label={showConfirm ? m.cloud_backup_setup_form_hide_password() : m.cloud_backup_setup_form_show_password()}
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
        {passwordsMatch ? m.cloud_backup_setup_form_passwords_match() : m.cloud_backup_setup_form_passwords_mismatch()}
      </span>
    {/if}
  </div>

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
