<script lang="ts">
  /**
   * 2FA enable wizard. Three steps:
   *   1. fetch the secret + QR (POST /totp/setup) and let the user scan it
   *   2. user types the rotating 6-digit code → POST /totp/verify-setup
   *   3. show the backup codes, gated behind a confirmation checkbox
   *
   * Closing the dialog mid-flow is allowed but the secret is *server-side*
   * pending until verify-setup succeeds, so re-opening starts step 1 fresh.
   */
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import * as Alert from '$lib/components/ui/alert/index.js';
  import OctagonXIcon from '@lucide/svelte/icons/octagon-x';
  import { totpSetup, totpVerifySetup, type TotpSetup } from '$lib/api/auth';
  import { auth } from '$lib/stores/auth.svelte';
  import { stripTotpFormatting, formatTotpDisplay } from '$lib/auth/format';
  import BackupCodesView from './BackupCodesView.svelte';

  let { open = $bindable(false) }: { open?: boolean } = $props();

  type Step = 'qr' | 'verify' | 'codes';
  let step = $state<Step>('qr');
  let busy = $state(false);
  let error = $state<string | null>(null);
  let setupData = $state<TotpSetup | null>(null);
  let codeRaw = $state('');
  let backupCodes = $state<string[]>([]);
  let saved = $state(false);

  $effect(() => {
    if (open) {
      void start();
    } else {
      // Reset on close so next open starts fresh.
      step = 'qr';
      busy = false;
      error = null;
      setupData = null;
      codeRaw = '';
      backupCodes = [];
      saved = false;
    }
  });

  async function start() {
    busy = true;
    error = null;
    try {
      setupData = await totpSetup();
      step = 'qr';
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }

  async function verify(e?: Event) {
    e?.preventDefault();
    if (busy) return;
    const digits = stripTotpFormatting(codeRaw);
    if (digits.length !== 6) {
      error = 'Bitte 6-stelligen Code eingeben.';
      return;
    }
    busy = true;
    error = null;
    try {
      const res = await totpVerifySetup(digits);
      backupCodes = res.backup_codes;
      step = 'codes';
      if (auth.user) auth.setUser({ ...auth.user, totp_enabled: true });
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }

  function onCodeInput(e: Event) {
    const digits = stripTotpFormatting((e.currentTarget as HTMLInputElement).value).slice(0, 6);
    codeRaw = formatTotpDisplay(digits);
    if (digits.length === 6) void verify();
  }

  function close() {
    open = false;
  }

  function goToVerify() {
    step = 'verify';
    error = null;
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Portal>
    <Dialog.Overlay />
    <Dialog.Content data-testid="totp-enable-dialog" class="max-w-md">
      <Dialog.Header>
        <Dialog.Title>2FA aktivieren</Dialog.Title>
        <Dialog.Description>
          {#if step === 'qr'}
            Scanne den QR-Code mit deiner Authenticator-App (z. B. Authy, Google Authenticator, 1Password).
          {:else if step === 'verify'}
            Gib den 6-stelligen Code aus der App ein.
          {:else}
            Speichere diese Backup-Codes — du brauchst sie, falls du dein Handy verlierst.
          {/if}
        </Dialog.Description>
      </Dialog.Header>

      {#if error}
        <Alert.Root variant="destructive" data-testid="totp-enable-error">
          <OctagonXIcon />
          <Alert.Description>{error}</Alert.Description>
        </Alert.Root>
      {/if}

      {#if step === 'qr'}
        {#if setupData}
          <div class="flex flex-col items-center gap-3 py-2">
            <img
              src="data:image/png;base64,{setupData.qr_png_base64}"
              alt="QR-Code für die Authenticator-App"
              width="200"
              height="200"
              class="border-border rounded-lg border bg-white p-2"
              data-testid="totp-qr"
            />
            <div class="flex flex-col gap-1 text-center">
              <span class="text-text-muted text-xs">Geht's nicht? Gib das Secret manuell ein:</span>
              <code
                class="bg-bg-input text-text-bright select-all rounded px-2 py-1 font-mono text-xs"
                data-testid="totp-secret"
              >
                {setupData.secret}
              </code>
            </div>
          </div>
        {:else}
          <p class="text-text-muted text-sm">
            {busy ? 'Lade…' : 'Setup wird vorbereitet.'}
          </p>
        {/if}
        <Dialog.Footer>
          <Button variant="secondary" onclick={close} disabled={busy}>Abbrechen</Button>
          <Button onclick={goToVerify} disabled={!setupData || busy} data-testid="totp-enable-next">
            Weiter
          </Button>
        </Dialog.Footer>
      {:else if step === 'verify'}
        <form onsubmit={verify} class="space-y-3">
          <div class="space-y-1.5">
            <Label for="totp-setup-code" class="text-text-muted text-xs font-semibold uppercase">
              Code aus der App
            </Label>
            <Input
              id="totp-setup-code"
              type="text"
              inputmode="numeric"
              autocomplete="one-time-code"
              value={codeRaw}
              oninput={onCodeInput}
              required
              maxlength={7}
              class="text-center font-mono text-lg tracking-[0.3em]"
              data-testid="totp-enable-code"
            />
          </div>
          <Dialog.Footer>
            <Button
              variant="secondary"
              type="button"
              onclick={() => (step = 'qr')}
              disabled={busy}
            >
              Zurück
            </Button>
            <Button type="submit" disabled={busy} data-testid="totp-enable-verify">
              {busy ? 'Prüfen…' : 'Bestätigen'}
            </Button>
          </Dialog.Footer>
        </form>
      {:else}
        <BackupCodesView codes={backupCodes} />
        <label class="text-text-base mt-3 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            class="size-4 accent-[var(--brand)]"
            bind:checked={saved}
            data-testid="totp-enable-saved-check"
          />
          Ich habe die Codes an einem sicheren Ort gespeichert.
        </label>
        <Dialog.Footer>
          <Button onclick={close} disabled={!saved} data-testid="totp-enable-done">Fertig</Button>
        </Dialog.Footer>
      {/if}
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
