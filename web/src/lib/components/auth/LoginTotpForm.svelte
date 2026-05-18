<script lang="ts">
  /**
   * Second step of the login flow when the account has TOTP enabled. The
   * parent owns the `mfa_ticket` + the eventual "completeLogin" hop — we
   * just drive the input and call `submit` with whichever code variant the
   * user picked.
   *
   * Auto-submit fires when the 6-digit code field reaches 6 characters.
   */
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import * as Alert from '$lib/components/ui/alert/index.js';
  import OctagonXIcon from '@lucide/svelte/icons/octagon-x';
  import { formatTotpDisplay, stripTotpFormatting, normalizeBackupCode } from '$lib/auth/format';

  type SubmitArgs = { code?: string; backup_code?: string };
  type Props = {
    busy: boolean;
    error: string | null;
    onSubmit: (args: SubmitArgs) => Promise<void> | void;
    onCancel: () => void;
  };

  let { busy, error, onSubmit, onCancel }: Props = $props();

  let useBackupCode = $state(false);
  let totpInputRaw = $state('');
  let backupCode = $state('');

  async function doSubmit(e?: Event) {
    e?.preventDefault();
    if (busy) return;
    if (useBackupCode) {
      const normalized = normalizeBackupCode(backupCode);
      if (!normalized) return;
      await onSubmit({ backup_code: normalized });
    } else {
      const code = stripTotpFormatting(totpInputRaw);
      if (code.length !== 6) return;
      await onSubmit({ code });
    }
  }

  function onTotpInput(e: Event) {
    const v = (e.currentTarget as HTMLInputElement).value;
    const digits = stripTotpFormatting(v).slice(0, 6);
    totpInputRaw = formatTotpDisplay(digits);
    if (digits.length === 6 && !busy) void doSubmit();
  }

  function toggleBackupCode() {
    useBackupCode = !useBackupCode;
    totpInputRaw = '';
    backupCode = '';
  }
</script>

<form
  class="bg-card w-full max-w-md space-y-4 rounded-xl p-8 shadow-2xl"
  onsubmit={doSubmit}
  aria-label="totp form"
>
  <header class="space-y-2 text-center">
    <img src="/pulse-mark.svg" alt="Pulse" width="56" height="56" class="mx-auto size-14" />
    <h1 class="text-card-foreground text-2xl font-semibold">Zwei-Faktor-Authentifizierung</h1>
    <p class="text-muted-foreground text-sm">
      {useBackupCode
        ? 'Gib einen deiner Backup-Codes ein.'
        : 'Öffne deine Authenticator-App und gib den 6-stelligen Code ein.'}
    </p>
  </header>

  {#if useBackupCode}
    <div class="space-y-1.5">
      <Label
        for="login-backup-code"
        class="text-muted-foreground text-xs font-semibold uppercase tracking-wide"
      >
        Backup-Code
      </Label>
      <Input
        id="login-backup-code"
        type="text"
        autocomplete="one-time-code"
        autocapitalize="characters"
        spellcheck={false}
        bind:value={backupCode}
        required
        data-testid="login-backup-code"
      />
    </div>
  {:else}
    <div class="space-y-1.5">
      <Label
        for="login-totp-code"
        class="text-muted-foreground text-xs font-semibold uppercase tracking-wide"
      >
        Code
      </Label>
      <Input
        id="login-totp-code"
        type="text"
        inputmode="numeric"
        autocomplete="one-time-code"
        value={totpInputRaw}
        oninput={onTotpInput}
        required
        data-testid="login-totp-code"
        class="text-center font-mono text-lg tracking-[0.3em]"
        maxlength={7}
      />
    </div>
  {/if}

  {#if error}
    <Alert.Root variant="destructive" data-testid="login-error">
      <OctagonXIcon />
      <Alert.Description>{error}</Alert.Description>
    </Alert.Root>
  {/if}

  <Button type="submit" class="w-full" disabled={busy} data-testid="login-totp-submit">
    {busy ? 'Prüfen…' : 'Bestätigen'}
  </Button>

  <div class="flex items-center justify-between text-sm">
    <button
      type="button"
      class="text-primary hover:underline"
      onclick={toggleBackupCode}
      data-testid="login-toggle-backup"
    >
      {useBackupCode ? '6-stelligen Code verwenden' : 'Backup-Code verwenden'}
    </button>
    <button
      type="button"
      class="text-muted-foreground hover:underline"
      onclick={onCancel}
      data-testid="login-totp-cancel"
    >
      Abbrechen
    </button>
  </div>
</form>
