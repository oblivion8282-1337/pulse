<script lang="ts">
  /**
   * CloudBackupSetupForm — Master-Passwort 2× eingeben, Strength-Hint, Show/Hide.
   * Props: onSubmit(password) → Promise<void>, onCancel, busy.
   */
  import EyeIcon from '@lucide/svelte/icons/eye';
  import EyeOffIcon from '@lucide/svelte/icons/eye-off';
  import LoaderIcon from '@lucide/svelte/icons/loader-circle';
  import { keyBackupState } from '$lib/identity/key-backup.svelte';

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
    <label for="backup-pw" class="text-text-muted text-xs font-medium">Master-Passwort</label>
    <div class="relative">
      <input
        id="backup-pw"
        type={showPassword ? 'text' : 'password'}
        bind:value={password}
        placeholder="Mindestens 12 Zeichen"
        class="border-border bg-bg-input text-text-base placeholder:text-text-muted w-full rounded-lg border px-3 py-2 pr-10 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50"
        data-testid="backup-password-input"
      />
      <button
        type="button"
        onclick={() => (showPassword = !showPassword)}
        class="text-text-muted hover:text-text-base absolute right-3 top-1/2 -translate-y-1/2"
        aria-label={showPassword ? 'Passwort verbergen' : 'Passwort anzeigen'}
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
        {passwordStrong ? 'Stark genug' : `Noch ${12 - password.length} Zeichen nötig`}
      </span>
    {/if}
  </div>

  <div class="flex flex-col gap-1">
    <label for="backup-pw-confirm" class="text-text-muted text-xs font-medium">
      Passwort bestätigen
    </label>
    <div class="relative">
      <input
        id="backup-pw-confirm"
        type={showConfirm ? 'text' : 'password'}
        bind:value={passwordConfirm}
        placeholder="Nochmal eingeben"
        class="border-border bg-bg-input text-text-base placeholder:text-text-muted w-full rounded-lg border px-3 py-2 pr-10 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50"
        data-testid="backup-password-confirm-input"
      />
      <button
        type="button"
        onclick={() => (showConfirm = !showConfirm)}
        class="text-text-muted hover:text-text-base absolute right-3 top-1/2 -translate-y-1/2"
        aria-label={showConfirm ? 'Passwort verbergen' : 'Passwort anzeigen'}
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
        {passwordsMatch ? 'Stimmt überein' : 'Passwörter stimmen nicht überein'}
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
        <LoaderIcon class="mr-1 inline size-4 animate-spin" />Wird verschlüsselt…
      {:else}
        Backup speichern
      {/if}
    </button>
    <button
      type="button"
      onclick={handleCancel}
      disabled={busy}
      class="bg-bg-input text-text-base hover:bg-bg-hover rounded-md px-3 py-2 text-sm font-medium transition-colors disabled:opacity-50 md:py-1.5"
    >
      Abbrechen
    </button>
  </div>
</div>
