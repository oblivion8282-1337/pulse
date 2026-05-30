<script lang="ts">
  /**
   * Second step of the login flow when the account has a second factor.
   * Generalised over `methods` (a subset of totp / webauthn):
   *  - webauthn → a "confirm with passkey" button
   *  - totp     → the 6-digit / backup-code input block
   *  - both     → passkey button, an "or" divider, then the code block
   *
   * The parent owns the `mfa_ticket` + the "completeLogin" hop; this component
   * just collects input and calls `onTotp` / `onPasskey`. TOTP auto-submits
   * once the 6-digit field is full.
   */
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import * as Alert from '$lib/components/ui/alert/index.js';
  import OctagonXIcon from '@lucide/svelte/icons/octagon-x';
  import FingerprintIcon from '@lucide/svelte/icons/fingerprint';
  import { formatTotpDisplay, stripTotpFormatting, normalizeBackupCode } from '$lib/auth/format';
  import { isElectron } from '$lib/platform/runtime';
  import type { MfaMethod } from '$lib/api/auth';
  import { m } from '$lib/paraglide/messages.js';

  type TotpArgs = { code?: string; backup_code?: string };
  type Props = {
    methods: MfaMethod[];
    busy: boolean;
    error: string | null;
    onTotp: (args: TotpArgs) => Promise<void> | void;
    onPasskey: () => Promise<void> | void;
    onCancel: () => void;
  };

  let { methods, busy, error, onTotp, onPasskey, onCancel }: Props = $props();

  const hasPasskey = $derived(methods.includes('webauthn'));
  const hasTotp = $derived(methods.includes('totp'));

  // In the desktop shell a browser-stored passkey is unreachable (Electron's
  // Chromium is a separate credential store, no Linux platform authenticator),
  // so the passkey button is hidden there and the user falls back to codes.
  // A passkey-only account still has backup codes (minted at passkey
  // enrollment), so offer the code block even without TOTP in that case.
  const inDesktop = isElectron();
  const showPasskey = $derived(hasPasskey && !inDesktop);
  const showCodes = $derived(hasTotp || (inDesktop && hasPasskey));
  // No TOTP to type → the only valid code is a backup code; force that mode
  // and hide the (pointless) toggle.
  const backupOnly = $derived(showCodes && !hasTotp);

  let useBackupCode = $state(false);
  let totpInputRaw = $state('');
  let backupCode = $state('');

  async function submitTotp(e?: Event) {
    e?.preventDefault();
    if (busy || !showCodes) return;
    if (useBackupCode || backupOnly) {
      const normalized = normalizeBackupCode(backupCode);
      if (!normalized) return;
      await onTotp({ backup_code: normalized });
    } else {
      const code = stripTotpFormatting(totpInputRaw);
      if (code.length !== 6) return;
      await onTotp({ code });
    }
  }

  function onTotpInput(e: Event) {
    const digits = stripTotpFormatting((e.currentTarget as HTMLInputElement).value).slice(0, 6);
    totpInputRaw = formatTotpDisplay(digits);
    if (digits.length === 6 && !busy) void submitTotp();
  }

  function toggleBackupCode() {
    useBackupCode = !useBackupCode;
    totpInputRaw = '';
    backupCode = '';
  }
</script>

<form
  class="bg-card w-full max-w-md space-y-4 rounded-xl p-8 shadow-2xl"
  onsubmit={submitTotp}
  aria-label="mfa form"
>
  <header class="space-y-2 text-center">
    <img src="/pulse-mark.svg" alt="Pulse" width="56" height="56" class="mx-auto size-14" />
    <h1 class="text-card-foreground text-2xl font-semibold">{m.login_mfa_title()}</h1>
    <p class="text-muted-foreground text-sm">
      {#if showPasskey && showCodes}
        {m.login_mfa_hint_passkey_or_code()}
      {:else if showPasskey}
        {m.login_mfa_hint_passkey_only()}
      {:else if useBackupCode || backupOnly}
        {m.login_mfa_hint_backup_code()}
      {:else}
        {m.login_mfa_hint_totp()}
      {/if}
    </p>
  </header>

  {#if showPasskey}
    <Button
      type="button"
      variant="secondary"
      class="w-full gap-2"
      disabled={busy}
      onclick={onPasskey}
      data-testid="login-passkey-mfa"
    >
      <FingerprintIcon class="size-4" />
      {m.login_mfa_confirm_with_passkey()}
    </Button>
  {/if}

  {#if showPasskey && showCodes}
    <div class="text-muted-foreground flex items-center gap-3 text-xs">
      <span class="bg-border h-px flex-1"></span>
      {m.login_mfa_or_enter_code()}
      <span class="bg-border h-px flex-1"></span>
    </div>
  {/if}

  {#if showCodes}
    {#if useBackupCode || backupOnly}
      <div class="space-y-1.5">
        <Label
          for="login-backup-code"
          class="text-muted-foreground text-xs font-semibold uppercase tracking-wide"
        >
          {m.login_mfa_label_backup_code()}
        </Label>
        <Input
          id="login-backup-code"
          type="text"
          autocomplete="one-time-code"
          autocapitalize="characters"
          spellcheck={false}
          bind:value={backupCode}
          data-testid="login-backup-code"
        />
      </div>
    {:else}
      <div class="space-y-1.5">
        <Label
          for="login-totp-code"
          class="text-muted-foreground text-xs font-semibold uppercase tracking-wide"
        >
          {m.login_mfa_label_code()}
        </Label>
        <Input
          id="login-totp-code"
          type="text"
          inputmode="numeric"
          autocomplete="one-time-code"
          value={totpInputRaw}
          oninput={onTotpInput}
          data-testid="login-totp-code"
          class="text-center font-mono text-lg tracking-[0.3em]"
          maxlength={7}
        />
      </div>
    {/if}
  {/if}

  {#if error}
    <Alert.Root variant="destructive" data-testid="login-error">
      <OctagonXIcon />
      <Alert.Description>{error}</Alert.Description>
    </Alert.Root>
  {/if}

  {#if showCodes}
    <Button type="submit" class="w-full" disabled={busy} data-testid="login-totp-submit">
      {busy ? m.login_mfa_verifying() : m.login_mfa_confirm()}
    </Button>
  {/if}

  <div class="flex items-center justify-between text-sm">
    {#if showCodes && hasTotp}
      <button
        type="button"
        class="text-primary hover:underline"
        onclick={toggleBackupCode}
        data-testid="login-toggle-backup"
      >
        {useBackupCode ? m.login_mfa_use_totp_code() : m.login_mfa_use_backup_code()}
      </button>
    {:else}
      <span></span>
    {/if}
    <button
      type="button"
      class="text-muted-foreground hover:underline"
      onclick={onCancel}
      data-testid="login-totp-cancel"
    >
      {m.login_mfa_cancel()}
    </button>
  </div>
</form>
