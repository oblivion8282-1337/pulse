<script lang="ts">
  /**
   * CloudBackupRecoverForm — Master-Passwort 1× eingeben, Show/Hide, Submit/Cancel.
   * Zeigt optionalen Overwrite-Warn-Text wenn warnOverwrite=true.
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
    warnOverwrite?: boolean;
  }

  const { onSubmit, onCancel, busy, error = null, warnOverwrite = false }: Props = $props();

  let password = $state('');
  let showPassword = $state(false);

  async function handleSubmit() {
    if (busy || password.length === 0) return;
    await onSubmit(password);
    password = '';
  }

  function handleCancel() {
    password = '';
    onCancel();
  }
</script>

<div class="flex flex-col gap-3">
  <p class="text-text-muted text-xs">
    Gib dein Master-Passwort ein, um die Schlüssel aus dem Backup wiederherzustellen.
  </p>

  {#if warnOverwrite}
    <p class="text-amber-500 text-xs" role="note" data-testid="recover-overwrite-warn">
      Dein aktuelles Keypair wird ersetzt.
    </p>
  {/if}

  <div class="flex flex-col gap-1">
    <label for="recover-pw" class="text-text-muted text-xs font-medium">Master-Passwort</label>
    <div class="relative">
      <input
        id="recover-pw"
        type={showPassword ? 'text' : 'password'}
        bind:value={password}
        placeholder="Master-Passwort eingeben"
        class="border-border bg-bg-input text-text-base placeholder:text-text-muted w-full rounded-lg border px-3 py-2 pr-10 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50"
        data-testid="recover-password-input"
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
  </div>

  {#if error}
    <p class="text-destructive text-xs" role="alert" data-testid="recover-error">{error}</p>
  {/if}

  <div class="flex gap-2">
    <button
      type="button"
      onclick={handleSubmit}
      disabled={busy || password.length === 0}
      aria-busy={busy || keyBackupState.decrypting}
      class="accent-gradient rounded-md px-3 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50 md:py-1.5"
      data-testid="recover-confirm-btn"
    >
      {#if busy || keyBackupState.decrypting}
        <LoaderIcon class="mr-1 inline size-4 animate-spin" />Wird entschlüsselt…
      {:else}
        Schlüssel wiederherstellen
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
